import React, { useEffect, useRef, useState } from 'react';
import { useStore } from './store';
import { papersApi, tagsApi, treeApi } from './api';
import Sidebar from './components/Sidebar';
import UploadZone from './components/UploadZone';
import Library from './pages/Library';
import PaperDetail from './pages/PaperDetail';
import Settings from './pages/Settings';
import Compare from './pages/Compare';
import Progress from './pages/Progress';
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
  const { setPapers, setTags, setTree, uploading, readingMode } = useStore();

  // 工單 26 §D1：論文頁的頂列＝全域頂欄與論文標題列合併成一行（52px）。
  // 中段與最右兩個插槽是 DOM node，用 useState 存（節點就位要觸發重渲染，PaperDetail
  // 才拿得到它去 createPortal）——同工單 24b 的 controlsSlot 作法。
  // 兩個插槽都是 null 時 PaperDetail 會退回自己那條 cr-detail-topbar，功能一顆不少。
  const [headerMainSlot, setHeaderMainSlot] = useState(null);
  const [headerEndSlot, setHeaderEndSlot] = useState(null);
  // 工單 26 §D6：上傳細條收成頂列的一顆 ⬆ 鈕。鈕在這裡、檔案選擇器在 UploadZone，
  // 中間走 ref；上傳進度回報到這裡讓鈕轉圈＋title 寫進度。
  const uploadRef = useRef(null);
  const [uploadStatus, setUploadStatus] = useState({ uploading: false, progress: [] });

  // 閱讀模式只在論文頁生效：sidebar 收起、main 去掉 padding。
  // Library / 洞察 / 設定完全不讀它（工單 06 §3.1）。
  const detailReading = page === 'detail' && readingMode;

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

  // 三顆圖示鈕的 svg 在兩種頂欄裡共用（大小不同而已）——兩份 copy 遲早會走鐘
  const themeIcon = (cls) => (theme === 'dark' ? (
    <svg className={cls} fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="4" />
      <path strokeLinecap="round" d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  ) : (
    <svg className={cls} fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z" />
    </svg>
  ));
  const fullscreenIcon = (cls) => (isFullscreen ? (
    <svg className={cls} fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 9V4.5M9 9H4.5M9 9L3.75 3.75M15 9h4.5M15 9V4.5M15 9l5.25-5.25M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 15h4.5M15 15v4.5m0-4.5l5.25 5.25" />
    </svg>
  ) : (
    <svg className={cls} fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 8V4.5A.5.5 0 014.5 4H8m8 0h3.5a.5.5 0 01.5.5V8m0 8v3.5a.5.5 0 01-.5.5H16m-8 0H4.5a.5.5 0 01-.5-.5V16" />
    </svg>
  ));
  const settingsIcon = (cls) => (
    <svg className={cls} fill="none" stroke="currentColor" strokeWidth={1.7} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  );

  // 頂列（detail 變體）的 28×28 圖示鈕
  const hdrBtn = 'w-7 h-7 shrink-0 flex items-center justify-center rounded-md text-muted hover:bg-surface-hover hover:text-text-strong transition-colors';
  const uploadCount = uploadStatus.progress?.length || 0;
  const uploadDone = (uploadStatus.progress || []).filter(p => p.status !== 'uploading').length;

  return (
    <div className="flex flex-col h-screen bg-bg text-text">
      {/* 工單 26 §D1：論文頁的頂列——全域頂欄與論文標題列合併成一行 52px。
          其他頁面（論文庫／對比／進度／洞察／設定）的 header 完全沒動。 */}
      {page === 'detail' ? (
        <header
          className="cr-detail-header flex items-center gap-2 shrink-0"
          style={{ height: 52, padding: '0 10px', background: 'var(--surface)', borderBottom: '1px solid var(--border)', position: 'relative', zIndex: 30 }}
        >
          <button
            onClick={() => useStore.getState().toggleSidebar()}
            className={hdrBtn}
            title="Toggle sidebar"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M2 4h12M2 8h12M2 12h12" /></svg>
          </button>
          <div
            className="cr-hdr-brand w-[22px] h-[22px] shrink-0 rounded-md bg-accent text-accent-fg flex items-center justify-center cr-serif font-bold text-[12px] cursor-pointer"
            onClick={() => navigate('library')}
            title="回論文庫"
          >
            C
          </div>
          <div className="cr-hdr-brand w-px h-[18px] bg-border shrink-0 mx-0.5" />

          {/* ‹ 返回列表／閱讀模式／標題／閱讀狀態：PaperDetail portal 進來 */}
          <div ref={setHeaderMainSlot} className="flex-1 min-w-0 flex items-center gap-2" />

          <div className="flex items-center gap-0.5 shrink-0">
            <button
              onClick={() => uploadRef.current?.open()}
              className={hdrBtn}
              disabled={uploadStatus.uploading}
              title={uploadStatus.uploading
                ? `上傳中… ${uploadDone}/${uploadCount}`
                : '上傳 PDF 到論文庫（也可直接把檔案拖進視窗）'}
            >
              {uploadStatus.uploading ? (
                <svg className="cr-spin" width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M8 1.6a6.4 6.4 0 1 0 6.4 6.4" /></svg>
              ) : (
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M8 11V3.5M5 6.5L8 3.5l3 3M3 11.5v1.5h10v-1.5" /></svg>
              )}
            </button>
            <button onClick={toggleTheme} className={hdrBtn} title={theme === 'dark' ? '切換淺色' : '切換深色'}>
              {themeIcon('w-[15px] h-[15px]')}
            </button>
            <button onClick={toggleFullscreen} className={hdrBtn} title={isFullscreen ? '離開全螢幕' : '全螢幕'}>
              {fullscreenIcon('w-[15px] h-[15px]')}
            </button>
            <button onClick={() => navigate('settings')} className={hdrBtn} title="設定">
              {settingsIcon('w-[15px] h-[15px]')}
            </button>
            <div className="w-px h-4 bg-border shrink-0 mx-[3px]" />
            {/* 刪除這篇論文：PaperDetail portal 進來 */}
            <div ref={setHeaderEndSlot} className="flex items-center shrink-0" />
          </div>
        </header>
      ) : (
      /* Header */
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
            {themeIcon('w-5 h-5')}
          </button>
          <button
            onClick={toggleFullscreen}
            className="p-2 rounded-lg hover:bg-surface-hover text-muted hover:text-text-strong transition-colors"
            title={isFullscreen ? '離開全螢幕' : '全螢幕'}
          >
            {fullscreenIcon('w-5 h-5')}
          </button>
          <button
            onClick={() => navigate('settings')}
            className={`p-2 rounded-lg hover:bg-surface-hover text-muted hover:text-text-strong transition-colors ${page === 'settings' ? 'bg-surface-alt text-text-strong' : ''}`}
            title="設定"
          >
            {settingsIcon('w-5 h-5')}
          </button>
        </div>
      </header>
      )}

      {/* Body */}
      <div className="flex flex-1 overflow-hidden">
        {page !== 'settings' && !detailReading && <Sidebar onNavigate={navigate} onRefresh={loadData} />}
        {/* 工單 26 §D3：論文詳情頁的 padding 歸零——工作列自己吃滿寬，分欄區自己留 10px，
            兩欄的左右邊界才會跟工作列的切點落在同一條垂直線上。其他頁面照舊 p-6。 */}
        <main className={`cr-main flex-1 overflow-y-auto bg-bg ${page === 'detail' ? 'p-0' : 'p-6'}${detailReading ? ' cr-main--reading' : ''}`}>
          {page === 'library' && <Library onNavigate={navigate} onRefresh={loadData} />}
          {page === 'detail' && (
            <PaperDetail
              paperId={paperId}
              onBack={() => navigate('library')}
              onNavigate={navigate}
              headerMainSlot={headerMainSlot}
              headerEndSlot={headerEndSlot}
            />
          )}
          {/* 摘要對比（工單 09 §3.3）：sidebar 照常，不進 mobile tabbar */}
          {page === 'compare' && <Compare onNavigate={navigate} />}
          {/* 研究進度圖（工單 21）：一個方向一張，唯讀 */}
          {page === 'progress' && <Progress onNavigate={navigate} />}
          {page === 'insights' && <InsightsPanel onNavigate={navigate} />}
          {page === 'settings' && <Settings />}
        </main>
      </div>

      {/* Upload zone - always visible in library */}
      {/* 工單 25：論文庫是主要的上傳場景，靶要大；對比／進度圖／洞察用細條版。
          工單 26 §D6：**論文詳情頁改成 overlay 版**——畫面上一條都不佔，入口是頂列那顆
          ⬆ 鈕，拖檔案進視窗時整頁才變成拖放層。那 38px 全還給 PDF 與討論。 */}
      {page === 'detail' && (
        <UploadZone
          ref={uploadRef}
          onUploaded={loadData}
          variant="overlay"
          onStatus={setUploadStatus}
        />
      )}
      {page !== 'settings' && page !== 'detail' && !uploading && (
        <UploadZone onUploaded={loadData} compact={page !== 'library'} />
      )}

      {/* Mobile bottom tab bar (<=767px, mirrors header nav) */}
      <nav className="cr-tabbar">
        {[
          { key: 'library', label: '論文', path: 'M3 7h18M3 12h18M3 17h12' },
          { key: 'insights', label: '洞察', path: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM12 8v4l3 2', circle: true },
          { key: 'settings', label: '設定', gear: true },
        ].map(item => {
          const active = page === item.key || (item.key === 'library' && page === 'detail');
          return (
            <button
              key={item.key}
              onClick={() => navigate(item.key)}
              className={`flex-1 flex flex-col items-center justify-center gap-1 text-[10.5px] ${active ? 'text-accent font-medium' : 'text-muted'}`}
            >
              {item.gear ? (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
              ) : item.circle ? (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="8" /><path d="M12 8v4l3 2" /></svg>
              ) : (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={item.path} /></svg>
              )}
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}
