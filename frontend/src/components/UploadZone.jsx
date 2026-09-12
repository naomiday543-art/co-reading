import React, { useState, useRef, useEffect, useMemo } from 'react';

// 在巢狀樹裡找節點，順便回傳祖先路徑（用來標「方向 / 子分類」）。
function findNode(nodes, id, path = []) {
  for (const n of nodes || []) {
    if (n.id === id) return { node: n, path };
    const hit = findNode(n.children, id, [...path, n]);
    if (hit) return hit;
  }
  return null;
}
import { useStore } from '../store';
import { papersApi } from '../api';

export default function UploadZone({ onUploaded }) {
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState([]);
  const fileInputRef = useRef(null);

  // 上傳時選方向（工單 07 §3.4）：頂層節點才是方向。
  // 一個方向都沒有時**不顯示** select，行為與工單 07 之前完全相同。
  const tree = useStore(s => s.tree);
  const selectedTreeNode = useStore(s => s.selectedTreeNode);
  const directions = tree || [];
  const [directionChoice, setDirectionChoice] = useState('');

  // 預設 = 側欄當前選的節點（不論頂層或子分類），跟工單 07 之前的行為一致；
  // 子分類不在方向清單裡，就多列一個「方向 / 子分類」選項並預選它，
  // 這樣她側欄選著子分類上傳，論文還是掛到那個子分類，不會退化成「先不歸類」。
  const selectedInfo = useMemo(
    () => (selectedTreeNode && selectedTreeNode !== '__none' ? findNode(tree, selectedTreeNode) : null),
    [tree, selectedTreeNode]
  );
  const subNodeOption = selectedInfo && selectedInfo.path.length > 0
    ? { id: selectedInfo.node.id, label: [...selectedInfo.path.map(p => p.name), selectedInfo.node.name].join(' / ') }
    : null;
  useEffect(() => {
    setDirectionChoice(selectedInfo ? selectedInfo.node.id : '');
  }, [selectedInfo]);

  const handleFiles = async (files) => {
    if (!files.length) return;
    setUploading(true);
    setProgress(Array.from(files).map(f => ({ name: f.name, status: 'uploading' })));

    try {
      const hasDirections = (useStore.getState().tree || []).length > 0;
      let treeNodeId;
      if (hasDirections) {
        treeNodeId = directionChoice || undefined;
      } else {
        const selectedNode = useStore.getState().selectedTreeNode;
        treeNodeId = selectedNode && selectedNode !== '__none' ? selectedNode : undefined;
      }
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
            {directions.length > 0 && (
              <div
                className="flex items-center gap-1.5"
                onClick={e => e.stopPropagation()}
              >
                <span className="text-[12.5px] text-faint">這篇屬於：</span>
                <select
                  className="text-[12.5px] border border-border rounded-lg bg-surface px-2 py-1 text-text cursor-pointer focus:outline-none focus:border-accent"
                  value={directionChoice}
                  onChange={e => setDirectionChoice(e.target.value)}
                >
                  <option value="">先不歸類</option>
                  {directions.map(d => (
                    <option key={d.id} value={d.id}>{d.name}</option>
                  ))}
                  {subNodeOption && (
                    <option value={subNodeOption.id}>{subNodeOption.label}（子分類）</option>
                  )}
                </select>
              </div>
            )}
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
