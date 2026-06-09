import React, { useEffect, useState } from 'react';
import { useStore } from './store';
import { papersApi, tagsApi, treeApi } from './api';
import Sidebar from './components/Sidebar';
import UploadZone from './components/UploadZone';
import Library from './pages/Library';
import PaperDetail from './pages/PaperDetail';
import Settings from './pages/Settings';
import InsightsPanel from './components/InsightsPanel';

export default function App() {
  const [page, setPage] = useState('library');
  const [paperId, setPaperId] = useState(null);
  const { setPapers, setTags, setTree, uploading } = useStore();

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
  };

  return (
    <div className="flex flex-col h-screen">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-2 border-b border-gray-200 bg-white shrink-0">
        <div className="flex items-center gap-3">
          <button
            onClick={() => useStore.getState().toggleSidebar()}
            className="text-gray-500 hover:text-gray-700 p-1"
            title="Toggle sidebar"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <h1
            className="text-lg font-semibold text-primary cursor-pointer"
            onClick={() => navigate('library')}
          >
            Co-Reading
          </h1>
        </div>
        <button
          onClick={() => navigate('settings')}
          className={`p-2 rounded-lg hover:bg-gray-100 ${page === 'settings' ? 'bg-gray-100' : ''}`}
          title="設定"
        >
          <svg className="w-5 h-5 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </button>
      </header>

      {/* Body */}
      <div className="flex flex-1 overflow-hidden">
        {page !== 'settings' && <Sidebar onNavigate={navigate} onRefresh={loadData} />}
        <main className="flex-1 overflow-y-auto p-4 bg-white">
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
