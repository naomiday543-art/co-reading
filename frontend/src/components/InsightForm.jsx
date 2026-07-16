import React, { useState, useEffect } from 'react';

const DIMENSIONS = ['概念', '延伸', '你的研究', '闪回', '共振', '悬题'];

export default function InsightForm({ insight, papers, onSave, onCancel }) {
  const [dimension, setDimension] = useState(insight?.dimension || '延伸');
  const [title, setTitle] = useState(insight?.title || '');
  const [content, setContent] = useState(insight?.content || '');
  const [sourcePaperId, setSourcePaperId] = useState(insight?.source_paper_id || '');
  const [sourceContext, setSourceContext] = useState(insight?.source_context || '');
  const [paperSearch, setPaperSearch] = useState('');
  const [showPaperDropdown, setShowPaperDropdown] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (insight?.source_paper_id && papers.length > 0) {
      const paper = papers.find(p => p.id === insight.source_paper_id);
      if (paper) setPaperSearch(paper.title || paper.pdf_filename || '');
    }
  }, [insight, papers]);

  const filteredPapers = paperSearch.trim()
    ? papers.filter(p => {
        const name = p.title || p.pdf_filename || '';
        return name.toLowerCase().includes(paperSearch.toLowerCase());
      }).slice(0, 8)
    : papers.slice(0, 8);

  const selectedPaper = papers.find(p => p.id === sourcePaperId);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!title.trim() || !content.trim()) return;
    setSaving(true);
    try {
      await onSave({
        dimension,
        title: title.trim(),
        content: content.trim(),
        source_paper_id: sourcePaperId || null,
        source_context: sourceContext.trim(),
        tags: [],
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onCancel}>
      <form
        className="bg-surface border border-border-soft rounded-2xl shadow-lg p-6 w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <h3 className="cr-serif text-lg font-semibold text-text-strong mb-4">
          {insight ? '編輯洞察' : '新建洞察'}
        </h3>

        {/* Dimension */}
        <label className="block text-sm font-medium text-muted mb-1.5">維度</label>
        <div className="flex flex-wrap gap-1.5 mb-3">
          {DIMENSIONS.map(d => (
            <button
              key={d}
              type="button"
              className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                dimension === d
                  ? 'bg-accent-soft text-accent border-transparent font-medium'
                  : 'border-border text-muted hover:bg-surface-hover'
              }`}
              onClick={() => setDimension(d)}
            >
              {d}
            </button>
          ))}
        </div>

        {/* Title */}
        <label className="block text-sm font-medium text-muted mb-1.5">標題</label>
        <input
          className="w-full border border-border bg-surface-alt rounded-[10px] px-3 py-2 text-sm mb-3 focus:outline-none focus:border-accent"
          placeholder="一句話概括..."
          value={title}
          onChange={e => setTitle(e.target.value)}
          autoFocus
        />

        {/* Content */}
        <label className="block text-sm font-medium text-muted mb-1.5">內容</label>
        <textarea
          className="w-full border border-border bg-surface-alt rounded-[10px] px-3 py-2 text-sm mb-3 resize-y min-h-[120px] focus:outline-none focus:border-accent"
          placeholder="詳細描述這個洞察..."
          value={content}
          onChange={e => setContent(e.target.value)}
        />

        {/* Source context */}
        <label className="block text-sm font-medium text-muted mb-1.5">來源上下文（可選）</label>
        <input
          className="w-full border border-border bg-surface-alt rounded-[10px] px-3 py-2 text-sm mb-3 focus:outline-none focus:border-accent"
          placeholder="例如：討論 Methods 段落時產生..."
          value={sourceContext}
          onChange={e => setSourceContext(e.target.value)}
        />

        {/* Source paper */}
        <label className="block text-sm font-medium text-muted mb-1.5">來源論文（可選）</label>
        <div className="relative mb-4">
          <input
            className="w-full border border-border bg-surface-alt rounded-[10px] px-3 py-2 text-sm focus:outline-none focus:border-accent"
            placeholder="搜尋論文..."
            value={paperSearch}
            onChange={e => {
              setPaperSearch(e.target.value);
              setSourcePaperId('');
              setShowPaperDropdown(true);
            }}
            onFocus={() => setShowPaperDropdown(true)}
            onBlur={() => setTimeout(() => setShowPaperDropdown(false), 200)}
          />
          {selectedPaper && sourcePaperId && (
            <p className="text-xs text-muted mt-1">已選：{selectedPaper.title || selectedPaper.pdf_filename}</p>
          )}
          {showPaperDropdown && filteredPapers.length > 0 && (
            <div className="absolute left-0 top-full mt-1 w-full bg-surface border border-border rounded-lg shadow-lg z-30 py-1 max-h-40 overflow-y-auto">
              <button
                type="button"
                className="block w-full text-left px-3 py-1.5 text-sm text-muted hover:bg-surface-hover"
                onClick={() => {
                  setSourcePaperId('');
                  setPaperSearch('');
                  setShowPaperDropdown(false);
                }}
              >
                無來源論文
              </button>
              {filteredPapers.map(p => (
                <button
                  key={p.id}
                  type="button"
                  className="block w-full text-left px-3 py-1.5 text-sm hover:bg-surface-hover"
                  onClick={() => {
                    setSourcePaperId(p.id);
                    setPaperSearch(p.title || p.pdf_filename || '');
                    setShowPaperDropdown(false);
                  }}
                >
                  {p.title || p.pdf_filename || '未命名'}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="px-4 py-2 text-sm text-muted border border-border hover:bg-surface-hover rounded-[10px]"
            onClick={onCancel}
          >
            取消
          </button>
          <button
            type="submit"
            className="px-4 py-2 text-sm bg-accent text-accent-fg rounded-[10px] font-medium hover:bg-accent-hover disabled:opacity-50 shadow-sm"
            disabled={saving || !title.trim() || !content.trim()}
          >
            {saving ? '儲存中...' : '儲存'}
          </button>
        </div>
      </form>
    </div>
  );
}
