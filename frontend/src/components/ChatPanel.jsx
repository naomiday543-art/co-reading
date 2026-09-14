import React, { useState, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { streamChat, regenerateChat, continueChat, papersApi } from '../api';
import { useStore, CHAT_FONT_PX, CHAT_FONT_LABELS, nextChatFontSize, thinkingLabel } from '../store';
import { previousUserMessage } from '../lib/insight-source';
import { formatRange, quotePreview } from '../lib/fulltext-offsets';
import CarryoverPanel from './CarryoverPanel';

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
  // 工單 12 §3.3／§3.4：等待期看得見（秒數＋思考字數）、可中止、失敗不抹半截。
  const [thinkingChars, setThinkingChars] = useState(0);
  const [thinkingStartedAt, setThinkingStartedAt] = useState(null);
  const [, setTick] = useState(0);          // 只為了讓秒數每 500ms 重畫
  const [streamNote, setStreamNote] = useState(''); // '' | 'stopped' | 'incomplete'
  const [errorHint, setErrorHint] = useState('');
  // 工單 14 §3.3：她按了「問這段」之後、還沒送出的那段引用（住在 store，因為來源是
  // 另一個面板的 FullTextView）。展開的引用塊則是每個氣泡各自記。
  const pendingQuote = useStore(s => s.pendingQuote);
  const clearPendingQuote = useStore(s => s.clearPendingQuote);
  const requestQuoteJump = useStore(s => s.requestQuoteJump);
  const [expandedQuote, setExpandedQuote] = useState(null);
  const abortRef = useRef(null);
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

  // 等待提示的秒數是前端自己數的（後端只送字數），所以要有一顆心跳讓它重畫。
  useEffect(() => {
    if (!streaming) return;
    const timer = setInterval(() => setTick(t => t + 1), 500);
    return () => clearInterval(timer);
  }, [streaming]);

  // 換論文／卸載時把還在跑的那條收掉，免得回來時舊串流還在往新畫面寫字。
  useEffect(() => () => abortRef.current?.abort(), []);

  // 選段一進來就把游標放進輸入框——她的下一個動作一定是打問題（或直接 Enter）
  useEffect(() => {
    if (pendingQuote) inputRef.current?.focus();
  }, [pendingQuote]);

  const loadMessages = async () => {
    try {
      const msgs = await papersApi.getMessages(paperId);
      setMessages(msgs);
      // 帶上條數，讓閱讀模式的浮鈕知道抽屜收著時有沒有來新回覆
      onMessagesUpdated?.(msgs.length);
    } catch {}
  };

  /**
   * 三個入口（送出／重新生成／編輯後繼續）共用的串流殼。
   *
   * 兩條規矩寫在這裡，不散在三份 copy 裡：
   * - **失敗不抹半截**：`onError` 只設錯誤，`streamingContent` 原封不動留在畫面上，
   *   標「（未完成，未保存）」。舊代碼在這裡 `setStreamingContent('')`，已經上屏的字全沒了。
   * - **中止**：`AbortController` 存在 ref 裡給「停止」按鈕用；abort 不是錯誤，不印紅框。
   */
  const runStream = async (invoke) => {
    const controller = new AbortController();
    abortRef.current = controller;

    setError('');
    setErrorHint('');
    setStreamNote('');
    setThinkingChars(0);
    setThinkingStartedAt(Date.now());
    setStreaming(true);
    setStreamingContent('');

    try {
      await invoke({
        signal: controller.signal,
        onDelta: (chunk) => setStreamingContent(prev => prev + chunk),
        onThinking: ({ chars, done }) => { if (!done) setThinkingChars(chars); },
        onDone: () => {
          setStreamingContent('');
          setStreaming(false);
          loadMessages();
        },
        onError: (msg, data) => {
          setError(msg);
          setErrorHint(data?.hint || '');
          if (data?.partial > 0) setStreamNote('incomplete');
          setStreaming(false);
        },
      });
    } catch (err) {
      if (controller.signal.aborted || err?.name === 'AbortError') {
        setStreamNote('stopped');
      } else {
        setError(err.message);
        setStreamingContent('');
      }
      setStreaming(false);
    } finally {
      abortRef.current = null;
    }
  };

  const handleStop = () => abortRef.current?.abort();

  const handleSend = async () => {
    // 只選了一段、一個字都沒打也算數（後端會用預設問題，工單 14 §3.2）
    if ((!input.trim() && !pendingQuote) || streaming) return;
    const userMsg = input.trim();
    const quote = pendingQuote;
    setInput('');
    clearPendingQuote();

    const tempUser = { id: 'temp', role: 'user', content: userMsg, created_at: Date.now(), quote };
    setMessages(prev => [...prev, tempUser]);

    await runStream(opts => streamChat(paperId, userMsg, { ...opts, quote }));
  };

  const handleRegenerate = async () => {
    if (streaming) return;
    await runStream(opts => regenerateChat(paperId, opts));
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
      await runStream(opts => continueChat(paperId, opts));
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

  // 聊天字級三檔（工單 06 §3.2）：走 CSS 變數，所以抽屜裡跟分欄裡是同一份
  const { chatFontSize, setChatFontSize } = useStore();

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
    <div className="flex flex-col h-full" style={{ '--chat-fs': CHAT_FONT_PX[chatFontSize] }}>
      <h3 className="cr-serif text-sm font-semibold text-text-strong mb-2 flex items-center gap-2">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-accent"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
        討論
      </h3>

      {/* 研究續窗：精煉按鈕 + carryover 卡片（手動觸發/手動帶上，拍板 #1/#3） */}
      <CarryoverPanel paperId={paperId} messageCount={messages.length} />

      {/* Messages */}
      <div className="flex-1 overflow-y-auto space-y-3 mb-3 min-h-0">
        {/* Welcome message */}
        {messages.length === 0 && hasSummary && (
          <div className="chat-bubble-ai p-3">
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
                className="chat-bubble-user p-3 max-w-[85%] ml-auto"
              >
                <textarea
                  className="cr-chat-input w-full min-h-[60px] max-h-[200px] border border-border bg-surface rounded-lg p-2 resize-y focus:outline-none focus:border-accent"
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
                    className="px-3 py-1 text-xs bg-accent text-accent-fg rounded-md hover:bg-accent-hover"
                    onClick={() => handleSaveEdit(msg.id)}
                    disabled={streaming}
                  >
                    保存
                  </button>
                  <button
                    className="px-3 py-1 text-xs border border-border rounded-md hover:bg-surface-hover"
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
              className={`group p-3 max-w-[85%] ${isUser
                ? 'chat-bubble-user ml-auto'
                : 'chat-bubble-ai'
              }`}
            >
              {!isUser ? (
                <div>
                  <div className="prose-chat">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {msg.content}
                    </ReactMarkdown>
                  </div>
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
                        <span className="cr-mono text-[10px] opacity-40 min-w-[22px] text-center">
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
                        className="text-xs text-faint hover:text-accent px-1.5 py-0.5 rounded-md hover:bg-surface-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        onClick={handleRegenerate}
                        disabled={streaming}
                        title="重新生成回覆"
                      >
                        ↻ 重新生成
                      </button>
                    )}

                    {/* Save as insight —— 工單 18 §2 A1：帶上這一則的 id（表單存它）
                        與它前面那一則 user 的 id（展示時用得到），洞察才記得住出處。 */}
                    {onSaveInsight && (
                      <button
                        className="text-xs text-faint hover:text-accent flex items-center gap-0.5 px-1.5 py-0.5 rounded-md hover:bg-surface-hover transition-colors"
                        onClick={() => onSaveInsight(msg, previousUserMessage(messages, idx))}
                        title="將這段回覆存為洞察"
                      >
                        存為洞察
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <div>
                  {/* 工單 14 §3.3：帶引用的提問，氣泡上方縮起一塊原文；點一下展開／收起，
                      點「跳回原文」回到閱讀模式那個位置 */}
                  {msg.quote && (
                    <div
                      className="cr-quote-block"
                      role="button"
                      tabIndex={0}
                      title="點一下展開；「跳回原文」回到閱讀模式該位置"
                      onClick={() => setExpandedQuote(expandedQuote === msg.id ? null : msg.id)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setExpandedQuote(expandedQuote === msg.id ? null : msg.id);
                        }
                      }}
                    >
                      <div className="flex items-center gap-1.5 mb-0.5">
                        <span className="cr-mono text-[10px] opacity-70">
                          引用原文 · {formatRange(msg.quote)}
                        </span>
                        <span
                          className="text-[10px] underline decoration-dotted opacity-80 hover:opacity-100"
                          role="button"
                          tabIndex={0}
                          onClick={e => { e.stopPropagation(); requestQuoteJump(msg.quote); }}
                          onKeyDown={e => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              e.stopPropagation();
                              requestQuoteJump(msg.quote);
                            }
                          }}
                        >
                          跳回原文
                        </span>
                      </div>
                      <span className="whitespace-pre-wrap">
                        {expandedQuote === msg.id ? msg.quote.text : quotePreview(msg.quote.text)}
                      </span>
                    </div>
                  )}
                  {msg.content
                    ? <p className="whitespace-pre-wrap">{msg.content}</p>
                    : <p className="text-[11.5px] text-muted italic">（沒有另外打字，請 AI 直接解釋這段）</p>}
                  {msg.edited ? (
                    <span className="text-[10px] text-muted ml-1">(已編輯)</span>
                  ) : null}
                  <div className="flex items-center gap-1 mt-1">
                    {/* Edit button — dimmed by default, prominent on hover (visible on touch) */}
                    <button
                      className="text-xs text-muted hover:text-accent opacity-50 group-hover:opacity-100 px-1.5 py-0.5 rounded-md hover:bg-surface-hover transition-all"
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
                          className="text-xs text-muted hover:text-accent px-1.5 py-0.5 rounded-md hover:bg-surface-hover transition-colors"
                          onClick={() => setShowBranchesFor(showBranchesFor === msg.id ? null : msg.id)}
                        >
                          編輯歷史 ({msg.edit_branches.length})
                        </button>
                        {showBranchesFor === msg.id && (
                          <div className="absolute left-0 top-6 bg-surface border border-border rounded-lg shadow-lg z-20 py-1 text-xs w-64 max-h-48 overflow-y-auto">
                            {msg.edit_branches.map(b => (
                              <button
                                key={b.id}
                                className="block w-full text-left px-3 py-1.5 hover:bg-surface-hover border-b border-border-soft last:border-0"
                                onClick={() => handleSwitchBranch(msg.id, b.id)}
                              >
                                <div className="text-text truncate">
                                  {b.original_content ? b.original_content.slice(0, 40) : '(空)'}
                                  {b.original_content && b.original_content.length > 40 ? '...' : ''}
                                </div>
                                <div className="text-faint mt-0.5">
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

        {/* Streaming — 串流結束後如果還有半截（失敗／被停止），這塊要繼續留著 */}
        {(streaming || streamingContent) && (
          <div className="chat-bubble-ai p-3 max-w-[85%]">
            {streamingContent ? (
              <div className="prose-chat">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {streamingContent}
                </ReactMarkdown>
              </div>
            ) : (
              /* 三個沒有文字的點最短也要跳 10 秒（報告 11 §6）——看起來跟當掉一樣。
                 改成看得見的「正在思考」：秒數前端自己數，字數來自 thinking 事件。
                 前 2 秒只留點，免得閃一個「0 字」。 */
              <div className="flex items-center gap-2">
                <div className="flex gap-1">
                  <span className="w-2 h-2 bg-faint rounded-full typing-dot" />
                  <span className="w-2 h-2 bg-faint rounded-full typing-dot" />
                  <span className="w-2 h-2 bg-faint rounded-full typing-dot" />
                </div>
                <span className="text-xs text-muted">{thinkingLabel(thinkingStartedAt, thinkingChars)}</span>
              </div>
            )}
            {streamNote && !streaming && (
              <div className="mt-1.5 text-xs text-faint">
                {streamNote === 'stopped' ? '（已停止，未保存）' : '（未完成，未保存）'}
              </div>
            )}
          </div>
        )}

        {error && (
          <div className="p-2.5 text-sm text-danger bg-surface-alt border border-border-soft rounded-lg">
            {error}
            {errorHint && <div className="mt-1 text-xs text-muted">{errorHint}</div>}
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="shrink-0 space-y-1.5">
        {/* 引用卡（工單 14 §3.3）：她在閱讀模式選了一段按「問這段」之後停在這裡，
            ✕ 取消。送出時跟著走，DB 裡另存 quote 欄，不混進她打的字。 */}
        {pendingQuote && (
          <div className="cr-quote-card">
            <div className="cr-quote-card-text">
              <div className="cr-mono text-[10px] opacity-70 mb-0.5">
                引用原文 · {formatRange(pendingQuote)}
              </div>
              {quotePreview(pendingQuote.text)}
            </div>
            <button
              className="cr-quote-card-x"
              onClick={clearPendingQuote}
              title="取消引用"
            >
              ✕
            </button>
          </div>
        )}
        <div className="flex gap-2">
          <textarea
            ref={inputRef}
            className="cr-chat-input flex-1 border border-border bg-surface rounded-2xl px-4 py-2.5 resize-none shadow-sm focus:outline-none focus:border-accent"
            rows={2}
            placeholder={pendingQuote
              ? '想問這段什麼？直接 Enter 就讓 AI 解釋這一段'
              : '追問，或貼上一段原文一起讀…（Enter 送出，Shift+Enter 換行）'}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={streaming}
          />
          {streaming ? (
            /* 工單 12 §3.4②：等了 10–17 秒又不想等的時候，她本來只能關頁面。
               按下去 fetch 被 abort ⇒ 後端 res 'close' ⇒ 上游那條也收掉，不繼續燒。 */
            <button
              className="cr-chat-stop-btn px-4 py-2 bg-surface border border-border text-text rounded-xl text-sm font-medium hover:bg-surface-hover shrink-0"
              onClick={handleStop}
            >
              停止
            </button>
          ) : (
            <button
              className="px-4 py-2 bg-accent text-accent-fg rounded-xl text-sm font-medium hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
              onClick={handleSend}
              disabled={!input.trim() && !pendingQuote}
            >
              送出
            </button>
          )}
        </div>
        <button
          className="text-xs text-muted hover:text-accent flex items-center gap-1 px-1 transition-colors"
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

        {/* 工具列：字級開關永遠在，提取洞察照舊要有兩條訊息才出現 */}
        <div className="flex items-center gap-2">
          <button
            className="cr-chat-font-btn text-xs text-muted hover:text-accent flex items-center gap-1 px-1 transition-colors"
            onClick={() => setChatFontSize(nextChatFontSize(chatFontSize))}
            title={`聊天字級：${CHAT_FONT_LABELS[chatFontSize]}（${CHAT_FONT_PX[chatFontSize]}）— 點一下換下一檔`}
          >
            <span className="cr-serif text-[13px] leading-none">Aa</span>
            {CHAT_FONT_LABELS[chatFontSize]}
          </button>
          {messages.length >= 2 && (
            <>
              <button
                className="text-xs text-muted hover:text-accent flex items-center gap-1 px-1 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                onClick={handleExtract}
                disabled={extracting}
                title="從討論中自動提取洞察"
              >
                {extracting ? '… 提取中...' : '提取洞察'}
              </button>
              {extractResult && (
                /* 工單 08 §3.5：三段各自 >0 才顯示；三段都是 0 時也要給一句回音，
                   不然按了「提取洞察」之後畫面什麼都不變，看起來像壞了 */
                <span className="text-xs text-fact">
                  {[
                    extractResult.insights.length > 0 && `新增 ${extractResult.insights.length} 條洞察`,
                    extractResult.skipped > 0 && `${extractResult.skipped} 條進度已跳過`,
                    extractResult.duplicates > 0 && `${extractResult.duplicates} 條與既有洞察重複已略過`,
                  ].filter(Boolean).join('；') || '沒有新的洞察'}
                </span>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
