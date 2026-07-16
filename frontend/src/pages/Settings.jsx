import React, { useState, useEffect, useCallback } from 'react';
import { settingsApi, logsApi } from '../api';
import { useStore, getProviderDefaults } from '../store';

export default function Settings() {
  const { provider, setProvider, advancedOpen, toggleAdvanced } = useStore();

  const [apiKey, setApiKey] = useState('');
  const [status, setStatus] = useState(null); // { ok, message }
  const [testing, setTesting] = useState(false);

  // Advanced
  const [chatFormat, setChatFormat] = useState('anthropic');
  const [chatBaseUrl, setChatBaseUrl] = useState('');
  const [chatModel, setChatModel] = useState('');
  const [analyzeFormat, setAnalyzeFormat] = useState('openai');
  const [analyzeBaseUrl, setAnalyzeBaseUrl] = useState('');
  const [analyzeApiKey, setAnalyzeApiKey] = useState('');
  const [analyzeModel, setAnalyzeModel] = useState('');

  // Logs
  const [logs, setLogs] = useState([]);
  const [showLogs, setShowLogs] = useState(false);

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      // Load settings from localStorage (frontend-only settings like API keys)
      const saved = JSON.parse(localStorage.getItem('co-reading-settings') || '{}');
      if (saved.apiKey) setApiKey(saved.apiKey);
      if (saved.provider) setProvider(saved.provider);
      if (saved.advanced) {
        setChatFormat(saved.advanced.chatFormat || 'anthropic');
        setChatBaseUrl(saved.advanced.chatBaseUrl || '');
        setChatModel(saved.advanced.chatModel || '');
        setAnalyzeFormat(saved.advanced.analyzeFormat || 'openai');
        setAnalyzeBaseUrl(saved.advanced.analyzeBaseUrl || '');
        setAnalyzeApiKey(saved.advanced.analyzeApiKey || '');
        setAnalyzeModel(saved.advanced.analyzeModel || '');
      }
    } catch {}

    // Check backend configuration
    try {
      const cfg = await settingsApi.get();
      if (cfg.configured && !apiKey) {
        setStatus({ ok: true, message: '已配置' });
      }
    } catch {
      // Backend may not be running yet
    }
  };

  const handleProviderChange = (p) => {
    setProvider(p);
    const defaults = getProviderDefaults(p);
    setChatFormat(defaults.format);
    setChatBaseUrl(defaults.base_url);
    setChatModel(defaults.model);
    setAnalyzeFormat('openai');
    setAnalyzeBaseUrl('');
    setAnalyzeApiKey('');
    setAnalyzeModel('');
  };

  const saveSettings = async () => {
    const defaults = getProviderDefaults(provider);
    const baseUrl = advancedOpen ? chatBaseUrl : defaults.base_url;
    const format = advancedOpen ? chatFormat : defaults.format;
    const model = advancedOpen ? chatModel : defaults.model;

    // Save to localStorage for quick reload
    const settings = {
      provider,
      apiKey,
      advanced: { chatFormat, chatBaseUrl, chatModel, analyzeFormat, analyzeBaseUrl, analyzeApiKey, analyzeModel },
    };
    localStorage.setItem('co-reading-settings', JSON.stringify(settings));

    // Save to backend SQLite settings table
    try {
      await settingsApi.save({
        ai_api_key: apiKey,
        ai_base_url: baseUrl,
        ai_model: model,
        ai_format: format,
        analyze_api_key: advancedOpen && analyzeApiKey ? analyzeApiKey : apiKey,
        analyze_base_url: advancedOpen && analyzeBaseUrl ? analyzeBaseUrl : baseUrl,
        analyze_model: advancedOpen && analyzeModel ? analyzeModel : model,
        analyze_format: advancedOpen ? analyzeFormat : 'openai',
      });
    } catch (err) {
      console.error('Failed to save settings to backend:', err);
    }

    setStatus({ ok: true, message: '設定已儲存' });
  };

  const handleTest = async () => {
    setTesting(true);
    setStatus(null);

    const baseUrl = advancedOpen ? chatBaseUrl : getProviderDefaults(provider).base_url;
    const format = advancedOpen ? chatFormat : getProviderDefaults(provider).format;
    const model = advancedOpen ? chatModel : getProviderDefaults(provider).model;

    try {
      const result = await settingsApi.test({
        base_url: baseUrl,
        api_key: apiKey,
        model: model,
        format: format,
      });
      if (result.ok) {
        setStatus({ ok: true, message: '連接正常' });
      } else {
        setStatus({ ok: false, message: result.error || 'Key 無效，請重新確認' });
      }
    } catch (err) {
      setStatus({ ok: false, message: err.message });
    }
    setTesting(false);
  };

  const loadLogs = async () => {
    setShowLogs(!showLogs);
    if (!showLogs) {
      try {
        const data = await logsApi.get(100);
        setLogs(data.logs || []);
      } catch {
        setLogs([]);
      }
    }
  };

  const providerInfo = {
    anthropic: { label: 'Anthropic (Claude)', url: 'console.anthropic.com' },
    openai: { label: 'OpenAI', url: 'platform.openai.com' },
    deepseek: { label: 'DeepSeek', url: 'platform.deepseek.com' },
    custom: { label: '其他（自定義）', url: null },
  };

  return (
    <div className="max-w-2xl mx-auto">
      <h2 className="cr-serif text-2xl font-semibold text-text-strong mb-1">設定</h2>
      <p className="text-[13.5px] text-muted mb-6">API、模型、外觀。所有變更即時保存到本機。</p>

      <div className="space-y-5">
        {/* API Key */}
        <div className="card p-6">
          <h3 className="cr-serif text-[17px] font-semibold text-text-strong mb-1">API Key</h3>
          <p className="text-[12.5px] text-muted mb-3">
            填入你的 API Key 即可開始使用。API key 僅保存在本機，不會上傳。
          </p>

          {/* Provider selector */}
          <div className="flex flex-wrap gap-2 mb-3">
            {Object.entries(providerInfo).map(([k, v]) => (
              <label key={k} className="flex items-center gap-1.5 text-sm cursor-pointer text-text">
                <input
                  type="radio"
                  name="provider"
                  checked={provider === k}
                  onChange={() => handleProviderChange(k)}
                  className="accent-[var(--accent)]"
                />
                {v.label}
              </label>
            ))}
          </div>

          {/* API Key input */}
          <div className="mb-2">
            <input
              type="password"
              className="w-full border border-border bg-surface-alt rounded-[10px] px-3 py-2 text-sm cr-mono focus:outline-none focus:border-accent"
              placeholder="在此貼入你的 API Key"
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
            />
          </div>

          {providerInfo[provider]?.url && (
            <p className="text-xs text-faint mb-3">
              前往 <a href={`https://${providerInfo[provider].url}`} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">{providerInfo[provider].url}</a> 申請 API Key
            </p>
          )}

          <div className="flex items-center gap-3 mb-3">
            <button
              className="px-4 py-2 bg-accent text-accent-fg rounded-[10px] text-sm font-medium hover:bg-accent-hover disabled:opacity-50 shadow-sm"
              onClick={saveSettings}
            >
              儲存
            </button>
            <button
              className="px-4 py-2 border border-border rounded-[10px] text-sm text-text hover:bg-surface-hover disabled:opacity-50"
              onClick={handleTest}
              disabled={testing || !apiKey}
            >
              {testing ? '測試中...' : '測試連接'}
            </button>
          </div>

          {status && (
            <p className={`text-sm ${status.ok ? 'text-fact' : 'text-danger'}`}>
              {status.ok ? '✓ ' : '✕ '}{status.message}
            </p>
          )}
        </div>

        {/* Advanced settings */}
        <div className="card p-6">
          <button
            className="text-sm text-text hover:text-text-strong font-medium"
            onClick={toggleAdvanced}
          >
            {advancedOpen ? '▾' : '▸'} 進階設定（使用其他 AI 服務）
          </button>

          {advancedOpen && (
            <div className="mt-3 space-y-4 pl-4 border-l-2 border-border-soft">
              {/* Chat model */}
              <div>
                <h4 className="text-sm font-medium text-text-strong mb-2">討論用模型</h4>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-xs text-muted">API 格式</label>
                    <select
                      className="w-full border border-border bg-surface-alt rounded-[10px] px-2 py-1.5 text-sm mt-0.5"
                      value={chatFormat}
                      onChange={e => setChatFormat(e.target.value)}
                    >
                      <option value="anthropic">Anthropic</option>
                      <option value="openai">OpenAI</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-muted">Model</label>
                    <input
                      className="w-full border border-border bg-surface-alt rounded-[10px] px-2 py-1.5 text-sm mt-0.5 cr-mono"
                      value={chatModel}
                      onChange={e => setChatModel(e.target.value)}
                      placeholder="claude-sonnet-4-6"
                    />
                  </div>
                  <div className="col-span-2">
                    <label className="text-xs text-muted">Base URL</label>
                    <input
                      className="w-full border border-border bg-surface-alt rounded-[10px] px-2 py-1.5 text-sm mt-0.5 cr-mono"
                      value={chatBaseUrl}
                      onChange={e => setChatBaseUrl(e.target.value)}
                      placeholder="https://api.anthropic.com/v1"
                    />
                  </div>
                </div>
              </div>

              {/* Analyze model */}
              <div>
                <h4 className="text-sm font-medium text-text-strong mb-2">通讀用模型（可選）</h4>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-xs text-muted">API 格式</label>
                    <select
                      className="w-full border border-border bg-surface-alt rounded-[10px] px-2 py-1.5 text-sm mt-0.5"
                      value={analyzeFormat}
                      onChange={e => setAnalyzeFormat(e.target.value)}
                    >
                      <option value="anthropic">Anthropic</option>
                      <option value="openai">OpenAI</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-muted">Model</label>
                    <input
                      className="w-full border border-border bg-surface-alt rounded-[10px] px-2 py-1.5 text-sm mt-0.5 cr-mono"
                      value={analyzeModel}
                      onChange={e => setAnalyzeModel(e.target.value)}
                      placeholder="deepseek-chat"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-muted">Base URL</label>
                    <input
                      className="w-full border border-border bg-surface-alt rounded-[10px] px-2 py-1.5 text-sm mt-0.5 cr-mono"
                      value={analyzeBaseUrl}
                      onChange={e => setAnalyzeBaseUrl(e.target.value)}
                      placeholder="https://api.deepseek.com/v1"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-muted">API Key（留空則使用上方）</label>
                    <input
                      type="password"
                      className="w-full border border-border bg-surface-alt rounded-[10px] px-2 py-1.5 text-sm mt-0.5 cr-mono"
                      value={analyzeApiKey}
                      onChange={e => setAnalyzeApiKey(e.target.value)}
                      placeholder="留空 = 使用主 API Key"
                    />
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Running logs */}
        <div className="card p-6">
          <button
            className="text-sm text-text hover:text-text-strong font-medium"
            onClick={loadLogs}
          >
            運行日誌 {showLogs ? '▾' : '▸'}
          </button>

          {showLogs && (
            <div className="mt-3">
              <div className="bg-[#1B1815] text-[#EDE6D6] rounded-lg p-3 text-xs cr-mono max-h-64 overflow-y-auto">
                {logs.length === 0 ? (
                  <p className="text-faint">尚無日誌</p>
                ) : (
                  logs.map((line, i) => (
                    <div
                      key={i}
                      className={`${line.includes('[ERROR]') ? 'text-danger' : 'text-muted'}`}
                    >
                      {line}
                    </div>
                  ))
                )}
              </div>
              <div className="flex gap-2 mt-2">
                <button
                  className="text-xs text-muted hover:text-text-strong"
                  onClick={async () => {
                    try { const data = await logsApi.get(100); setLogs(data.logs || []); } catch {}
                  }}
                >
                  刷新
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Save note about settings storage */}
        <div className="pt-1">
          <p className="text-xs text-faint">
            API Key 儲存在瀏覽器本地儲存（localStorage），不會上傳到任何服務器。後端透過 SQLite 的 settings 表讀取配置。
          </p>
        </div>
      </div>
    </div>
  );
}
