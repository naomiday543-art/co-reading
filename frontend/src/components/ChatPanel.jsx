import React, { useState, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { streamChat, papersApi } from '../api';

export default function ChatPanel({ paperId, paper, onMessagesUpdated, onSaveInsight }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [error, setError] = useState('');
  const bottomRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    loadMessages();
  }, [paperId]);


  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingContent]);

  const loadMessages = async () => {
    try {
      const msgs = await papersApi.getMessages(paperId);
      setMessages(msgs);
      onMessagesUpdated?.();
    } catch {}
  };

  const handleSend = async () => {
    if (!input.trim() || streaming) return;
    const userMsg = input.trim();
    setInput('');
    setError('');

    // Add user message locally
    const tempUser = { id: 'temp', role: 'user', content: userMsg, created_at: Date.now() };
    setMessages(prev => [...prev, tempUser]);
    setStreaming(true);
    setStreamingContent('');

    try {
      let content = '';
      await streamChat(paperId, userMsg, {
        onDelta: (chunk) => {
          content += chunk;
          setStreamingContent(content);
        },
        onDone: () => {
          setStreamingContent('');
          setStreaming(false);
          loadMessages();
        },
        onError: (msg) => {
          setError(msg);
          setStreamingContent('');
          setStreaming(false);
        },
      });
    } catch (err) {
      setError(err.message);
      setStreaming(false);
      setStreamingContent('');
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const hasSummary = paper?.summary_conclusions || paper?.summary_bg;

  return (
    <div className="flex flex-col h-full">
      <h3 className="text-sm font-semibold text-gray-700 mb-2 flex items-center gap-2">
        💬 跟 AI 討論這篇論文
      </h3>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto space-y-3 mb-3 min-h-0">
        {/* Welcome message */}
        {messages.length === 0 && hasSummary && (
          <div className="chat-bubble-ai p-3 text-sm">
            我已經讀完了這篇論文。{paper.title || '這篇論文'} 主要研究了{' '}
            {(paper.summary_conclusions || paper.summary_bg || '').slice(0, 50)}
            ... 有什麼想討論的嗎？
          </div>
        )}

        {messages.map(msg => (
          <div
            key={msg.id}
            className={`p-3 text-sm max-w-[85%] ${msg.role === 'user'
              ? 'chat-bubble-user ml-auto'
              : 'chat-bubble-ai'
            }`}
          >
            {msg.role === 'assistant' ? (
              <div>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {msg.content}
                </ReactMarkdown>
                {onSaveInsight && (
                  <button
                    className="mt-1.5 text-xs text-gray-400 hover:text-primary flex items-center gap-0.5 transition-colors"
                    onClick={onSaveInsight}
                    title="將這段回覆存為洞察"
                  >
                    💡 存為洞察
                  </button>
                )}
              </div>
            ) : (
              <p className="whitespace-pre-wrap">{msg.content}</p>
            )}
          </div>
        ))}

        {/* Streaming */}
        {streaming && (
          <div className="chat-bubble-ai p-3 text-sm max-w-[85%]">
            {streamingContent ? (
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {streamingContent}
              </ReactMarkdown>
            ) : (
              <div className="flex gap-1">
                <span className="w-2 h-2 bg-gray-400 rounded-full typing-dot" />
                <span className="w-2 h-2 bg-gray-400 rounded-full typing-dot" />
                <span className="w-2 h-2 bg-gray-400 rounded-full typing-dot" />
              </div>
            )}
          </div>
        )}

        {error && (
          <div className="p-2 text-sm text-red-600 bg-red-50 rounded-lg">
            {error}
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="shrink-0 space-y-1.5">
        <div className="flex gap-2">
          <textarea
            ref={inputRef}
            className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-primary"
            rows={2}
            placeholder="輸入你的問題... (Enter 發送，Shift+Enter 換行)"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={streaming}
          />
          <button
            className="px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
            onClick={handleSend}
            disabled={streaming || !input.trim()}
          >
            發送
          </button>
        </div>
        <button
          className="text-xs text-gray-500 hover:text-primary flex items-center gap-1 px-1 transition-colors"
          onClick={async () => {
            try {
              const text = await navigator.clipboard.readText();
              if (text.trim()) {
                setInput(prev => prev + (prev ? '\n\n' : '') + `關於這段原文：\n「${text.trim()}」\n\n`);
                inputRef.current?.focus();
              }
            } catch {
              setInput(prev => prev + (prev ? '\n\n' : '') + '關於這段原文：\n「」\n\n');
              inputRef.current?.focus();
            }
          }}
          title="從 PDF 複製文字後，點這裡貼入"
        >
          📋 貼上原文提問
        </button>
      </div>
    </div>
  );
}
