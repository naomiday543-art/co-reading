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
};

export const tagsApi = {
  list: () => request('/tags'),
  create: (name, color) => request('/tags', { method: 'POST', body: { name, color } }),
  delete: (id) => request(`/tags/${id}`, { method: 'DELETE' }),
};

export const treeApi = {
  get: () => request('/tree'),
  create: (name, parent_id) => request('/tree', { method: 'POST', body: { name, parent_id } }),
  update: (id, data) => request(`/tree/${id}`, { method: 'PATCH', body: data }),
  delete: (id) => request(`/tree/${id}`, { method: 'DELETE' }),
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
};

async function readSSEStream(response, { onDelta, onDone, onError }) {
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
        else if (data.type === 'error') onError(data.message);
      } catch {}
    }
  }
}

export function streamChat(paperId, message, { onDelta, onDone, onError }) {
  return fetch(`${API}/api/papers/${paperId}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  }).then(response => readSSEStream(response, { onDelta, onDone, onError }));
}

export function regenerateChat(paperId, { onDelta, onDone, onError }) {
  return fetch(`${API}/api/papers/${paperId}/chat?regenerate=true`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  }).then(response => readSSEStream(response, { onDelta, onDone, onError }));
}

export function continueChat(paperId, { onDelta, onDone, onError }) {
  return fetch(`${API}/api/papers/${paperId}/chat?continue=true`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  }).then(response => readSSEStream(response, { onDelta, onDone, onError }));
}
