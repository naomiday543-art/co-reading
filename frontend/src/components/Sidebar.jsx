import React, { useState, useRef } from 'react';
import { useStore } from '../store';
import { treeApi, papersApi, tagsApi } from '../api';
import TreeNode from './TreeNode';

const MIN_WIDTH = 160;
const MAX_WIDTH = 480;
const DEFAULT_WIDTH = 240;

export default function Sidebar({ onNavigate, onRefresh }) {
  const { tree, tags, selectedTreeNode, selectedTag, setSelectedTreeNode, setSelectedTag, sidebarOpen } = useStore();
  const [newFolderName, setNewFolderName] = useState('');
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem('sidebarWidth'));
    return saved >= MIN_WIDTH && saved <= MAX_WIDTH ? saved : DEFAULT_WIDTH;
  });
  const [dragging, setDragging] = useState(false);
  const lastWidth = useRef(width);

  const startDrag = (e) => {
    e.preventDefault();
    setDragging(true);
    const onMove = (ev) => {
      const w = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, ev.clientX));
      lastWidth.current = w;
      setWidth(w);
    };
    const onUp = () => {
      setDragging(false);
      localStorage.setItem('sidebarWidth', String(lastWidth.current));
      document.removeEventListener('mousemove', onMove);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp, { once: true });
  };

  const handleCreateFolder = async () => {
    if (!newFolderName.trim()) return;
    await treeApi.create(newFolderName.trim());
    setNewFolderName('');
    setShowNewFolder(false);
    const t = await treeApi.get();
    useStore.getState().setTree(t);
  };

  const filteredCount = (nodeId) => {
    // count papers belonging to this node or descendants
    const countNode = (nodes, id) => {
      for (const n of nodes) {
        if (n.id === id) {
          let total = n.paper_count || 0;
          for (const c of n.children || []) {
            total += countPapers(c);
          }
          return total;
        }
        const found = countNode(n.children || [], id);
        if (found >= 0) return found;
      }
      return 0;
    };
    return countNode(tree, nodeId);
  };

  const countPapers = (node) => {
    let total = node.paper_count || 0;
    for (const c of node.children || []) {
      total += countPapers(c);
    }
    return total;
  };

  return (
    <aside
      className={`shrink-0 flex flex-col overflow-hidden relative bg-bg-tint ${sidebarOpen ? 'border-r border-border-soft' : ''} ${dragging ? '' : 'transition-[width] duration-200'}`}
      style={{ width: sidebarOpen ? width : 0 }}
    >
      {/* Tree Section */}
      <div className="flex-1 overflow-y-auto p-4" style={{ minWidth: MIN_WIDTH }}>
        <div className="cr-mono text-[10.5px] font-medium tracking-[0.14em] text-faint uppercase px-2 mb-2">知識樹</div>

        {/* All papers */}
        <div
          className={`flex items-center gap-2 px-2.5 py-2 rounded-lg cursor-pointer text-[13.5px] transition-colors ${!selectedTreeNode && !selectedTag ? 'bg-surface-alt text-text-strong font-medium' : 'text-text hover:bg-surface-hover'}`}
          onClick={() => { setSelectedTreeNode(null); setSelectedTag(null); onNavigate('library'); }}
        >
          <span className="flex-1">全部論文</span>
        </div>

        {/* Tree nodes */}
        {tree.map(node => (
          <TreeNode
            key={node.id}
            node={node}
            depth={0}
            selectedId={selectedTreeNode}
            onSelect={(id) => { setSelectedTreeNode(id); setSelectedTag(null); onNavigate('library'); }}
            onRefresh={async () => {
              const t = await treeApi.get();
              useStore.getState().setTree(t);
              onRefresh();
            }}
          />
        ))}

        {/* Uncategorized */}
        <div
          className={`flex items-center gap-2 px-2.5 py-2 rounded-lg cursor-pointer text-[13.5px] transition-colors ${selectedTreeNode === '__none' ? 'bg-surface-alt text-text-strong font-medium' : 'text-text hover:bg-surface-hover'}`}
          onClick={() => { setSelectedTreeNode('__none'); setSelectedTag(null); onNavigate('library'); }}
        >
          <span className="flex-1">未分類</span>
        </div>

        {/* New folder */}
        {showNewFolder ? (
          <div className="flex gap-1 mt-1 ml-5">
            <input
              autoFocus
              className="flex-1 text-sm border border-border rounded-lg bg-surface px-2 py-0.5"
              value={newFolderName}
              onChange={e => setNewFolderName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleCreateFolder(); if (e.key === 'Escape') setShowNewFolder(false); }}
              placeholder="新資料夾"
            />
            <button onClick={handleCreateFolder} className="text-xs text-accent hover:underline">確定</button>
          </div>
        ) : (
          <button
            onClick={() => setShowNewFolder(true)}
            className="flex items-center gap-2 px-2.5 py-2 rounded-lg text-[13px] text-faint hover:bg-surface-hover hover:text-text w-full transition-colors"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
            <span>新資料夾</span>
          </button>
        )}

        {/* Tags section */}
        <div className="cr-mono text-[10.5px] font-medium tracking-[0.14em] text-faint uppercase px-2 mt-5 mb-2">標籤</div>
        <div className="flex flex-wrap gap-1.5 px-1">
        {tags.map(tag => (
          <span
            key={tag.id}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full cursor-pointer text-xs border transition-colors ${selectedTag === tag.id ? 'bg-accent-soft text-accent border-transparent font-medium' : 'bg-surface text-text border-border-soft hover:bg-surface-hover'}`}
            onClick={() => { setSelectedTag(tag.id); setSelectedTreeNode(null); onNavigate('library'); }}
          >
            <span
              className="w-2 h-2 rounded-full shrink-0"
              style={{ backgroundColor: tag.color }}
            />
            <span className="truncate max-w-[120px]">{tag.name}</span>
          </span>
        ))}
        {tags.length === 0 && (
          <p className="text-xs text-faint px-1">尚無標籤</p>
        )}
        </div>

        {/* Insights section */}
        <div className="cr-mono text-[10.5px] font-medium tracking-[0.14em] text-faint uppercase px-2 mt-5 mb-2">洞察</div>
        <div
          className="flex items-center gap-2 px-2.5 py-2 rounded-lg cursor-pointer text-[13.5px] text-text hover:bg-surface-hover transition-colors"
          onClick={() => onNavigate('insights')}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="8" /><path d="M12 8v4l3 2" /></svg>
          <span className="flex-1">所有洞察</span>
        </div>
      </div>

      {/* Drag handle for resizing */}
      {sidebarOpen && (
        <div
          className="absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-accent-soft active:bg-accent-soft"
          onMouseDown={startDrag}
        />
      )}
    </aside>
  );
}
