import React, { useEffect, useState } from 'react';
import { useStore } from './store';
import { papersApi, tagsApi, treeApi } from './api';
import Sidebar from './components/Sidebar';
import UploadZone from './components/UploadZone';
import Library from './pages/Library';
import PaperDetail from './pages/PaperDetail';
import Settings from './pages/Settings';
import InsightsPanel from './components/InsightsPanel';

const NAV_STORAGE_KEY = 'co-reading:nav';

function loadStoredNav() {
  try {
    const raw = sessionStorage.getItem(NAV_STORAGE_KEY);
    if (!raw) return { page: 'library', paperId: null };
    return JSON.parse(raw);
  } catch {
    return { page: 'library', paperId: null };
  }
}

function loadStoredTheme() {
  try {
    const saved = localStorage.getItem('co-reading:theme');
    if (saved === 'dark' || saved === 'light') return saved;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export default function App() {
  const initialNav = loadStoredNav();
  const [page, setPage] = useState(initialNav.page);
  const [paperId, setPaperId] = useState(initialNav.paperId);
  const [isFullscreen, setIsFullscreen] = useState(!!document.fullscreenElement);
  const [theme, setTheme] = useState(loadStoredTheme);
  const { setPapers, setTags, setTree, uploading } = useStore();

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('co-reading:theme', theme); } catch {}
  }, [theme]);

  const toggleTheme = () => setTheme(t => (t === 'dark' ? 'light' : 'dark'));

  const loadData = async () => {
    try {
      const [papers, tags, tree] = await Promise.all([
        papersApi.list({}),
        tagsApi.list(),
        treeApi.get(),
      ]);
      setPapers(papers);
      setTags(tags);
      setTree(tree);
    } catch (err) {
      console.error('Failed to load data:', err);
    }
  };

  useEffect(() => { loadData(); }, []);

  const navigate = (p, id) => {
    setPage(p);
    setPaperId(id || null);
    sessionStorage.setItem(NAV_STORAGE_KEY, JSON.stringify({ page: p, paperId: id || null }));
  };

  useEffect(() => {
    const onFullscreenChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      document.documentElement.requestFullscreen();
    }
  };

  return (
    <div className="flex flex-col h-screen bg-bg text-text">
      {/* Header */}
      <header className="flex items-center justify-between px-5 py-2.5 border-b border-border-soft bg-bg-tint shrink-0">
        <div className="flex items-center gap-3">
          <button
            onClick={() => useStore.getState().toggleSidebar()}
            className="text-muted hover:text-text-strong p-1 rounded-lg hover:bg-surface-hover transition-colors"
            title="Toggle sidebar"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <div
            className="flex items-center gap-2.5 cursor-pointer"
            onClick={() => navigate('library')}
          >
            <div className="w-8 h-8 rounded-lg bg-accent text-accent-fg flex items-center justify-center cr-serif font-semibold text-[17px]">C</div>
            <div className="leading-tight">
              <div className="cr-serif font-semibold text-[15px] text-text-strong">Co-Reading</div>
              <div className="cr-serif italic text-[11px] text-muted -mt-0.5">共讀</div>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={toggleTheme}
            className="p-2 rounded-lg hover:bg-surface-hover text-muted hover:text-text-strong transition-colors"
            title={theme === 'dark' ? '切換淺色' : '切換深色'}
          >
            {theme === 'dark' ? (
              <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
                <circle cx="12" cy="12" r="4" />
                <path strokeLinecap="round" d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
              </svg>
            ) : (
              <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z" />
              </svg>
            )}
          </button>
          <button
            onClick={toggleFullscreen}
            className="p-2 rounded-lg hover:bg-surface-hover text-muted hover:text-text-strong transition-colors"
            title={isFullscreen ? '離開全螢幕' : '全螢幕'}
          >
            {isFullscreen ? (
              <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 9V4.5M9 9H4.5M9 9L3.75 3.75M15 9h4.5M15 9V4.5M15 9l5.25-5.25M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 15h4.5M15 15v4.5m0-4.5l5.25 5.25" />
              </svg>
            ) : (
              <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 8V4.5A.5.5 0 014.5 4H8m8 0h3.5a.5.5 0 01.5.5V8m0 8v3.5a.5.5 0 01-.5.5H16m-8 0H4.5a.5.5 0 01-.5-.5V16" />
              </svg>
            )}
          </button>
          <button
            onClick={() => navigate('settings')}
            className={`p-2 rounded-lg hover:bg-surface-hover text-muted hover:text-text-strong transition-colors ${page === 'settings' ? 'bg-surface-alt text-text-strong' : ''}`}
            title="設定"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.7} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>
        </div>
      </header>

      {/* Body */}
      <div className="flex flex-1 overflow-hidden">
        {page !== 'settings' && <Sidebar onNavigate={navigate} onRefresh={loadData} />}
        <main className="flex-1 overflow-y-auto p-6 bg-bg">
          {page === 'library' && <Library onNavigate={navigate} onRefresh={loadData} />}
          {page === 'detail' && <PaperDetail paperId={paperId} onBack={() => navigate('library')} />}
          {page === 'insights' && <InsightsPanel onNavigate={navigate} />}
          {page === 'settings' && <Settings />}
        </main>
      </div>

      {/* Upload zone - always visible in library */}
      {page !== 'settings' && !uploading && (
        <UploadZone onUploaded={loadData} />
      )}
    </div>
  );
}
