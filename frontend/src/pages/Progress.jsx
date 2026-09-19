import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { directionsApi, papersApi } from '../api';
import { layoutProgress } from '../lib/progressLayout';
import ProgressGraph from '../components/ProgressGraph';
import ProvenanceModal from '../components/ProvenanceModal';
import { shortPaperTitle } from '../lib/claim-visual';

// 研究進度（工單 21 §六）：一個方向一張圖。
//
// 這一頁只讀（紅線 1）：gateway 抽出來的 claims 與關係在這裡畫成圖，圖上改不了任何
// 東西——要改狀態就回對話裡說，下次精煉會收。唯一的寫入動作是「逐篇精煉」，而且
// 她按了才跑、一篇一篇跑。

/** 她在側欄選的那個節點屬於哪個頂層方向（選的是子題也要找得到）。 */
function topLevelIdOf(tree, nodeId) {
  if (!nodeId) return null;
  const walk = (nodes, rootId) => {
    for (const n of nodes) {
      const top = rootId ?? n.id;
      if (n.id === nodeId) return top;
      const found = walk(n.children || [], top);
      if (found) return found;
    }
    return null;
  };
  return walk(tree || [], null);
}

const FIT_MIN_SCALE = 0.5;

// 收合狀態記在 localStorage，一個方向一格（工單 23 D3）。慣例跟 store.js 一樣：
// 讀寫都包 try/catch（隱私模式會拋），讀不到就當全展開——這是視圖狀態，不進資料庫。
const collapseKey = (directionId) => `co-reading:progress-collapsed:${directionId}`;

function readCollapsed(directionId) {
  if (!directionId) return new Set();
  try {
    const raw = localStorage.getItem(collapseKey(directionId));
    const ids = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(ids) ? ids.filter(id => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeCollapsed(directionId, ids) {
  if (!directionId) return;
  try { localStorage.setItem(collapseKey(directionId), JSON.stringify([...ids])); } catch {}
}

export default function Progress({ onNavigate }) {
  const { tree, selectedTreeNode } = useStore();

  const directions = useMemo(
    () => (tree || []).map(n => ({ id: n.id, name: n.name, description: n.description || '' })),
    [tree],
  );

  const [directionId, setDirectionId] = useState(null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showSuperseded, setShowSuperseded] = useState(false);
  const [paperFilter, setPaperFilter] = useState(null);
  const [fit, setFit] = useState(false);
  // 收起來的節點（工單 23）：預設全展開，切方向時讀該方向記住的那組。
  const [collapsed, setCollapsed] = useState(() => new Set());
  // 逐篇精煉：她按了才跑（紅線 4），序列一篇一篇，中途可停（下一篇不發）。
  const [refining, setRefining] = useState(null);
  const stopRef = useRef(false);
  const [provenance, setProvenance] = useState(null);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const viewportRef = useRef(null);

  // 預設＝側欄當前選的方向（選到子題就往上找），否則第一個。
  useEffect(() => {
    if (directionId || directions.length === 0) return;
    setDirectionId(topLevelIdOf(tree, selectedTreeNode) || directions[0].id);
  }, [directions, selectedTreeNode, tree, directionId]);

  const load = async (id = directionId) => {
    if (!id) return;
    setLoading(true);
    setError('');
    try {
      setData(await directionsApi.progress(id));
    } catch (e) {
      setData(null);
      setError(e.message || '讀不到這個方向的研究進度');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setPaperFilter(null);
    setCollapsed(readCollapsed(directionId));
    load(directionId);
  }, [directionId]);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    // 可見高＝視窗高扣掉畫布頂端到視窗頂端的距離（畫布本身會隨內容長高，clientHeight 不能用）
    const measure = () => {
      setViewportWidth(el.clientWidth);
      setViewportHeight(Math.max(0, window.innerHeight - el.getBoundingClientRect().top - 16));
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener('resize', measure);
    measure();
    return () => { ro.disconnect(); window.removeEventListener('resize', measure); };
  }, [data]);

  const layout = useMemo(() => layoutProgress({
    direction: data?.direction,
    papers: data?.papers || [],
    claims: data?.claims || [],
    relations: data?.relations || [],
    showSuperseded,
    collapsed,
  }), [data, showSuperseded, collapsed]);

  // 寫 localStorage 只在她真的動了收合時發生（不用 useEffect：切方向的那一拍會拿
  // 舊的 set 覆蓋新方向的那一格）。
  const applyCollapsed = (next) => {
    setCollapsed(next);
    writeCollapsed(directionId, next);
  };
  const toggleCollapse = (nodeId) => {
    const next = new Set(collapsed);
    if (next.has(nodeId)) next.delete(nodeId);
    else next.add(nodeId);
    applyCollapsed(next);
  };
  // 「全部收起」＝所有論文與「討論（跨篇）」（它們永遠是根的直接子，不會被別人藏住）。
  const collapseAll = () => {
    const next = new Set(collapsed);
    for (const n of layout.nodes) if (n.kind === 'paper' || n.kind === 'group') next.add(n.id);
    applyCollapsed(next);
  };

  const papers = data?.papers || [];
  const counts = data?.counts || null;
  const refinedCount = papers.filter(p => p.refine_state === 'fresh').length;
  const unrefined = papers.filter(p => p.refine_state === 'never' || p.refine_state === 'new_messages');
  const stalePapers = papers.filter(p => p.refine_state === 'stale');
  const undiscussed = papers.filter(p => p.refine_state === 'no_discussion');

  /**
   * 逐篇精煉（§三 B2）：不加後端，前端序列呼叫既有 `POST /api/papers/:id/refine`，
   * 每篇完成後重拉 B1（圖跟著長出來）。`stale` 的不納入——她 9/18 拍板手動型，
   * 要重送全文得進論文頁自己按。
   */
  const refineAll = async () => {
    const queue = papers.filter(p => p.refine_state === 'never' || p.refine_state === 'new_messages');
    if (queue.length === 0 || refining) return;
    stopRef.current = false;
    setError('');
    const failures = [];
    let consecutive = 0;
    for (let i = 0; i < queue.length; i++) {
      if (stopRef.current) break;
      setRefining({ index: i + 1, total: queue.length, title: queue[i].title, id: queue[i].id });
      try {
        await papersApi.refine(queue[i].id);
        consecutive = 0;
      } catch (e) {
        // 一篇失敗記下來、繼續下一篇（親驗時一篇 400 把整條佇列卡死過）；
        // 連續兩篇失敗才停：那多半是上游掛了，連著打只會把它打得更死。
        failures.push(`「${shortPaperTitle(queue[i].title, 16)}」：${e.message}`);
        consecutive += 1;
        if (consecutive >= 2) {
          failures.push('連續兩篇失敗，先停下來。');
          break;
        }
      }
      await load();
    }
    if (failures.length > 0) setError(`精煉失敗 ${failures.length - (failures.at(-1).startsWith('連續') ? 1 : 0)} 篇：${failures.join('；')}`);
    setRefining(null);
  };

  // 「適應視窗」：不做縮放手勢（§六），只有這一顆按鈕，最小 0.5。
  // 寬與高都要放得下（這張圖通常是又高又窄），取兩者較小的縮放，最小 0.5。
  const fitW = viewportWidth > 0 ? viewportWidth / layout.bounds.width : 1;
  const fitH = viewportHeight > 0 ? viewportHeight / layout.bounds.height : 1;
  const scale = fit ? Math.max(FIT_MIN_SCALE, Math.min(1, fitW, fitH)) : 1;

  const hiddenContradicts = layout.warnings.filter(w => w.type === 'contradicts_hidden').length;
  const danglingEdges = layout.warnings.filter(w => w.type === 'dangling_edge').length;
  const downgraded = layout.warnings.filter(w => w.type === 'multi_parent' || w.type === 'cycle').length;

  const hasGraph = (data?.claims || []).length > 0;

  // 點節點看溯源。代理只用 paperId 找 gateway 設定，所以傳這條 claim 的第一篇；
  // 討論產生的（沒有來源論文）就借方向底下任一篇，結果一樣。
  const openProvenance = (node) => {
    const claim = node?.data;
    if (!claim?.id) return;
    const paperId = (Array.isArray(claim.paper_ids) ? claim.paper_ids : [])[0] || papers[0]?.id || null;
    if (!paperId) {
      setError('這個方向底下還沒有論文，開不了溯源');
      return;
    }
    setProvenance({ paperId, claimId: claim.id });
  };

  return (
    <div className="max-w-[1400px] mx-auto">
      {/* ── 頁頂 ───────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
        <div className="flex items-center gap-2.5">
          <h2 className="cr-serif text-[19px] font-semibold text-text-strong">研究進度</h2>
          <select
            className="text-[13px] border border-border rounded-lg bg-surface px-2 py-1 text-text"
            value={directionId || ''}
            onChange={e => setDirectionId(e.target.value)}
          >
            {directions.length === 0 && <option value="">（還沒有研究方向）</option>}
            {directions.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <label className="flex items-center gap-1.5 text-[12px] text-muted cursor-pointer" title="被取代的節點預設不畫（會佔位置、把佈局撐歪）；打開後以淡色出現，並連一條「被誰取代」的線">
            <input type="checkbox" checked={showSuperseded} onChange={e => setShowSuperseded(e.target.checked)} />
            顯示走過的路
          </label>
          <button
            className="text-[12px] px-2 py-1 rounded-lg border border-border text-muted hover:text-accent transition-colors disabled:opacity-50"
            onClick={collapseAll}
            disabled={!hasGraph}
            title="把每一篇論文與「討論（跨篇）」都收起來，只留方向這一層"
          >
            全部收起
          </button>
          <button
            className="text-[12px] px-2 py-1 rounded-lg border border-border text-muted hover:text-accent transition-colors disabled:opacity-50"
            onClick={() => applyCollapsed(new Set())}
            disabled={collapsed.size === 0}
            title="全部展開"
          >
            全部展開
          </button>
          <button
            className={`text-[12px] px-2 py-1 rounded-lg border transition-colors ${fit ? 'border-accent text-accent' : 'border-border text-muted hover:text-accent'}`}
            onClick={() => setFit(f => !f)}
            title="把整張圖縮到放得下（最小 0.5 倍）。不做縮放手勢。"
          >
            {fit ? '原尺寸' : '適應視窗'}
          </button>
          <button
            className="text-[12px] px-2 py-1 rounded-lg border border-border text-muted hover:text-accent transition-colors disabled:opacity-50"
            onClick={() => load()}
            disabled={loading || !directionId}
          >
            {loading ? '讀取中…' : '重新整理'}
          </button>
        </div>
      </div>

      {/* 統計列：claims／關係用 gateway 的整線帳（counts 不隨 include 變） */}
      {data && (
        <div className="text-[12.5px] text-muted mb-2 flex items-center gap-2 flex-wrap">
          <span>
            {counts ? counts.active : (data.claims || []).length} 條 claims
            {counts?.superseded ? `（另有 ${counts.superseded} 條被取代）` : ''}
            {' · '}
            {counts ? counts.relations : (data.relations || []).length} 條關係
            {' · '}
            已精煉 {refinedCount}/{papers.length} 篇
          </span>
          {data.direction?.description && <span className="text-faint">· {data.direction.description}</span>}
        </div>
      )}

      {/* 精煉狀態：她按了才跑（紅線 4），序列一篇一篇，中途可停 */}
      {(unrefined.length > 0 || refining) && (
        <div className="flex items-center gap-2 flex-wrap mb-2">
          {refining ? (
            <>
              <span className="text-[12.5px] text-hyp">
                精煉中 {refining.index}/{refining.total}：{shortPaperTitle(refining.title, 18)}
                <span className="text-faint">（一篇約 15–40 秒）</span>
              </span>
              <button
                className="text-[12px] px-2 py-0.5 rounded-lg border border-border text-muted hover:text-danger transition-colors"
                onClick={() => { stopRef.current = true; }}
                title="這一篇跑完就停，不再發下一篇"
              >
                停
              </button>
            </>
          ) : (
            <>
              <span className="text-[12.5px] text-hyp">
                這個方向還有 {unrefined.length} 篇沒精煉
                {undiscussed.length > 0 && (
                  <span className="text-faint" title="沒聊過的論文沒東西可精煉；先到論文頁跟 AI 討論幾句">
                    （另 {undiscussed.length} 篇還沒討論過）
                  </span>
                )}
              </span>
              <button
                className="text-[12px] px-2 py-0.5 rounded-lg border border-accent text-accent hover:bg-accent-soft transition-colors"
                onClick={refineAll}
                title="一篇一篇送去精煉（每篇約 15–40 秒）。對話改過的那幾篇不納入。"
              >
                逐篇精煉
              </button>
            </>
          )}
        </div>
      )}
      {stalePapers.length > 0 && (
        <div className="text-[12.5px] text-muted mb-2 flex items-center gap-1.5 flex-wrap">
          <span className="text-danger">{stalePapers.length} 篇對話改過</span>
          <span className="text-faint">（要重新精煉請進論文頁按「重新精煉這篇」）</span>
          {stalePapers.map(p => (
            <button
              key={p.id}
              className="text-[11px] px-1.5 py-0.5 rounded border border-border text-muted hover:text-accent transition-colors"
              onClick={() => onNavigate?.('detail', p.id)}
            >
              {shortPaperTitle(p.title, 12)}
            </button>
          ))}
        </div>
      )}

      {/* 論文篩選 chips：點一篇，該篇的節點與邊留亮，其餘淡 */}
      {papers.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap mb-3">
          <button
            className={`text-[11.5px] px-2 py-0.5 rounded-full border transition-colors ${!paperFilter ? 'bg-accent-soft text-accent border-transparent font-medium' : 'bg-surface text-text border-border-soft hover:bg-surface-hover'}`}
            onClick={() => setPaperFilter(null)}
          >
            全部
          </button>
          {papers.map(p => (
            <button
              key={p.id}
              title={p.title}
              className={`text-[11.5px] px-2 py-0.5 rounded-full border transition-colors ${paperFilter === p.id ? 'bg-accent-soft text-accent border-transparent font-medium' : 'bg-surface text-text border-border-soft hover:bg-surface-hover'}`}
              onClick={() => setPaperFilter(paperFilter === p.id ? null : p.id)}
            >
              {shortPaperTitle(p.title, 12)}
            </button>
          ))}
        </div>
      )}

      {error && <p className="text-[13px] text-danger mb-3">{error}</p>}

      {/* 佈局降級與藏起來的邊：不靜靜吞掉（紅線 3） */}
      {(hiddenContradicts > 0 || danglingEdges > 0 || downgraded > 0) && (
        <p className="text-[11.5px] text-faint mb-2">
          {hiddenContradicts > 0 && `${hiddenContradicts} 條矛盾邊的另一端不在圖上（打開「顯示走過的路」看看）。`}
          {downgraded > 0 && `${downgraded} 條多父／成環的邊已降級成橫線。`}
          {danglingEdges > 0 && `${danglingEdges} 條關係的端點不在這批 claims 裡，已略過。`}
        </p>
      )}

      {/* ── 畫布 ───────────────────────────────────────────── */}
      <div
        ref={viewportRef}
        className="relative overflow-auto border border-border-soft rounded-xl bg-bg-tint p-2"
        style={{ maxHeight: 'calc(100vh - 260px)' }}
      >
        {!data && loading && <p className="text-[13px] text-muted p-6">讀取中…</p>}
        {data && !hasGraph && (
          <div className="p-8 text-center">
            <p className="cr-serif text-[15px] text-muted mb-1.5">還沒有東西，先精煉幾篇</p>
            <p className="text-[12.5px] text-faint">
              這個方向底下有 {papers.length} 篇論文，還沒有任何精煉出來的結論。
            </p>
          </div>
        )}
        {data && hasGraph && (
          <div style={{ width: layout.bounds.width * scale, height: layout.bounds.height * scale }}>
            <div style={{ transform: `scale(${scale})`, transformOrigin: 'top left' }}>
              <ProgressGraph
                layout={layout}
                papers={papers}
                highlightPaperId={paperFilter}
                onClaimClick={openProvenance}
                onToggleCollapse={toggleCollapse}
              />
            </div>
          </div>
        )}
      </div>

      {provenance && (
        <ProvenanceModal
          paperId={provenance.paperId}
          claimId={provenance.claimId}
          onClose={() => setProvenance(null)}
        />
      )}
    </div>
  );
}
