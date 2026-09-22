import React, { useState, useRef, useEffect, useMemo, forwardRef, useImperativeHandle } from 'react';

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

// compact：細條版（工單 25）。論文庫以外的頁面都用它——那些頁面的垂直空間要留給
// PDF／討論／進度圖；拖放上傳在那裡是次要動作，靶不用那麼大。功能一樣不少。
//
// variant="overlay"（工單 26 §D6，論文詳情頁用）：**一條都不畫**。上傳入口收成頂列
// 右側那顆 ⬆ 鈕（App 透過 ref 叫 open()），把檔案拖進視窗時整個畫面才變成拖放層。
// 這樣閱讀頁最底下那 38px 全部還給 PDF 與討論；選檔／批次／方向／失敗回報一個不少。
const UploadZone = forwardRef(function UploadZone(
  { onUploaded, compact = false, variant = 'strip', onStatus },
  ref,
) {
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState([]);
  // 全視窗拖放層（overlay 版）：dragleave 會在子元素之間亂跳，所以用進出計數，
  // 歸零才收層。drop／dragend 一律強制歸零，免得層卡在畫面上擋住整頁。
  const [dropActive, setDropActive] = useState(false);
  // 上傳完才報的失敗檔名（4 秒後自己消失）——細條沒了，失敗不能跟著靜悄悄。
  const [failedNames, setFailedNames] = useState([]);
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
    setFailedNames([]);
    let items = Array.from(files).map(f => ({ name: f.name, status: 'uploading' }));
    setProgress(items);

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
      items = items.map((p, i) => {
        const r = Array.isArray(results) ? results[i] : results;
        return { ...p, status: r?.analyze_status === 'error' ? 'error' : 'done', id: r?.id };
      });
    } catch (err) {
      items = items.map(p => ({ ...p, status: 'error' }));
    }
    setProgress(items);

    // overlay 版沒有細條可以顯示那排 ✓／✕，失敗的檔名改用頂列下方的小提示講出來。
    if (variant === 'overlay') {
      const failed = items.filter(p => p.status === 'error').map(p => p.name);
      if (failed.length > 0) setFailedNames(failed);
    }

    onUploaded();
    setTimeout(() => {
      setUploading(false);
      setProgress([]);
    }, 2000);
  };

  // 讓 App 的 ⬆ 鈕開得了檔案選擇器（工單 26 §D6）
  useImperativeHandle(ref, () => ({
    open: () => fileInputRef.current?.click(),
  }), []);

  // 給頂列那顆 ⬆ 鈕用的狀態（轉圈＋title 寫進度）。onStatus 是 App 的 setState，
  // 身分穩定，所以不放進 deps——放進去會變成每次 render 都重跑。
  useEffect(() => {
    if (variant !== 'overlay') return;
    onStatus?.({ uploading, progress });
  }, [variant, uploading, progress]);   // eslint-disable-line react-hooks/exhaustive-deps

  // 失敗提示 4 秒後自己收掉
  useEffect(() => {
    if (failedNames.length === 0) return;
    const timer = setTimeout(() => setFailedNames([]), 4000);
    return () => clearTimeout(timer);
  }, [failedNames]);

  // 全視窗拖放（overlay 版）。handleFiles 每次 render 都是新的（它讀 directionChoice），
  // 所以掛 listener 時走 ref，不然每 render 都要重新訂閱一輪。
  const handleFilesRef = useRef(handleFiles);
  handleFilesRef.current = handleFiles;
  useEffect(() => {
    if (variant !== 'overlay') return;
    let depth = 0;
    // 只對「拖檔案」反應：拖一段文字、拖一個連結進來不該讓整頁變成上傳靶。
    const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
    const onEnter = (e) => {
      if (!hasFiles(e)) return;
      depth += 1;
      setDropActive(true);
    };
    const onOver = (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();                       // 不攔的話瀏覽器會直接開那個 PDF
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const onLeave = (e) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      // relatedTarget 為 null＝真的離開視窗了（在子元素之間移動時它有值）
      if (depth === 0 || e.relatedTarget === null) { depth = 0; setDropActive(false); }
    };
    const onDrop = (e) => {
      e.preventDefault();
      depth = 0;
      setDropActive(false);
      const files = e.dataTransfer?.files;
      if (files && files.length > 0) handleFilesRef.current(files);
    };
    const onEnd = () => { depth = 0; setDropActive(false); };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    window.addEventListener('dragend', onEnd);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
      window.removeEventListener('dragend', onEnd);
    };
  }, [variant]);

  const fileInput = (
    <input
      ref={fileInputRef}
      type="file"
      accept=".pdf"
      multiple
      className="hidden"
      onChange={e => { handleFiles(e.target.files); e.target.value = ''; }}
    />
  );

  const directionPicker = directions.length > 0 && (
    <>
      <option value="">先不歸類</option>
      {directions.map(d => (
        <option key={d.id} value={d.id}>{d.name}</option>
      ))}
      {subNodeOption && (
        <option value={subNodeOption.id}>{subNodeOption.label}（子分類）</option>
      )}
    </>
  );

  // ── overlay 版（論文詳情頁）：平常什麼都不畫 ───────────────────────────
  if (variant === 'overlay') {
    return (
      <>
        {fileInput}
        {failedNames.length > 0 && (
          <div className="cr-upload-fail" role="status">
            ✕ 這 {failedNames.length} 份沒上傳成功：{failedNames.join('、')}
          </div>
        )}
        {dropActive && (
          <div className="cr-drop-overlay">
            <div className="cr-drop-overlay-frame">
              <svg width="30" height="30" viewBox="0 0 16 16" fill="none" stroke="var(--accent)" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><path d="M8 11V3.5M5.4 6.1L8 3.5l2.6 2.6M3 11.5v1.5h10v-1.5" /></svg>
              <div className="text-[15px] text-text-strong">放開以加入論文庫 · 支援批次匯入</div>
              {directions.length > 0 && (
                <div className="flex items-center gap-2" style={{ pointerEvents: 'auto' }}>
                  <span className="text-[12px] text-faint">這篇屬於</span>
                  <select
                    className="text-[12px] bg-surface-alt border border-border rounded-lg px-2 py-1 text-text cursor-pointer focus:outline-none focus:border-accent"
                    value={directionChoice}
                    onChange={e => setDirectionChoice(e.target.value)}
                  >
                    {directionPicker}
                  </select>
                </div>
              )}
            </div>
          </div>
        )}
      </>
    );
  }

  // ── 細條／大靶版（論文庫與其他頁面，工單 25 之後完全沒變）──────────────
  return (
    <div
      className={`cr-uploadzone ${compact ? 'mx-6 mb-2 rounded-lg' : 'm-6 mt-0 rounded-xl'} border-[1.5px] border-dashed transition-colors ${dragOver ? 'border-accent bg-accent-soft' : 'border-border bg-surface-alt'}`}
      onDragOver={e => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={e => {
        e.preventDefault();
        setDragOver(false);
        handleFiles(e.dataTransfer.files);
      }}
      onClick={() => fileInputRef.current?.click()}
    >
      <div className={`flex items-center justify-center cursor-pointer ${compact ? 'gap-2.5 py-1 px-4' : 'gap-3.5 py-4 px-5'}`}>
        {uploading ? (
          <div className="flex flex-wrap gap-3">
            {progress.map((p, i) => (
              <div key={i} className={`flex items-center gap-2 text-muted ${compact ? 'text-xs' : 'text-sm'}`}>
                <span>{p.status === 'uploading' ? '…' : p.status === 'done' ? '✓' : '✕'}</span>
                <span className="truncate max-w-[200px]">{p.name}</span>
              </div>
            ))}
          </div>
        ) : (
          <>
            <svg width={compact ? 14 : 18} height={compact ? 14 : 18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="text-faint shrink-0"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M17 8l-5-5-5 5" /><path d="M12 3v12" /></svg>
            <p className={`text-muted ${compact ? 'text-[12px]' : 'text-[13px]'}`}>
              將 PDF 拖拽到此處上傳，或 <span className="text-accent hover:underline">點擊選擇文件</span> · 支援批次匯入
            </p>
            {directions.length > 0 && (
              <div
                className="flex items-center gap-1.5"
                onClick={e => e.stopPropagation()}
              >
                <span className={`text-faint ${compact ? 'text-[11.5px]' : 'text-[12.5px]'}`}>這篇屬於：</span>
                <select
                  className={`border border-border bg-surface px-2 text-text cursor-pointer focus:outline-none focus:border-accent ${compact ? 'text-[11.5px] rounded-md py-0' : 'text-[12.5px] rounded-lg py-1'}`}
                  value={directionChoice}
                  onChange={e => setDirectionChoice(e.target.value)}
                >
                  {directionPicker}
                </select>
              </div>
            )}
          </>
        )}
      </div>
      {fileInput}
    </div>
  );
});

export default UploadZone;
