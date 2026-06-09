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
      className={`border-t-2 border-dashed transition-colors ${dragOver ? 'border-primary bg-primary/5' : 'border-gray-300 bg-gray-50'}`}
      onDragOver={e => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={e => {
        e.preventDefault();
        setDragOver(false);
        handleFiles(e.dataTransfer.files);
      }}
      onClick={() => fileInputRef.current?.click()}
    >
      <div className="flex items-center justify-center py-3 px-4 cursor-pointer">
        {uploading ? (
          <div className="flex flex-wrap gap-3">
            {progress.map((p, i) => (
              <div key={i} className="flex items-center gap-2 text-sm text-gray-600">
                <span>{p.status === 'uploading' ? '⏳' : p.status === 'done' ? '✅' : '❌'}</span>
                <span className="truncate max-w-[200px]">{p.name}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-gray-500">
            將 PDF 拖拽到此處上傳，或 <span className="text-primary hover:underline">點擊選擇文件</span>
          </p>
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
