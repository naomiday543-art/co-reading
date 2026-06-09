import React from 'react';

const sections = [
  { key: 'summary_bg', label: '背景', icon: '🔬' },
  { key: 'summary_methods', label: '方法', icon: '⚙️' },
  { key: 'summary_results', label: '結果', icon: '📊' },
  { key: 'summary_conclusions', label: '結論', icon: '💡' },
  { key: 'summary_limitations', label: '局限', icon: '⚠️' },
];

export default function SummaryView({ paper }) {
  const hasSummary = paper.summary_bg || paper.summary_methods || paper.summary_results
    || paper.summary_conclusions || paper.summary_limitations;

  if (!hasSummary) {
    if (paper.analyze_status === 'analyzing') {
      return (
        <div className="flex items-center justify-center py-12 text-gray-500">
          <div className="text-center">
            <div className="flex gap-1 justify-center mb-2">
              <span className="w-2 h-2 bg-primary rounded-full typing-dot" />
              <span className="w-2 h-2 bg-primary rounded-full typing-dot" />
              <span className="w-2 h-2 bg-primary rounded-full typing-dot" />
            </div>
            <p className="text-sm">AI 正在通讀論文中...</p>
          </div>
        </div>
      );
    }
    if (paper.analyze_status === 'error') {
      return (
        <div className="text-center py-12">
          <p className="text-sm text-red-500 mb-2">AI 通讀失敗</p>
          <p className="text-xs text-gray-500">{paper.analyze_error}</p>
        </div>
      );
    }
    return (
      <div className="text-center py-12 text-gray-400 text-sm">
        <p>尚未生成 AI 摘要</p>
        <p className="text-xs mt-1">上傳 PDF 後將自動開始通讀</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
        📋 結構化摘要
      </h3>
      {sections.map(({ key, label, icon }) => {
        const content = paper[key];
        if (!content) return null;
        return (
          <div key={key}>
            <h4 className="text-xs font-semibold text-gray-600 mb-1 flex items-center gap-1">
              {icon} {label}
            </h4>
            <p className="text-sm text-gray-700 leading-relaxed">{content}</p>
          </div>
        );
      })}
    </div>
  );
}
