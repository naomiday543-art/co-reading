import React from 'react';

export default function FullTextView({ paper }) {
  // If there's a PDF file, show it directly in an iframe (best reading experience)
  if (paper.pdf_filename) {
    return (
      <div className="flex flex-col h-full">
        <iframe
          src={`/api/papers/${paper.id}/pdf`}
          className="flex-1 w-full border border-border rounded-lg bg-surface"
          title="論文原文"
          style={{ minHeight: '600px' }}
        />
        <p className="text-xs text-faint mt-2 text-center">
          選中文字後，複製貼到右側聊天框即可問 AI
        </p>
      </div>
    );
  }

  // Fallback: plain text extraction (for papers uploaded without PDF, or failed extraction)
  if (!paper.full_text) {
    return (
      <div className="text-center py-12 text-faint text-sm">
        <p>無法顯示原文</p>
        {paper.analyze_error?.includes('掃描版') && (
          <p className="text-xs mt-1">此 PDF 可能是掃描版，未能提取文本</p>
        )}
      </div>
    );
  }

  return (
    <div className="text-sm text-faint text-center py-8">
      <p>原始 PDF 檔案不可用，僅能顯示提取的文字</p>
      <div className="text-left mt-4 space-y-3">
        {paper.full_text.split(/\n{2,}/).filter(p => p.trim()).map((para, i) => (
          <p key={i} className="cr-serif text-[13.5px] text-text leading-relaxed">{para}</p>
        ))}
      </div>
    </div>
  );
}
