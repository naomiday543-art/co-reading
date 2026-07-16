import React, { useState, useRef } from 'react';
import { useStore } from '../store';
import { papersApi } from '../api';

export default function UploadZone({ onUploaded }) {
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState([]);
  const fileInputRef = useRef(null);

  const handleFiles = async (files) => {
    if (!files.length) return;
    setUploading(true);
    setProgress(Array.from(files).map(f => ({ name: f.name, status: 'uploading' })));

    try {
      const selectedNode = useStore.getState().selectedTreeNode;
      const treeNodeId = selectedNode && selectedNode !== '__none' ? selectedNode : undefined;
      const results = await papersApi.upload(files, treeNodeId);

      // Update progress with results
      setProgress(prev => prev.map((p, i) => {
        const r = Array.isArray(results) ? results[i] : results;
        return { ...p, status: r?.analyze_status === 'error' ? 'error' : 'done', id: r?.id };
      }));
    } catch (err) {
      setProgress(prev => prev.map(p => ({ ...p, status: 'error' })));
    }

    onUploaded();
    setTimeout(() => {
      setUploading(false);
      setProgress([]);
    }, 2000);
  };

  return (
    <div
      className={`cr-uploadzone m-6 mt-0 rounded-xl border-[1.5px] border-dashed transition-colors ${dragOver ? 'border-accent bg-accent-soft' : 'border-border bg-surface-alt'}`}
      onDragOver={e => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={e => {
        e.preventDefault();
        setDragOver(false);
        handleFiles(e.dataTransfer.files);
      }}
      onClick={() => fileInputRef.current?.click()}
    >
      <div className="flex items-center justify-center gap-3.5 py-4 px-5 cursor-pointer">
        {uploading ? (
          <div className="flex flex-wrap gap-3">
            {progress.map((p, i) => (
              <div key={i} className="flex items-center gap-2 text-sm text-muted">
                <span>{p.status === 'uploading' ? '…' : p.status === 'done' ? '✓' : '✕'}</span>
                <span className="truncate max-w-[200px]">{p.name}</span>
              </div>
            ))}
          </div>
        ) : (
          <>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="text-faint"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M17 8l-5-5-5 5" /><path d="M12 3v12" /></svg>
            <p className="text-[13px] text-muted">
              將 PDF 拖拽到此處上傳，或 <span className="text-accent hover:underline">點擊選擇文件</span> · 支援批次匯入
            </p>
          </>
        )}
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf"
        multiple
        className="hidden"
        onChange={e => { handleFiles(e.target.files); e.target.value = ''; }}
      />
    </div>
  );
}
