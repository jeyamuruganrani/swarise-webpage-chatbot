  import { google } from '@ai-sdk/google';
  import { streamText, convertToModelMessages, stepCountIs, embed, tool } from 'ai';
  import { z } from 'zod';
  import { NextRequest } from 'next/server';
  import { createClient } from '@supabase/supabase-js';
  import puppeteer, { Browser } from 'puppeteer'; 

  type ChatPart = { type: 'text'; text: string };
  
  type ChatMessage = { role: 'user' | 'assistant' | 'system'; parts: ChatPart[] };

  // -------- Supabase --------
  const { SUPABASE_URL, SUPABASE_KEY, GOOGLE_GENERATIVE_AI_API_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_KEY || !GOOGLE_GENERATIVE_AI_API_KEY) {
    throw new Error('Missing one or more required environment variables: SUPABASE_URL, SUPABASE_KEY, GOOGLE_API_KEY');
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  // -------- Google AI SDK --------
  const embeddingModel = google.embedding('text-embedding-004');  
  console.log("Google API Key:", process.env.GOOGLE_GENERATIVE_AI_API_KEY);


  // -------- Text chunking --------
  function chunkText(text: string, size = 800, overlap = 200) {
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += size - overlap) {
      const piece = text.slice(i, i + size).trim();
      if (piece.length > 50) chunks.push(piece);
    }
    return chunks;
  }

  // -------- Crawl site --------
  async function crawlSiteRecursive(browser: Browser, baseUrl: string, depth = 2, visited = new Set<string>()): Promise<string[]> {
    if (depth <= 0 || visited.has(baseUrl)) return [];
    visited.add(baseUrl);
    
    let page;
    try {
      page = await browser.newPage();
      await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

      const links = await page.evaluate(() =>
        Array.from(new Set(
          Array.from(document.querySelectorAll("a"))
            .map(a => (a as HTMLAnchorElement).href)
            .filter(href => href.startsWith(window.location.origin))
        ))
      );
      
      await page.close();

      const newLinks: string[] = [baseUrl];
      for (const link of links) {
          newLinks.push(...await crawlSiteRecursive(browser, link, depth - 1, visited));
      }
      return newLinks;
    } catch (error) {
      console.error(`Error crawling ${baseUrl}:`, error);
      if (page) await page.close();
      return [];
    }
  }


  // -------- Scrape page content --------
  async function scrapePage(browser: Browser, url: string) {
    const page = await browser.newPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const text = await page.evaluate(() => {
        document.querySelectorAll('script, style, noscript, svg, img').forEach(el => el.remove());
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
          acceptNode: node => node.textContent && node.textContent.trim().length > 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
        });

        let text = '';
        while (walker.nextNode()) text += walker.currentNode.textContent + ' ';
        return text.replace(/\s+/g, ' ').trim();
      });
      return chunkText(text);
    } finally {
      await page.close();
    }
  }

  // -------- Embedding helpers --------
  async function embedText(value: string, retries = 5, delay = 2000) {
    for (let i = 0; i < retries; i++) {
      try {
        const { embedding } = await embed({ model: embeddingModel, value }); 
        return embedding;
      } catch (err: unknown) {
  if (typeof err === "object" && err !== null && "statusCode" in err) {
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode === 429 || e.message?.includes("exhausted")) {
      console.warn(`Quota hit, retrying in ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
      delay *= 2;
    } else {
      throw err;
    }
  } else {
    throw err;

        }
      }
    }
    throw new Error("Max retries reached for embedding");
  }

  // -------- Ensure page indexed --------
  async function ensurePageIndexed(browser: Browser, url: string) { 
    const { count } = await supabase
      .from('documents')
      .select('id', { count: 'exact', head: true })
      .eq('url', url);

    if (count && count > 0) return;

    const chunks = await scrapePage(browser, url); 
    for (const [i, chunk] of chunks.entries()) {
      const vector = await embedText(chunk);
      await supabase.from('documents').insert([{ url, chunk_index: i, text: chunk, embedding: vector }]);
    }

    console.log(`Indexed: ${url}`);
  }

  // -------- Index multiple pages --------
  async function ensurePagesIndexed(baseUrl: string) {
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    try {
      const urls = await crawlSiteRecursive(browser, baseUrl);
      console.log("Found pages:", urls);
      for (const url of urls) {
        try { await ensurePageIndexed(browser, url); } catch (err) { console.error("Error indexing", url, err); }
      }
      console.log("✅ Indexing complete!");
    } finally {
      await browser.close();
    }
  }

  // -------- Search --------
  async function searchDocuments(query: string, topK = 5) {
    const queryEmb = await embedText(query);
    const { data, error } = await supabase.rpc('match_documents', { query_embedding: queryEmb, match_count: topK });
    if (error) throw error;
    type DocumentRow = { text: string };
    return (data as DocumentRow[] ?? []).map(d => d.text).join("\n\n");
  }

  // -------- API Handler --------
  let indexingStarted = false;
  export const maxDuration = 60;

  export async function POST(req: NextRequest) {
    const body = (await req.json()) as { messages: ChatMessage[]; query?: string };
    const messages = body?.messages ?? [];


    const lastUserMessage = [...messages].reverse().find(m => m.role === 'user');
  type ChatMetadata = {
  form?: {
    fullName: string;
    email: string;
    phone?: string;
    company?: string;
    inquiryType?: string;
    message?: string;
    contactMethod?: string;
    bestTime?: string;
    agree?: boolean;
    newsletter?: boolean;
  };
};

type ChatMessage = {
  role: 'user' | 'assistant' | 'system';
  parts: ChatPart[];
  metadata?: ChatMetadata;
};

const formData = lastUserMessage?.metadata?.form;
  if (formData) {
    const { error } = await supabase.from('user_leads').insert([{
      name: formData.fullName,
      email: formData.email,
      phone: formData.phone,
      company: formData.company,
      inquiry_type: formData.inquiryType,
      message: formData.message,
      contact_method: formData.contactMethod,
      best_time: formData.bestTime,
      agree: formData.agree,
      newsletter: formData.newsletter,
    }]);

    if (error) {
      console.error("❌ Supabase insert error:", error);
      return new Response(JSON.stringify({ error: "Failed to save lead" }), { status: 500 });
    }

    return new Response(JSON.stringify({ text: `✅ Thanks ${formData.fullName}! Your inquiry has been received.` }), { status: 200 });
  }



    


    
    const lastUserText =
      body?.query ?? [...messages].reverse().find(m => m.role === 'user')?.parts
        ?.filter(p => p.type === 'text')
        ?.map(p => p.text)
        ?.join(' ') ?? '';

    // Index only once
    if (!indexingStarted) {
      indexingStarted = true;
      ensurePagesIndexed('https://swarise.com/').catch(console.error);
    }

    let retrievedText = '';
    if (lastUserText) {
      try { retrievedText = await searchDocuments(lastUserText, 4); } 
      catch (e) { console.error('Vector search error:', e); }
    }

    const systemPrompt = retrievedText
  ? `You are a professional content assistant.

Always return the retrieved webpage text **exactly as it is**, without rewriting, summarizing, or rephrasing.
Do not change words. Do not add any external references or external content or external informatons
You may summarize, rephrase, and structure the information in readable paragraphs.

• For any question outside Swarise, do not answer. 
Always reply exactly: "I can only provide information about Swarise and its services."


Rules:
• if the user ask hi, hello: reply with "Hello! How can I assist you with Swarise today?"
• if the user ask who are you: reply with "I am a virtual assistant for Swarise, here to help you with information about our services."
• if the user ask what can you do: reply with "I can provide information.

• If the user asks anything outside Swarise (like jokes, general knowledge, personal queries), reply with:  
  "I can only provide information about Swarise and its services."  
• Always return the retrieved webpage text **exactly as it is**, without rewriting, summarizing, or rephrasing.  
• Do not add any external references or unrelated information. 
Formatting rules:
• Use bullet points (•) for lists.  
• Keep answers clean, simple, and professional.  
• Do not use symbols like *, #, or - other than bullets.  

If the user asks specifically about:
- Location of Swarise: provide exactly "Velacherry, Chennai".
- Email or contact of Swarise: provide exactly "info@swarise.com".
- Phone number of Swarise: provide exactly "+919841556667".

You are a helpful financial assistant. 
Do not mention or provide information about "Wealth Management", 
"Investment Planning", or "Retirement Planning" in any of your answers. 
If a user asks about these topics, politely say: 
"Sorry, I cannot provide details on that topic. Can I help you with something else?"

Never mention or display these three services anywhere in your response. 


Here’s the retrieved content:
${retrievedText}

Respond concisely and accurately in plain text.`
  : `You are a professional content assistant.

Respond clearly, concisely, and logically.
Always return the retrieved webpage text **exactly as it is**, without rewriting, summarizing, or rephrasing.
Do not change words.
Formatting rules:
• Use bullet points (•) for lists.  
• Keep answers clean, simple, and professional.  
• Do not use symbols like *, #, or - other than bullets.

• If the user asks anything outside Swarise (like jokes, general knowledge, personal queries), reply with:  
  "I can only provide information about Swarise and its services."  
• Always return the retrieved webpage text **exactly as it is**, without rewriting, summarizing, or rephrasing.  
• Do not add any external references or unrelated information.

• For any question outside Swarise, do not answer. 
Always reply exactly: "I can only provide information about Swarise and its services."


You are a helpful financial assistant. 
Do not mention or provide information about "Wealth Management", 
"Investment Planning", or "Retirement Planning" in any of your answers. 
If a user asks about these topics, politely say: 
"Sorry, I cannot provide details on that topic. Can I help you with something else?"
 


Never mention or display these three services anywhere in your response. 
`;

    const result = streamText({
      model: google('gemini-2.5-flash'),
      messages: [
        { role: 'system', content: systemPrompt },
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

       collectForm: tool({
        description: 'Collect full customer inquiry details (name, email, phone, etc.)',
        inputSchema: z.object({
          fullName: z.string(),
          email: z.string().email(),
          phone: z.string().optional(),
          company: z.string().optional(),
          inquiryType: z.string().optional(),
          message: z.string().optional(),
          contactMethod: z.string().optional(),
          bestTime: z.string().optional(),
          agree: z.boolean().default(false),
          newsletter: z.boolean().default(false),
        }),
        execute: async (data) => {
          const { error } = await supabase.from('user_leads').insert([{
            name: data.fullName,
            email: data.email,
            phone: data.phone,
            company: data.company,
            inquiry_type: data.inquiryType,
            message: data.message,
            contact_method: data.contactMethod,
            best_time: data.bestTime,
            agree: data.agree,
            newsletter: data.newsletter,
          }]);
          if (error) throw error;
          return { text: `✅ Thanks ${data.fullName}! Your inquiry has been received.` };
        }
        })
      },
    });

    return result.toUIMessageStreamResponse();
  }
