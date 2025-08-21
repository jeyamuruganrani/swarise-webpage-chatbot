'use client';

import { useChat } from '@ai-sdk/react';
import { useState, useEffect, useRef, KeyboardEvent } from 'react';
import './chat.css'; // WhatsApp style

export default function Chat() {
  const [input, setInput] = useState<string>('');
  const { messages, sendMessage, status } = useChat();
  const loading = status === 'submitted' || status === 'streaming';
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  const formatTime = (dateString?: string): string => {
    const date = dateString ? new Date(dateString) : new Date();
    return `${date.getHours()}:${date.getMinutes().toString().padStart(2, '0')}`;
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (input.trim()) {
        sendMessage({
          text: input,
          metadata: { createdAt: new Date().toISOString() },
        });
        setInput('');
      }
    }
  };

  return (
    <div className="chat-container">
      {/* Header */}
      <div className="chat-header">
        <img
          src="https://swarise.com/wp-content/uploads/2025/05/favicon.png"
          alt="Assistant"
          className="avatar"
        />
        Swarise Assistant
      </div>

      {/* Messages */}
      <div className="chat-messages">
        {messages.map((message) => (
          <div
            key={message.id}
            className={`message-row ${message.role === 'user' ? 'user' : 'assistant'}`}
          >
            <div
              className={`message-bubble ${message.role === 'user' ? 'user' : 'assistant'}`}
            >
              {message.parts
                .filter((part) => part.type === 'text')
                .map((part, i) => (
                  <div key={`${message.id}-${i}`}>{part.text}</div>
                ))}

              <div className="message-time">
                {formatTime((message as any).metadata?.createdAt)}
              </div>
            </div>
          </div>
        ))}

        {loading && (
          <div className="loading-indicator">
            <div className="message-bubble assistant">
              <div className="loading-dots">
                <span className="dot"></span>
                <span className="dot"></span>
                <span className="dot"></span>
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="chat-input-container">
        <textarea
          className="chat-textarea"
          value={input}
          placeholder="Type a message"
          required
          onChange={(e) => setInput(e.currentTarget.value)}
          onKeyDown={handleKeyDown}
        />
        <button
          type="button"
          onClick={() => {
            if (input.trim()) {
              sendMessage({
                text: input,
                metadata: { createdAt: new Date().toISOString() },
              });
              setInput('');
            }
          }}
          className="chat-send-button"
        >
          ➤
        </button>
      </div>
    </div>
  );
}
