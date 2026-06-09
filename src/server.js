import 'dotenv/config';
import express from 'express';
import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { log } from './logger.js';
import papersRouter from './routes/papers.js';
import chatRouter from './routes/chat.js';
import tagsRouter from './routes/tags.js';
import treeRouter from './routes/tree.js';
import insightsRouter from './routes/insights.js';
import { getSetting, setSetting, getSettings } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3456;

const app = express();

mkdirSync(new URL('../data/pdfs', import.meta.url).pathname, { recursive: true });

app.use(express.json());

// API routes
app.use('/api/papers', papersRouter);
app.use('/api/papers', chatRouter);
app.use('/api', tagsRouter);
app.use('/api', treeRouter);
app.use('/api', insightsRouter);

// Settings endpoints
app.get('/api/settings', (_req, res) => {
  const settings = getSettings();
  res.json({
    configured: !!(settings.ai_api_key || process.env.AI_API_KEY),
    ...settings,
  });
});

app.put('/api/settings', (req, res) => {
  const fields = [
    'ai_api_key', 'ai_base_url', 'ai_model', 'ai_format',
    'analyze_api_key', 'analyze_base_url', 'analyze_model', 'analyze_format',
  ];
  for (const key of fields) {
    if (req.body[key] !== undefined) {
      setSetting(key, req.body[key]);
    }
  }
  log('INFO', '設定已更新');
  res.json({ ok: true });
});

import { testConnection as testConn } from './ai.js';
app.post('/api/settings/test', async (req, res) => {
  try {
    const { base_url, api_key, model, format } = req.body;
    const result = await testConn({ base_url, api_key, model, format });
    res.json(result);
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// Logs endpoint
import { getRecentLogs } from './logger.js';
app.get('/api/logs', (req, res) => {
  const lines = parseInt(req.query.lines) || 100;
  res.json({ logs: getRecentLogs(lines) });
});

// Production: serve frontend static files
const distPath = join(__dirname, '..', 'dist');
if (existsSync(distPath)) {
  app.use(express.static(distPath));
  app.use((req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
    res.sendFile(join(distPath, 'index.html'));
  });
}

app.listen(PORT, () => {
  log('INFO', `Co-Reading 服務已啟動，端口 ${PORT}`);
});
