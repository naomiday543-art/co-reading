import React, { useState, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { streamChat, regenerateChat, continueChat, papersApi } from '../api';

export function switchVersion(messages, messageId, direction) {
  return messages.map(m => {
    const isTarget = m.id === messageId ||
      (m.regen_versions && m.regen_versions.some(v => v.id === messageId));
    if (!isTarget) return m;

    const versions = m.regen_versions || [];
    if (versions.length < 2) return m;

    const newIdx = (m.regen_idx ?? 0) + direction;
    if (newIdx < 0 || newIdx >= versions.length) return m;

    return {
      ...m,
      regen_idx: newIdx,
      content: versions[newIdx].content,
      id: versions[newIdx].id,
      created_at: versions[newIdx].ts,
    };
  });
}

export default function ChatPanel({ paperId, paper, onMessagesUpdated, onSaveInsight }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [error, setError] = useState('');
  const [extracting, setExtracting] = useState(false);
  const [extractResult, setExtractResult] = useState(null);
  const [editingMsgId, setEditingMsgId] = useState(null);
  const [editContent, setEditContent] = useState('');
  const [showBranchesFor, setShowBranchesFor] = useState(null);
  const bottomRef = useRef(null);
  const inputRef = useRef(null);
  const branchDropdownRef = useRef(null);

  useEffect(() => {
    loadMessages();
  }, [paperId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingContent]);

  useEffect(() => {
    if (!showBranchesFor) return;
    const handler = (e) => {
      if (branchDropdownRef.current && !branchDropdownRef.current.contains(e.target)) {
        setShowBranchesFor(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showBranchesFor]);

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

    const tempUser = { id: 'temp', role: 'user', content: userMsg, created_at: Date.now() };
    setMessages(prev => [...prev, tempUser]);
    setStreaming(true);
    setStreamingContent('');

    try {
      await streamChat(paperId, userMsg, {
        onDelta: (chunk) => setStreamingContent(prev => prev + chunk),
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

  const handleRegenerate = async () => {
    if (streaming) return;
    setError('');
    setStreaming(true);
    setStreamingContent('');

    try {
      await regenerateChat(paperId, {
        onDelta: (chunk) => setStreamingContent(prev => prev + chunk),
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

  const handleStartEdit = (msgId) => {
    const msg = messages.find(m => m.id === msgId);
    if (!msg) return;
    setEditingMsgId(msgId);
    setEditContent(msg.content);
    setShowBranchesFor(null);
  };

  const handleCancelEdit = () => {
    setEditingMsgId(null);
    setEditContent('');
  };

  const handleSaveEdit = async (msgId) => {
    if (!editContent.trim() || streaming) return;
    const newContent = editContent.trim();
    const msg = messages.find(m => m.id === msgId);
    if (!msg || newContent === msg.content) {
      setEditingMsgId(null);
      setEditContent('');
      return;
    }

    setError('');
    setEditingMsgId(null);
    setEditContent('');

    try {
      await papersApi.editMessage(paperId, msgId, newContent);

      // Update local state: edit message, remove tail
      setMessages(prev => {
        const idx = prev.findIndex(m => m.id === msgId);
        if (idx < 0) return prev;
        const updated = prev.slice(0, idx + 1);
        updated[idx] = { ...updated[idx], content: newContent, edited: true };
        return updated;
      });

      // Continue: generate new AI response
      setStreaming(true);
      setStreamingContent('');

      await continueChat(paperId, {
        onDelta: (chunk) => setStreamingContent(prev => prev + chunk),
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

  const handleSwitchVersion = (messageId, direction) => {
    setMessages(prev => switchVersion(prev, messageId, direction));
  };

  const handleSwitchBranch = async (forkId, branchId) => {
    if (streaming) return;
    setError('');
    setShowBranchesFor(null);
    try {
      await papersApi.switchBranch(paperId, forkId, branchId);
      await loadMessages();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (editingMsgId) {
        handleSaveEdit(editingMsgId);
      } else {
        handleSend();
      }
    }
  };

  const handleExtract = async () => {
    setExtracting(true);
    setExtractResult(null);
    setError('');
    try {
      const result = await papersApi.extractInsights(paperId);
      setExtractResult(result);
    } catch (err) {
      setError(`提取失敗: ${err.message}`);
    } finally {
      setExtracting(false);
    }
  };

  const hasSummary = paper?.summary_conclusions || paper?.summary_bg;

  // Find last AI message for regenerate button
  let lastAIMsgId = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      lastAIMsgId = messages[i].id;
      break;
    }
  }

  return (
    <div className="flex flex-col h-full">
      <h3 className="text-sm font-semibold text-gray-700 mb-2 flex items-center gap-2">
        跟 AI 討論這篇論文
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

        {messages.map((msg, idx) => {
          const isUser = msg.role === 'user';
          const isEditing = editingMsgId === msg.id;
          const isLastAI = msg.role === 'assistant' && msg.id === lastAIMsgId;
          const hasVersions = msg.regen_versions && msg.regen_versions.length > 1;
          const hasEditBranches = msg.edit_branches && msg.edit_branches.length > 0;

          if (isEditing) {
            return (
              <div
                key={msg.id}
                className="chat-bubble-user p-3 text-sm max-w-[85%] ml-auto"
              >
                <textarea
                  className="w-full min-h-[60px] max-h-[200px] border border-gray-300 rounded-lg p-2 text-sm resize-y focus:outline-none focus:ring-1 focus:ring-primary"
                  value={editContent}
                  onChange={e => setEditContent(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      handleSaveEdit(msg.id);
                    } else if (e.key === 'Escape') {
                      handleCancelEdit();
                    }
                  }}
                  autoFocus
                />
                <div className="flex gap-2 mt-1.5">
                  <button
                    className="px-3 py-1 text-xs bg-primary text-white rounded-md hover:bg-primary/90"
                    onClick={() => handleSaveEdit(msg.id)}
                    disabled={streaming}
                  >
                    保存
                  </button>
                  <button
                    className="px-3 py-1 text-xs border border-gray-300 rounded-md hover:bg-gray-50"
                    onClick={handleCancelEdit}
                  >
                    取消
                  </button>
                </div>
              </div>
            );
          }

          return (
            <div
              key={msg.id}
              className={`group p-3 text-sm max-w-[85%] ${isUser
                ? 'chat-bubble-user ml-auto'
                : 'chat-bubble-ai'
              }`}
            >
              {!isUser ? (
                <div>
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {msg.content}
                  </ReactMarkdown>
                  <div className="flex items-center gap-1 mt-1.5 flex-wrap">
                    {/* Version navigation */}
                    {hasVersions && (
                      <span className="inline-flex items-center gap-0.5 select-none">
                        <span
                          className="cursor-pointer px-1.5 py-0.5 text-sm opacity-40 hover:opacity-70 rounded active:opacity-90 active:bg-black/5"
                          onClick={() => handleSwitchVersion(msg.id, -1)}
                        >
                          ‹
                        </span>
                        <span className="font-mono text-[10px] opacity-40 min-w-[22px] text-center">
                          {(msg.regen_idx ?? 0) + 1}/{msg.regen_versions.length}
                        </span>
                        <span
                          className="cursor-pointer px-1.5 py-0.5 text-sm opacity-40 hover:opacity-70 rounded active:opacity-90 active:bg-black/5"
                          onClick={() => handleSwitchVersion(msg.id, 1)}
                        >
                          ›
                        </span>
                      </span>
                    )}

                    {/* Regenerate button — only on last AI */}
                    {isLastAI && (
                      <button
                        className="text-xs text-gray-400 hover:text-primary px-1.5 py-0.5 rounded-md hover:bg-gray-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        onClick={handleRegenerate}
                        disabled={streaming}
                        title="重新生成回覆"
                      >
                        ↻ 重新生成
                      </button>
                    )}

                    {/* Save as insight */}
                    {onSaveInsight && (
                      <button
                        className="text-xs text-gray-400 hover:text-primary flex items-center gap-0.5 px-1.5 py-0.5 rounded-md hover:bg-gray-100 transition-colors"
                        onClick={onSaveInsight}
                        title="將這段回覆存為洞察"
                      >
                        存為洞察
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <div>
                  <p className="whitespace-pre-wrap">{msg.content}</p>
                  {msg.edited ? (
                    <span className="text-[10px] text-gray-400 ml-1">(已編輯)</span>
                  ) : null}
                  <div className="flex items-center gap-1 mt-1">
                    {/* Edit button — dimmed by default, prominent on hover (visible on touch) */}
                    <button
                      className="text-xs text-gray-400 hover:text-primary opacity-40 group-hover:opacity-100 px-1.5 py-0.5 rounded-md hover:bg-gray-100 transition-all"
                      onClick={() => handleStartEdit(msg.id)}
                      disabled={streaming}
                      title="編輯消息"
                    >
                      ✎ 編輯
                    </button>

                    {/* Edit branches */}
                    {hasEditBranches && (
                      <div
                        className="relative"
                        ref={showBranchesFor === msg.id ? branchDropdownRef : null}
                      >
                        <button
                          className="text-xs text-gray-400 hover:text-primary px-1.5 py-0.5 rounded-md hover:bg-gray-100 transition-colors"
                          onClick={() => setShowBranchesFor(showBranchesFor === msg.id ? null : msg.id)}
                        >
                          編輯歷史 ({msg.edit_branches.length})
                        </button>
                        {showBranchesFor === msg.id && (
                          <div className="absolute left-0 top-6 bg-white border border-gray-200 rounded-md shadow-lg z-20 py-1 text-xs w-64 max-h-48 overflow-y-auto">
                            {msg.edit_branches.map(b => (
                              <button
                                key={b.id}
                                className="block w-full text-left px-3 py-1.5 hover:bg-gray-100 border-b border-gray-50 last:border-0"
                                onClick={() => handleSwitchBranch(msg.id, b.id)}
                              >
                                <div className="text-gray-700 truncate">
                                  {b.original_content ? b.original_content.slice(0, 40) : '(空)'}
                                  {b.original_content && b.original_content.length > 40 ? '...' : ''}
                                </div>
                                <div className="text-gray-400 mt-0.5">
                                  {b.tail_count != null ? `${b.tail_count} 條後續消息` : ''}
                                  {b.ts ? ` · ${new Date(b.ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : ''}
                                </div>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}

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
          貼上原文提問
        </button>

        {/* Extract insights button */}
        {messages.length >= 2 && (
          <div className="flex items-center gap-2">
            <button
              className="text-xs text-gray-500 hover:text-primary flex items-center gap-1 px-1 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={handleExtract}
              disabled={extracting}
              title="從討論中自動提取洞察"
            >
              {extracting ? '… 提取中...' : '提取洞察'}
            </button>
            {extractResult && (
              <span className="text-xs text-green-600">
                新增 {extractResult.insights.length} 條洞察
                {extractResult.skipped > 0 && `（${extractResult.skipped} 條進度已跳過）`}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
