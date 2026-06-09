import React from 'react';

export default function TagBadge({ tag, small, onRemove, onClick }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full text-xs font-medium cursor-pointer hover:opacity-80 ${small ? 'px-1.5 py-0.5' : 'px-2 py-0.5'}`}
      style={{ backgroundColor: tag.color + '20', color: tag.color, border: `1px solid ${tag.color}40` }}
      onClick={onClick}
      title={tag.name}
    >
      {tag.name}
      {onRemove && (
        <button
          className="hover:opacity-60 text-xs leading-none"
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
        >
          ×
        </button>
      )}
    </span>
  );
}
