const API = '';

async function request(path, options = {}) {
  const url = `${API}/api${path}`;
  const config = { headers: {}, ...options };

  if (config.body && !(config.body instanceof FormData)) {
    config.headers['Content-Type'] = 'application/json';
    config.body = JSON.stringify(config.body);
  }

  const res = await fetch(url, config);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

export const papersApi = {
  list: (params) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/papers${qs ? '?' + qs : ''}`);
  },
  get: (id) => request(`/papers/${id}`),
  update: (id, data) => request(`/papers/${id}`, { method: 'PATCH', body: data }),
  delete: (id) => request(`/papers/${id}`, { method: 'DELETE' }),
  upload: (files, tree_node_id) => {
    const form = new FormData();
    for (const f of files) form.append('files', f);
    if (tree_node_id) form.append('tree_node_id', tree_node_id);
    return fetch(`${API}/api/papers/upload`, { method: 'POST', body: form }).then(r => r.json());
  },
  analyze: (id) => request(`/papers/${id}/analyze`, { method: 'POST' }),
  getMessages: (id) => request(`/papers/${id}/chat`),
  addTag: (paperId, tagId) => request(`/papers/${paperId}/tags`, { method: 'POST', body: { tag_id: tagId } }),
  removeTag: (paperId, tagId) => request(`/papers/${paperId}/tags/${tagId}`, { method: 'DELETE' }),
  extractInsights: (paperId) => request(`/papers/${paperId}/extract-insights`, { method: 'POST' }),
  editMessage: (paperId, msgId, content) =>
    request(`/papers/${paperId}/chat/edit`, { method: 'POST', body: { msg_id: msgId, content } }),
  switchBranch: (paperId, forkId, branchId) =>
    request(`/papers/${paperId}/chat/branch/switch`, { method: 'POST', body: { fork_id: forkId, branch_id: branchId } }),
  // full:true ＝「重新精煉這篇」（工單 20 §A3）：後端送 since_seq=null 全文重送。
  refine: (paperId, { full = false } = {}) =>
    request(`/papers/${paperId}/refine`, { method: 'POST', ...(full ? { body: { full: true } } : {}) }),
  getCarryover: (paperId, { refresh = false } = {}) =>
    request(`/papers/${paperId}/carryover${refresh ? '?refresh=1' : ''}`),
  setCarryoverInject: (paperId, enabled) =>
    request(`/papers/${paperId}/carryover/inject`, { method: 'POST', body: { enabled } }),
  claimProvenance: (paperId, claimId) =>
    request(`/papers/${paperId}/claims/${claimId}/provenance`),
};

export const tagsApi = {
  list: () => request('/tags'),
  create: (name, color) => request('/tags', { method: 'POST', body: { name, color } }),
  delete: (id) => request(`/tags/${id}`, { method: 'DELETE' }),
};

export const treeApi = {
  get: () => request('/tree'),
  // description 可選（工單 07 §3.1）：沒傳就不帶這個 key，後端維持原樣行為。
  create: (name, parent_id, description) => request('/tree', {
    method: 'POST',
    body: description === undefined ? { name, parent_id } : { name, parent_id, description },
  }),
  update: (id, data) => request(`/tree/${id}`, { method: 'PATCH', body: data }),
  delete: (id) => request(`/tree/${id}`, { method: 'DELETE' }),
};

// 研究進度圖（工單 21 §三 B1）。co-reading 後端代理，前端不直連 gateway。
// 一次回整條線（含被取代的）——「顯示走過的路」開關是前端的事，不重打一趟。
export const directionsApi = {
  progress: (nodeId) => request(`/directions/${nodeId}/progress`),
};

export const settingsApi = {
  get: () => request('/settings'),
  save: (data) => request('/settings', { method: 'PUT', body: data }),
  test: (config) => request('/settings/test', { method: 'POST', body: config }),
};

export const logsApi = {
  get: (lines = 100) => request(`/logs?lines=${lines}`),
};

export const insightsApi = {
  list: (params) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/insights${qs ? '?' + qs : ''}`);
  },
  get: (id) => request(`/insights/${id}`),
  create: (data) => request('/insights', { method: 'POST', body: data }),
  update: (id, data) => request(`/insights/${id}`, { method: 'PATCH', body: data }),
  delete: (id) => request(`/insights/${id}`, { method: 'DELETE' }),
  related: (paperId) => request(`/insights/related?paper_id=${paperId}`),
  // 工單 18：浮現卡的「相關洞察」（§2 B3）、兩個一次性維護端點（§2 A1／B1）
  links: (id) => request(`/insights/${id}/links`),
  backfillSources: () => request('/insights/backfill-sources', { method: 'POST', body: {} }),
  relinkAll: () => request('/insights/relink-all', { method: 'POST', body: {} }),
};

/**
 * 討論的 SSE 事件。
 *
 * `thinking`／`thinking_done` 是工單 12 §3.3 新加的：只帶字數與秒數，**沒有思考內容**。
 * 舊的三顆（delta／done／error）行為不變；error 現在多帶 `partial` 與 `hint`，
 * 從第二個參數拿（舊呼叫端只吃第一個字串，照樣能動）。
 */
export async function readSSEStream(response, { onDelta, onDone, onError, onThinking }) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data: ')) continue;
      try {
        const data = JSON.parse(trimmed.slice(6));
        if (data.type === 'delta') onDelta(data.content);
        else if (data.type === 'done') onDone(data);
        else if (data.type === 'error') onError(data.message, data);
        else if (data.type === 'thinking') onThinking?.({ chars: data.chars, done: false });
        else if (data.type === 'thinking_done') {
          onThinking?.({ chars: data.chars, seconds: data.seconds, done: true });
        }
      } catch {}
    }
  }
}

// `signal`：她按「停止」時中止這條 fetch。連線一斷，後端 `res` 的 'close' 就會把上游
// 那條也收掉（工單 12 §3.4②），不會留一個沒人看的生成繼續燒。
// `quote`（工單 14）：`{text,start,end}`，start/end 是 `paper.full_text` 的字元偏移。
// 後端會驗 `full_text.slice(start,end) === text`，對不上直接 400——所以這裡**不要**
// 自己改寫 text（例如 trim／去換行），一律照 lib/fulltext-offsets.js 切出來的送。
export function streamChat(paperId, message, { onDelta, onDone, onError, onThinking, signal, quote } = {}) {
  return fetch(`${API}/api/papers/${paperId}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(quote ? { message, quote } : { message }),
    signal,
  }).then(async (response) => {
    // 400（引用對不上原文／太長）不是 SSE，是一顆 JSON——直接翻成錯誤，別當串流讀。
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${response.status}`);
    }
    return readSSEStream(response, { onDelta, onDone, onError, onThinking });
  });
}

export function regenerateChat(paperId, { onDelta, onDone, onError, onThinking, signal }) {
  return fetch(`${API}/api/papers/${paperId}/chat?regenerate=true`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
    signal,
  }).then(response => readSSEStream(response, { onDelta, onDone, onError, onThinking }));
}

export function continueChat(paperId, { onDelta, onDone, onError, onThinking, signal }) {
  return fetch(`${API}/api/papers/${paperId}/chat?continue=true`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
    signal,
  }).then(response => readSSEStream(response, { onDelta, onDone, onError, onThinking }));
}

// 閱讀活動面板（工單 04）。days：1..730，0 = 不限（All）。只回計數，不回內容。
export const activityApi = {
  get: (days = 365) => request(`/activity?days=${days}`),
};

// 多篇摘要對比（工單 09）。掛在 /api/compare，不在 /api/papers 底下。
// 通常 30–60 秒，呼叫端要自己顯示 loading。
//
// 不走上面的 request()：它把錯誤壓成 `new Error(err.error)`，400 帶回來的
// `not_analyzed`（哪幾篇還沒通讀）會整個掉光——而那正是前端要印給她看的東西。
export const compareApi = {
  run: async (paper_ids) => {
    const res = await fetch(`${API}/api/compare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paper_ids }),
    });
    const body = await res.json().catch(() => ({ error: res.statusText }));
    if (!res.ok) {
      const err = new Error(body.error || res.statusText);
      err.status = res.status;
      if (body.not_analyzed) err.notAnalyzed = body.not_analyzed;
      throw err;
    }
    return body;
  },
};
