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
      className={`sidebar shrink-0 flex flex-col overflow-hidden relative ${sidebarOpen ? 'border-r border-gray-200' : ''} ${dragging ? '' : 'transition-[width] duration-200'}`}
      style={{ width: sidebarOpen ? width : 0 }}
    >
      {/* Tree Section */}
      <div className="flex-1 overflow-y-auto p-3" style={{ minWidth: MIN_WIDTH }}>
        <div className="text-xs font-semibold text-gray-500 uppercase mb-2">知識樹</div>

        {/* All papers */}
        <div
          className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer text-sm ${!selectedTreeNode && !selectedTag ? 'bg-primary/10 text-primary font-medium' : 'hover:bg-gray-100'}`}
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
          className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer text-sm ${selectedTreeNode === '__none' ? 'bg-primary/10 text-primary font-medium' : 'hover:bg-gray-100'}`}
          onClick={() => { setSelectedTreeNode('__none'); setSelectedTag(null); onNavigate('library'); }}
        >
          
          <span className="flex-1">未分類</span>
        </div>

        {/* New folder */}
        {showNewFolder ? (
          <div className="flex gap-1 mt-1 ml-5">
            <input
              autoFocus
              className="flex-1 text-sm border border-gray-300 rounded px-2 py-0.5"
              value={newFolderName}
              onChange={e => setNewFolderName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleCreateFolder(); if (e.key === 'Escape') setShowNewFolder(false); }}
              placeholder="新資料夾"
            />
            <button onClick={handleCreateFolder} className="text-xs text-primary hover:underline">確定</button>
          </div>
        ) : (
          <button
            onClick={() => setShowNewFolder(true)}
            className="text-xs text-gray-500 hover:text-primary mt-1 ml-5"
          >
            + 新資料夾
          </button>
        )}

        {/* Tags section */}
        <div className="text-xs font-semibold text-gray-500 uppercase mt-4 mb-2">標籤</div>
        {tags.map(tag => (
          <div
            key={tag.id}
            className={`flex items-center gap-2 px-2 py-1 rounded cursor-pointer text-sm ${selectedTag === tag.id ? 'bg-primary/10 text-primary font-medium' : 'hover:bg-gray-100'}`}
            onClick={() => { setSelectedTag(tag.id); setSelectedTreeNode(null); onNavigate('library'); }}
          >
            <span
              className="w-2.5 h-2.5 rounded-full shrink-0"
              style={{ backgroundColor: tag.color }}
            />
            <span className="flex-1 truncate">{tag.name}</span>
          </div>
        ))}
        {tags.length === 0 && (
          <p className="text-xs text-gray-400 ml-2">尚無標籤</p>
        )}

        {/* Insights section */}
        <div className="text-xs font-semibold text-gray-500 uppercase mt-4 mb-2">洞察</div>
        <div
          className="flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer text-sm hover:bg-gray-100"
          onClick={() => onNavigate('insights')}
        >
          
          <span className="flex-1">所有洞察</span>
        </div>
      </div>

      {/* Drag handle for resizing */}
      {sidebarOpen && (
        <div
          className="absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-primary/30 active:bg-primary/50"
          onMouseDown={startDrag}
        />
      )}
    </aside>
  );
}
