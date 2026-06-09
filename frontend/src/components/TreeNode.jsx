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
        className={`flex items-center gap-1 px-2 py-1 rounded cursor-pointer text-sm group ${isSelected ? 'bg-primary/10 text-primary font-medium' : 'hover:bg-gray-100'}`}
        style={{ paddingLeft: `${8 + depth * 16}px` }}
        onClick={() => onSelect(node.id)}
        onContextMenu={(e) => { e.preventDefault(); setShowMenu(!showMenu); }}
      >
        <button
          className="w-4 h-4 flex items-center justify-center text-gray-400 hover:text-gray-600"
          onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
        >
          {hasChildren ? (expanded ? '▾' : '▸') : <span className="w-4" />}
        </button>
        <span className="mr-1">{expanded && hasChildren ? '📂' : '📄'}</span>
        {editing ? (
          <input
            autoFocus
            className="flex-1 text-sm border border-gray-300 rounded px-1 py-0"
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
          <span className="text-xs text-gray-400">{node.paper_count}</span>
        )}

        {/* Context menu trigger */}
        <div className="relative">
          <button
            className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-gray-600 ml-1"
            onClick={(e) => { e.stopPropagation(); setShowMenu(!showMenu); }}
          >
            ⋯
          </button>
          {showMenu && (
            <div className="absolute right-0 top-5 bg-white border border-gray-200 rounded-md shadow-lg z-20 py-1 text-sm min-w-[100px]"
              onClick={e => e.stopPropagation()}>
              <button className="block w-full text-left px-3 py-1 hover:bg-gray-100"
                onClick={() => { setEditing(true); setEditName(node.name); setShowMenu(false); }}>重新命名</button>
              <button className="block w-full text-left px-3 py-1 hover:bg-gray-100"
                onClick={() => { setShowNewChild(true); setShowMenu(false); }}>新增子分類</button>
              <button className="block w-full text-left px-3 py-1 hover:bg-gray-100 text-red-600"
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
            className="flex-1 text-sm border border-gray-300 rounded px-2 py-0.5"
            value={newChildName}
            onChange={e => setNewChildName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleCreateChild(); if (e.key === 'Escape') setShowNewChild(false); }}
            placeholder="子分類名稱"
          />
          <button onClick={handleCreateChild} className="text-xs text-primary hover:underline">確定</button>
        </div>
      )}
    </div>
  );
}
