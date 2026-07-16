import React from 'react';

const sections = [
  { key: 'summary_bg', label: '背景', icon: '' },
  { key: 'summary_methods', label: '方法', icon: '' },
  { key: 'summary_results', label: '結果', icon: '' },
  { key: 'summary_conclusions', label: '結論', icon: '' },
  { key: 'summary_limitations', label: '局限', icon: '' },
];

export default function SummaryView({ paper }) {
  const hasSummary = paper.summary_bg || paper.summary_methods || paper.summary_results
    || paper.summary_conclusions || paper.summary_limitations;

  if (!hasSummary) {
    if (paper.analyze_status === 'analyzing') {
      return (
        <div className="flex items-center justify-center py-12 text-muted">
          <div className="text-center">
            <div className="flex gap-1 justify-center mb-2">
              <span className="w-2 h-2 bg-accent rounded-full typing-dot" />
              <span className="w-2 h-2 bg-accent rounded-full typing-dot" />
              <span className="w-2 h-2 bg-accent rounded-full typing-dot" />
            </div>
            <p className="text-sm">AI 正在通讀論文中...</p>
          </div>
        </div>
      );
    }
    if (paper.analyze_status === 'error') {
      return (
        <div className="text-center py-12">
          <p className="text-sm text-danger mb-2">AI 通讀失敗</p>
          <p className="text-xs text-muted">{paper.analyze_error}</p>
        </div>
      );
    }
    return (
      <div className="text-center py-12 text-faint text-sm">
        <p>尚未生成 AI 摘要</p>
        <p className="text-xs mt-1">上傳 PDF 後將自動開始通讀</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h3 className="cr-serif text-sm font-semibold text-text-strong flex items-center gap-2">
        結構化摘要
      </h3>
      {sections.map(({ key, label, icon }) => {
        const content = paper[key];
        if (!content) return null;
        return (
          <div key={key}>
            <h4 className="cr-mono text-[11px] tracking-wide uppercase font-medium text-faint mb-1.5 flex items-center gap-1">
              {icon} {label}
            </h4>
            <p className="text-[13.5px] text-text leading-relaxed">{content}</p>
          </div>
        );
      })}
    </div>
  );
}
