import { google } from '@ai-sdk/google';
import { streamText, convertToModelMessages, stepCountIs, embed, tool } from 'ai';
import { z } from 'zod';
import { NextRequest } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import puppeteer, { Browser } from 'puppeteer'; 

type ChatPart = { type: 'text'; text: string };
type ChatMessage = { role: 'user' | 'assistant' | 'system'; parts: ChatPart[] };

// -------- Supabase --------
const { SUPABASE_URL, SUPABASE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Missing Supabase env vars');
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
// -------- Google AI SDK --------
const embeddingModel = google.embedding('text-embedding-004');


// -------- Text chunking --------
function chunkText(text: string, size = 800, overlap = 200) {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size - overlap) {
    const piece = text.slice(i, i + size).trim();
    if (piece.length > 50) chunks.push(piece);
  }
  return chunks;
}

// -------- Crawl site (collect all internal links) --------
async function crawlSiteRecursive(browser: Browser, baseUrl: string, depth = 2, visited = new Set<string>()): Promise<string[]> {
  if (depth === 0) return [];

  const page = await browser.newPage();
  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

  const links = await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll("a"))
      .map(a => (a as HTMLAnchorElement).href)
      .filter(href => href.startsWith(window.location.origin));
    return Array.from(new Set(anchors));
  });

  await page.close();

  const newLinks: string[] = [];
  for (const link of links) {
    if (!visited.has(link)) {
      visited.add(link);
      newLinks.push(link);
      const deeper = await crawlSiteRecursive(browser, link, depth - 1, visited);
      newLinks.push(...deeper);
    }
  }

  return newLinks;
}

// -------- Scrape page content --------
async function scrapePage(browser: Browser, url: string) {
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

  const text = await page.evaluate(() => {
    document
      .querySelectorAll('script, style, noscript, svg, img')
      .forEach(el => el.remove());

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        if (!node.textContent) return NodeFilter.FILTER_REJECT;
        const trimmed = node.textContent.trim();
        return trimmed.length > 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });

    let text = '';
    while (walker.nextNode()) {
      text += walker.currentNode.textContent + ' ';
    }

    return text.replace(/\s+/g, ' ').trim();
  });

  await page.close(); 
  return chunkText(text);
}
// -------- Embedding helpers --------
async function embedText(value: string, retries = 5, delay = 2000) {
  for (let i = 0; i < retries; i++) {
    try {
      const { embedding } = await embed({ model: embeddingModel, value }); 
      return embedding;
    } catch (err: any) {
      if (err.statusCode === 429 || err.message.includes("exhausted")) {
        console.warn(`Quota hit, retrying in ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
        delay *= 2; // exponential backoff
      } else {
        throw err;
      }
    }
  }
  throw new Error("Max retries reached for embedding");
}

// -------- Ensure  page indexed --------
async function ensurePageIndexed(browser: Browser, url: string) { 
  const { count } = await supabase
    .from('documents')
    .select('id', { count: 'exact', head: true })
    .eq('url', url);

  if (count && count > 0) {
    console.log('Already indexed.');
    return;
  }

  const chunks = await scrapePage(browser, url); 
  for (const [i, chunk] of chunks.entries()) {
    const vector = await embedText(chunk);
    await supabase.from('documents').insert([
      { url, chunk_index: i, text: chunk, embedding: vector },
    ]);
  }

  console.log(`Indexed: ${url}`);
}

// -------- Index multiple pages --------
async function ensurePagesIndexed(baseUrl: string) {
  
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const urls = await crawlSiteRecursive(browser, baseUrl);
    console.log("Found pages:", urls);

    for (const url of urls) {
      try {
        await ensurePageIndexed(browser, url); 
      } catch (err) {
        console.error("Error indexing", url, err);
      }
    }
    console.log("✅ Indexing complete!");
  } finally {
    await browser.close(); // close at the very end
  }
}

// -------- Search --------
async function searchDocuments(query: string, topK = 5) {
  const queryEmb = await embedText(query);
  const { data, error } = await supabase.rpc('match_documents', {
    query_embedding: queryEmb,
    match_count: topK,
  });
  if (error) throw error;
  return (data ?? []).map((d: any) => d.text).join('\n\n');
}

// -------- API Handler --------
let indexingStarted = false;
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const body = (await req.json()) as { messages: ChatMessage[]; query?: string };
  const messages = body?.messages ?? [];

  const lastUserText =
    body?.query ??
    [...messages].reverse().find(m => m.role === 'user')?.parts
      ?.filter(p => p.type === 'text')
      ?.map(p => p.text)
      ?.join(' ') ??
    '';

  // Index only once (auto-crawls all links)
  if (!indexingStarted) {
    indexingStarted = true;
    ensurePagesIndexed('https://swarise.com/').catch(console.error);
  }

  let retrievedText = '';
  if (lastUserText) {
    try {
      retrievedText = await searchDocuments(lastUserText, 4);
    } catch (e) {
      console.error('Vector search error:', e);
    }
  }

  const result = streamText({
    model: google('gemini-2.5-flash'),
    messages: [
       {
    role: 'system',
    content: retrievedText
      ?`You are a professional content writer for a company brochure.
      Always return the retrieved webpage text **exactly as it is**, without rewriting, summarizing, or rephrasing.
Do not change words, structure, or formatting.
Do not use symbols like *, #, or -.
Each heading must be followed by a line break.
Each idea must be written as a new line, not merged into a paragraph.
Values must be numbered as 1., 2., 3., etc.
Separate each section with an empty line.

Here's some context:
${retrievedText}
 
Write the content clearly and concisely, focusing on the most important information.
Use descriptive headlines for each section.
Structure the content with a logical flow, guiding the reader smoothly through the brochure.
Present information in an engaging and easy-to-read manner.
Ensure consistent branding in the generated output,  matching the tone and style found in the provided context (if available).
Prioritize highlighting the benefits of the product or service, rather than just features.
Include a strong and clear call to action at the end.
`
      :  `You are a professional content writer for a company brochure.
      Always return the retrieved webpage text **exactly as it is**, without rewriting, summarizing, or rephrasing.
Do not change words, structure, or formatting.
Do not use symbols like *, #, or -.
Each heading must be followed by a line break.
Each idea must be written as a new line, not merged into a paragraph.
Values must be numbered as 1., 2., 3., etc.
Separate each section with an empty line.

Write the content clearly and concisely, focusing on the most important information.
Use descriptive headlines for each section.
Structure the content with a logical flow, guiding the reader smoothly through the brochure.
Present information in an engaging and easy-to-read manner.
Prioritize highlighting the benefits of the product or service, rather than just features.
Include a strong and clear call to action at the end.
`},
      ...convertToModelMessages(messages),
    ],
    stopWhen: stepCountIs(10),
    tools: {
      retrieveDocument: tool({
        description: 'Retrieve relevant documents from Supabase vector DB.',
        inputSchema: z.object({ query: z.string() }),
        execute: async ({ query }) => {
          const docs = await searchDocuments(query || lastUserText, 4);
          return { text: docs || 'No relevant documents found.' };
        },
      }),
    },
  });

  return result.toUIMessageStreamResponse();
}
