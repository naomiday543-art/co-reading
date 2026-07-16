import React, { useState } from 'react';
import { treeApi } from '../api';
import { useStore } from '../store';

export default function TreeNode({ node, depth, selectedId, onSelect, onRefresh }) {
  const [expanded, setExpanded] = useState(depth < 2);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(node.name);
  const [showNewChild, setShowNewChild] = useState(false);
  const [newChildName, setNewChildName] = useState('');
  const [showMenu, setShowMenu] = useState(false);

  const hasChildren = node.children && node.children.length > 0;
  const isSelected = selectedId === node.id;

  const handleRename = async () => {
    if (editName.trim() && editName.trim() !== node.name) {
      await treeApi.update(node.id, { name: editName.trim() });
      onRefresh();
    }
    setEditing(false);
  };

  const handleDelete = async () => {
    if (confirm(`確定要刪除「${node.name}」嗎？`)) {
      await treeApi.delete(node.id);
      const t = await treeApi.get();
      useStore.getState().setTree(t);
      onRefresh();
    }
  };

  const handleCreateChild = async () => {
    if (!newChildName.trim()) return;
    await treeApi.create(newChildName.trim(), node.id);
    setNewChildName('');
    setShowNewChild(false);
    setExpanded(true);
    const t = await treeApi.get();
    useStore.getState().setTree(t);
    onRefresh();
  };

  return (
    <div className="select-none">
      <div
        className={`flex items-center gap-1 px-2.5 py-2 rounded-lg cursor-pointer text-[13.5px] group transition-colors ${isSelected ? 'bg-surface-alt text-text-strong font-medium' : 'text-text hover:bg-surface-hover'}`}
        style={{ paddingLeft: `${8 + depth * 16}px` }}
        onClick={() => onSelect(node.id)}
        onContextMenu={(e) => { e.preventDefault(); setShowMenu(!showMenu); }}
      >
        <button
          className="w-4 h-4 flex items-center justify-center text-faint hover:text-muted"
          onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
        >
          {hasChildren ? (expanded ? '▾' : '▸') : <span className="w-4" />}
        </button>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-faint"><path d="M3 7h6l2 2h10v10H3z" /></svg>
        {editing ? (
          <input
            autoFocus
            className="flex-1 text-sm border border-border bg-surface rounded px-1 py-0"
            value={editName}
            onChange={e => setEditName(e.target.value)}
            onBlur={handleRename}
            onKeyDown={e => { if (e.key === 'Enter') handleRename(); if (e.key === 'Escape') { setEditing(false); setEditName(node.name); } }}
            onClick={e => e.stopPropagation()}
          />
        ) : (
          <span className="flex-1 truncate">{node.name}</span>
        )}
        {node.paper_count > 0 && (
          <span className="cr-mono text-[11px] text-faint">{node.paper_count}</span>
        )}

        {/* Context menu trigger */}
        <div className="relative">
          <button
            className="opacity-0 group-hover:opacity-100 text-faint hover:text-muted ml-1"
            onClick={(e) => { e.stopPropagation(); setShowMenu(!showMenu); }}
          >
            ⋯
          </button>
          {showMenu && (
            <div className="absolute right-0 top-5 bg-surface border border-border rounded-lg shadow-lg z-20 py-1 text-sm min-w-[100px]"
              onClick={e => e.stopPropagation()}>
              <button className="block w-full text-left px-3 py-1.5 hover:bg-surface-hover"
                onClick={() => { setEditing(true); setEditName(node.name); setShowMenu(false); }}>重新命名</button>
              <button className="block w-full text-left px-3 py-1.5 hover:bg-surface-hover"
                onClick={() => { setShowNewChild(true); setShowMenu(false); }}>新增子分類</button>
              <button className="block w-full text-left px-3 py-1.5 hover:bg-surface-hover text-danger"
                onClick={handleDelete}>刪除</button>
            </div>
          )}
        </div>
      </div>

      {/* Children */}
      {expanded && hasChildren && node.children.map(child => (
        <TreeNode
          key={child.id}
          node={child}
          depth={depth + 1}
          selectedId={selectedId}
          onSelect={onSelect}
          onRefresh={onRefresh}
        />
      ))}

      {/* New child input */}
      {showNewChild && (
        <div className="flex gap-1 ml-2 mt-1" style={{ paddingLeft: `${8 + (depth + 1) * 16}px` }}>
          <input
            autoFocus
            className="flex-1 text-sm border border-border bg-surface rounded px-2 py-0.5"
            value={newChildName}
            onChange={e => setNewChildName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleCreateChild(); if (e.key === 'Escape') setShowNewChild(false); }}
            placeholder="子分類名稱"
          />
          <button onClick={handleCreateChild} className="text-xs text-accent hover:underline">確定</button>
        </div>
      )}
    </div>
  );
}
