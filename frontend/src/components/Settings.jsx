import React, { useState, useEffect } from 'react';
import { User, Shield, Cpu, Database, Palette, Save, CheckCircle, ChevronRight, Moon, Sun, Archive, FileText, Info, Terminal, BrainCircuit, Server, Play, Loader, Key, Globe, Keyboard } from 'lucide-react';
import styles from './Settings.module.css';
import BackupRestoreSettings from './BackupRestoreSettings';
import { AVAILABLE_THEMES, applyTheme } from '../utils/themes';
import { t, language, setLanguage } from '../i18n';
import { SUPPORTED_LANGUAGES } from '../utils/languages';
import { cloudHostFor } from '../utils/cloud';

const SECTIONS = [
  { id: 'account',  label: t('Account'),       icon: User },
  { id: 'instructions', label: t('Custom Instructions'), icon: FileText },
  { id: 'workspace-prompt', label: t('Workspace AI Persona'), icon: BrainCircuit },
  { id: 'model',    label: t('Model Settings'),icon: Cpu },
  { id: 'rag',      label: t('RAG Engine'),    icon: Database },
  { id: 'kb',       label: t('Knowledge Base'), icon: Shield },
  { id: 'mcp',      label: t('Local Tools'),   icon: Terminal },
  { id: 'dev-api',  label: t('Local API Server (OpenAI)'), icon: Server },
  { id: 'ui',       label: t('Appearance'),    icon: Palette },
  { id: 'language', label: t('Language & Locale'), icon: Globe },
  { id: 'shortcuts', label: t('Keyboard Shortcuts'), icon: Keyboard },
  { id: 'system',   label: t('Backup & Restore'), icon: Archive },
  { id: 'about',    label: t('About StarkLLM'),icon: Info },
];

function Toggle({ checked, onChange, label, hint }) {
  return (
    <div className={styles.toggleRow}>
      <div className={styles.toggleText}>
        <span className={styles.toggleLabel}>{label}</span>
        {hint && <span className={styles.toggleHint}>{hint}</span>}
      </div>
      <button
        className={`${styles.toggle} ${checked ? styles.toggleOn : ''}`}
        onClick={() => onChange(!checked)}
        role="switch"
        aria-checked={checked}
      >
        <span className={styles.toggleThumb} />
      </button>
    </div>
  );
}

export default function Settings({ token, username, activeWorkspace }) {
  // The About page showed a fixed "v1.0.0-beta"; the engine reports its real version.
  const [appVersion, setAppVersion] = useState('');
  // Only in the desktop app (preload.js): starts the same update check as the tray menu.
  const desktop = typeof window !== 'undefined' ? window.starkllmDesktop : undefined;
  const [updateState, setUpdateState] = useState('');
  const checkForUpdates = async () => {
    setUpdateState('Checking...');
    try {
      const r = await desktop.checkForUpdates();
      setUpdateState(r && r.error ? t('Could not check: {error}', { error: r.error }) : '');
    } catch (e) {
      setUpdateState(t('Could not check: {error}', { error: e.message }));
    }
  };
  useEffect(() => {
    fetch('/api/v1/version')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && d.version && setAppVersion(d.version))
      .catch(() => {});
  }, []);
  // Account
  const [newPassword, setNewPassword] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [pwMsg, setPwMsg] = useState(null);
  const [pwLoading, setPwLoading] = useState(false);

  // Developer API
  const [testingApi, setTestingApi] = useState(false);
  const [apiLatency, setApiLatency] = useState(null);
  const [copiedSnippet, setCopiedSnippet] = useState(null);

  const pythonSnippet = `from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8000/v1",
    api_key="stark-local"
)

response = client.chat.completions.create(
    model="starkllm-default",
    messages=[{"role": "user", "content": "Hello StarkLLM!"}]
)
print(response.choices[0].message.content)`;

  const curlSnippet = `curl http://localhost:8000/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{"model": "starkllm-default", "messages": [{"role": "user", "content": "Hello!"}]}'`;

  const handleCopySnippet = (text, key) => {
    navigator.clipboard.writeText(text);
    setCopiedSnippet(key);
    setTimeout(() => setCopiedSnippet(null), 2000);
  };

  const handleTestApi = async () => {
    setTestingApi(true);
    setApiLatency(null);
    const t0 = performance.now();
    try {
      const res = await fetch('/v1/models');
      const t1 = performance.now();
      if (res.ok) {
        setApiLatency(Math.round(t1 - t0));
      } else {
        setApiLatency(null);
      }
    } catch {
      setApiLatency(null);
    } finally {
      setTestingApi(false);
    }
  };

  // Custom Instructions
  const [profileContext, setProfileContext] = useState('');
  const [customInstructions, setCustomInstructions] = useState('');
  const [instructionsSaved, setInstructionsSaved] = useState(false);
  const [instructionsLoading, setInstructionsLoading] = useState(false);

  useEffect(() => {
    fetch('/api/v1/auth/me', { headers: { Authorization: `Bearer ${token}` } })
      .then(res => res.json())
      .then(data => {
        if (data.profile_context) setProfileContext(data.profile_context);
        if (data.custom_instructions) setCustomInstructions(data.custom_instructions);
        
        if (data.default_model) setModelName(data.default_model);
        if (data.temperature !== null) setTemperature(data.temperature);
        if (data.top_p !== null) setTopP(data.top_p);
        if (data.max_tokens !== null) setMaxTokens(data.max_tokens);
      })
      .catch(err => console.error('Failed to load user profile', err));
  }, [token]);

  const saveInstructions = async () => {
    setInstructionsLoading(true);
    try {
      const res = await fetch('/api/v1/auth/instructions', {
        method: 'PUT',
        headers: getHeaders(),
        body: JSON.stringify({
          profile_context: profileContext,
          custom_instructions: customInstructions,
        })
      });
      if (res.ok) {
        setInstructionsSaved(true);
        setTimeout(() => setInstructionsSaved(false), 2000);
      }
    } catch (err) {
      console.error('Failed to save instructions', err);
    }
    setInstructionsLoading(false);
  };

  // Model & Generation
  const [availableModels, setAvailableModels] = useState([]);
  const [modelName, setModelName] = useState('');
  const [temperature, setTemperature] = useState(0.7);
  const [topP, setTopP] = useState(0.9);
  const [maxTokens, setMaxTokens] = useState('');
  const [modelSaved, setModelSaved] = useState(false);
  const [modelLoading, setModelLoading] = useState(false);

  // Multi-Provider & Cloud API
  const [provider, setProvider] = useState(localStorage.getItem('llm_provider') || 'ollama');
  const [baseUrl, setBaseUrl] = useState(localStorage.getItem('llm_base_url') || '');
  const [apiKey, setApiKey] = useState(localStorage.getItem('llm_api_key') || '');
  const [customModel, setCustomModel] = useState(localStorage.getItem('llm_custom_model') || '');

  useEffect(() => {
    fetch('/api/v1/chat/models', { headers: getHeaders() })
      .then(res => res.json())
      .then(data => {
        if (data.models) {
          setAvailableModels(data.models);
          if (!modelName && data.models.length > 0) {
            setModelName(data.models[0]);
          }
        }
      })
      .catch(err => console.error('Failed to load models', err));
  }, []);

  const saveModelSettings = async () => {
    setModelLoading(true);
    try {
      localStorage.setItem('llm_provider', provider);
      localStorage.setItem('llm_base_url', baseUrl);
      localStorage.setItem('llm_api_key', apiKey);
      localStorage.setItem('llm_custom_model', customModel);

      const res = await fetch('/api/v1/auth/generation-settings', {
        method: 'PUT',
        headers: getHeaders(),
        body: JSON.stringify({
          default_model: provider === 'openai_compatible' ? (customModel || modelName || null) : (modelName || null),
          temperature: parseFloat(temperature),
          top_p: parseFloat(topP),
          max_tokens: maxTokens ? parseInt(maxTokens, 10) : null
        })
      });
      if (res.ok) {
        setModelSaved(true);
        setTimeout(() => setModelSaved(false), 2000);
      }
    } catch (err) {
      console.error('Failed to save generation settings', err);
    }
    setModelLoading(false);
  };

  const resetModelSettings = () => {
    setTemperature(0.7);
    setTopP(0.9);
    setMaxTokens('');
    if (availableModels.length > 0) {
      setModelName(availableModels[0]);
    }
  };

  // RAG
  const [semanticChunking, setSemanticChunking] = useState(
    localStorage.getItem('rag_semantic_chunking') !== 'false'
  );
  const [hybridSearch, setHybridSearch] = useState(
    localStorage.getItem('rag_hybrid_search') !== 'false'
  );
  const [queryRewriting, setQueryRewriting] = useState(
    localStorage.getItem('rag_query_rewriting') !== 'false'
  );
  const [contextCompression, setContextCompression] = useState(
    localStorage.getItem('rag_context_compression') !== 'false'
  );
  const [ragSaved, setRagSaved] = useState(false);

  // KB
  const [autoIndex, setAutoIndex] = useState(
    localStorage.getItem('kb_auto_index') === 'true'
  );
  const [kbSaved, setKbSaved] = useState(false);

  // MCP Host
  const [mcpEnabled, setMcpEnabled] = useState(true);
  const [mcpTools, setMcpTools] = useState({
    list_workspace_files: true,
    search_local_kb: true,
    fetch_cited_chunk: true
  });
  const [mcpServers, setMcpServers] = useState([]);
  const [mcpLoading, setMcpLoading] = useState(false);
  const [mcpSaved, setMcpSaved] = useState(false);

  useEffect(() => {
    fetch('/api/v1/mcp/config', { headers: { Authorization: `Bearer ${token}` } })
      .then(res => res.json())
      .then(data => {
        if (data.config) {
          if (typeof data.config.enabled === 'boolean') setMcpEnabled(data.config.enabled);
          if (data.config.tools) setMcpTools(data.config.tools);
          if (data.config.servers) setMcpServers(data.config.servers);
        }
      })
      .catch(err => console.error('Failed to load MCP config:', err));
  }, [token]);

  const saveMcpSettings = async (override) => {
    setMcpLoading(true);
    const payload = {
      enabled: override && override.enabled !== undefined ? override.enabled : mcpEnabled,
      tools: override && override.tools !== undefined ? override.tools : mcpTools,
      servers: mcpServers
    };
    try {
      const res = await fetch('/api/v1/mcp/config', {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        setMcpSaved(true);
        setTimeout(() => setMcpSaved(false), 2000);
      }
    } catch (err) {
      console.error('Failed to save MCP config:', err);
    }
    setMcpLoading(false);
  };

  // UI
  const [fontSize, setFontSize] = useState(localStorage.getItem('ui_font_size') || 'medium');
  const [theme, setTheme] = useState(() => localStorage.getItem('ui_theme') || 'dark');
  const [uiSaved, setUiSaved] = useState(false);

  // Workspace AI Persona
  const [wsSystemPrompt, setWsSystemPrompt] = useState('');
  const [wsPromptSaved, setWsPromptSaved] = useState(false);
  const [wsPromptLoading, setWsPromptLoading] = useState(false);

  useEffect(() => {
    if (!activeWorkspace) return;
    fetch(`/api/v1/workspaces/${activeWorkspace.id}/system-prompt`, {
      headers: { Authorization: `Bearer ${token}` }
    })
      .then(r => r.json())
      .then(d => setWsSystemPrompt(d.system_prompt || ''))
      .catch(() => {});
  }, [token, activeWorkspace]);

  const saveWsSystemPrompt = async () => {
    if (!activeWorkspace) return;
    setWsPromptLoading(true);
    try {
      const res = await fetch(`/api/v1/workspaces/${activeWorkspace.id}/system-prompt`, {
        method: 'PUT',
        headers: getHeaders(),
        body: JSON.stringify({ system_prompt: wsSystemPrompt })
      });
      if (res.ok) {
        setWsPromptSaved(true);
        setTimeout(() => setWsPromptSaved(false), 2000);
      }
    } catch (e) { console.error(e); }
    setWsPromptLoading(false);
  };

  // Apply saved theme on mount
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleThemeChange = (newTheme) => {
    setTheme(newTheme);
    applyTheme(newTheme);
  };

  const [activeSection, setActiveSection] = useState('account');

  const getHeaders = (extra = {}) => ({
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...extra
  });

  const handleChangePassword = async (e) => {
    e.preventDefault();
    if (newPassword !== confirmPw) {
      setPwMsg({ type: 'error', text: t('Passwords do not match.') });
      return;
    }
    if (newPassword.length < 6) {
      setPwMsg({ type: 'error', text: t('Password must be at least 6 characters.') });
      return;
    }
    setPwLoading(true);
    setPwMsg(null);
    try {
      const res = await fetch('/api/v1/auth/change-password', {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ new_password: newPassword })
      });
      if (res.ok) {
        setPwMsg({ type: 'success', text: t('Password changed successfully!') });
        setNewPassword('');
        setConfirmPw('');
      } else {
        const err = await res.json().catch(() => ({}));
        setPwMsg({ type: 'error', text: err.detail || t('Failed to change password.') });
      }
    } catch {
      setPwMsg({ type: 'error', text: t('Network error. Please try again.') });
    }
    setPwLoading(false);
  };

  const saveRag = () => {
    localStorage.setItem('rag_semantic_chunking', semanticChunking);
    localStorage.setItem('rag_hybrid_search', hybridSearch);
    localStorage.setItem('rag_query_rewriting', queryRewriting);
    localStorage.setItem('rag_context_compression', contextCompression);
    setRagSaved(true);
    setTimeout(() => setRagSaved(false), 2000);
  };

  const saveKb = () => {
    localStorage.setItem('kb_auto_index', autoIndex);
    setKbSaved(true);
    setTimeout(() => setKbSaved(false), 2000);
  };

  const saveUi = () => {
    localStorage.setItem('ui_font_size', fontSize);
    localStorage.setItem('ui_theme', theme);
    document.documentElement.style.fontSize =
      fontSize === 'small' ? '14px' : fontSize === 'large' ? '18px' : '16px';
    document.documentElement.setAttribute('data-theme', theme);
    setUiSaved(true);
    setTimeout(() => setUiSaved(false), 2000);
  };

  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <h1 className={styles.pageTitle}>{t('Settings')}</h1>
        <p className={styles.pageSubtitle}>{t('Manage your account and application preferences.')}</p>
      </div>

      <div className={styles.layout}>
        {/* ── Sidebar nav ── */}
        <nav className={styles.sideNav}>
          {SECTIONS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={`${styles.sideNavItem} ${activeSection === id ? styles.sideNavActive : ''}`}
              onClick={() => setActiveSection(id)}
            >
              <Icon size={15} />
              {label}
              <ChevronRight size={13} className={styles.sideNavChevron} />
            </button>
          ))}
        </nav>

        {/* ── Content panels ── */}
        <div className={styles.content}>

          {/* ───── Account ───── */}
          {activeSection === 'account' && (
            <div className={styles.panel}>
              <div className={styles.panelHeader}>
                <User size={18} />
                <h2>{t('Account Settings')}</h2>
              </div>

              <div className={styles.formGroup}>
                <label className={styles.label}>{t('Username')}</label>
                <div className={styles.staticField}>{username || '—'}</div>
                <p className={styles.hint}>{t('Your username cannot be changed after registration.')}</p>
              </div>

              <div className={styles.divider} />

              <form onSubmit={handleChangePassword} className={styles.form}>
                <div className={styles.panelSubheader}>
                  <Shield size={15} />
                  {t('Change Password')}
                </div>

                <div className={styles.formGroup}>
                  <label className={styles.label}>{t('New Password')}</label>
                  <input
                    type="password"
                    className="input-field"
                    placeholder={t('Enter new password')}
                    value={newPassword}
                    onChange={e => setNewPassword(e.target.value)}
                    minLength={6}
                    required
                  />
                </div>

                <div className={styles.formGroup}>
                  <label className={styles.label}>{t('Confirm Password')}</label>
                  <input
                    type="password"
                    className="input-field"
                    placeholder={t('Re-enter new password')}
                    value={confirmPw}
                    onChange={e => setConfirmPw(e.target.value)}
                    required
                  />
                </div>

                {pwMsg && (
                  <div className={`${styles.msg} ${pwMsg.type === 'success' ? styles.msgSuccess : styles.msgError}`}>
                    {pwMsg.text}
                  </div>
                )}

                <button type="submit" className="btn-primary" disabled={pwLoading} style={{ marginTop: 4 }}>
                  {pwLoading ? t('Saving…') : <><Save size={14} /> {t('Change Password')}</>}
                </button>
              </form>
            </div>
          )}

          {/* ───── Custom Instructions ───── */}
          {activeSection === 'instructions' && (
            <div className={styles.panel}>
              <div className={styles.panelHeader}>
                <FileText size={18} />
                <h2>{t('Custom Instructions')}</h2>
              </div>
              <p className={styles.panelDesc}>
                {t('Personalize how StarkLLM interacts with you globally. These settings shape the AI\'s default behavior and persona.')}
              </p>

              <div className={styles.formGroup}>
                <label className={styles.label}>{t('Profile Context')}</label>
                <textarea
                  className="input-field"
                  placeholder={t('What would you like StarkLLM to know about you to provide better responses? (e.g. I work as a frontend developer, I live in Berlin...)')}
                  rows={4}
                  value={profileContext}
                  onChange={e => setProfileContext(e.target.value)}
                  style={{ resize: 'vertical' }}
                />
              </div>

              <div className={styles.formGroup}>
                <label className={styles.label}>{t('Custom Instructions')}</label>
                <textarea
                  className="input-field"
                  placeholder={t('How would you like StarkLLM to respond? (e.g. Always be concise, use bullet points, adopt a formal tone...)')}
                  rows={4}
                  value={customInstructions}
                  onChange={e => setCustomInstructions(e.target.value)}
                  style={{ resize: 'vertical' }}
                />
              </div>

              <button 
                className="btn-primary" 
                onClick={saveInstructions} 
                disabled={instructionsLoading}
                style={{ marginTop: 12 }}
              >
                {instructionsLoading ? t('Saving…') : instructionsSaved ? <><CheckCircle size={14} /> {t('Saved!')}</> : <><Save size={14} /> {t('Save Instructions')}</>}
              </button>
            </div>
          )}

          {/* ───── Workspace AI Persona ───── */}
          {activeSection === 'workspace-prompt' && (
            <div className={styles.panel}>
              <div className={styles.panelHeader}>
                <BrainCircuit size={18} />
                <h2>{t('Workspace AI Persona')}</h2>
              </div>
              <p className={styles.panelDesc}>
                {t('Define a custom system prompt for the')} <strong>{activeWorkspace?.name || 'active workspace'}</strong>.
                This overrides the default StarkLLM identity for this specific workspace only — perfect for specialized roles like a coding assistant, legal analyst, or language tutor.
              </p>

              {!activeWorkspace ? (
                <div className={styles.msg}>
                  {t('No active workspace selected. Switch to a workspace to configure its AI persona.')}
                </div>
              ) : (
                <>
                  <div className={styles.formGroup}>
                    <label className={styles.label}>{t('Workspace System Prompt')}</label>
                    <textarea
                      className="input-field"
                      placeholder={`Example:\nYou are a senior Python software engineer specializing in data pipelines and ML systems. Always provide production-ready code with error handling. Prefer asyncio for I/O-bound tasks. When reviewing code, highlight security issues first.`}
                      rows={10}
                      value={wsSystemPrompt}
                      onChange={e => setWsSystemPrompt(e.target.value)}
                      style={{ resize: 'vertical', fontFamily: 'monospace', fontSize: '0.85rem' }}
                    />
                    <p className={styles.hint}>
                      {t('Leave empty to use the default StarkLLM personality. Changes apply to all new messages in this workspace.')}
                    </p>
                  </div>

                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 12 }}>
                    <button
                      className="btn-primary"
                      onClick={saveWsSystemPrompt}
                      disabled={wsPromptLoading}
                    >
                      {wsPromptLoading ? t('Saving…') : wsPromptSaved ? <><CheckCircle size={14} /> {t('Saved!')}</> : <><Save size={14} /> {t('Save Persona')}</>}
                    </button>
                    {wsSystemPrompt && (
                      <button
                        className="btn-secondary"
                        onClick={() => { setWsSystemPrompt(''); saveWsSystemPrompt(); }}
                        style={{ opacity: 0.7 }}
                      >
                        {t('Clear')}
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          {/* ───── Model & Generation ───── */}
          {activeSection === 'model' && (
            <div className={styles.panel}>
              <div className={styles.panelHeader}>
                <Cpu size={18} />
                <h2>{t('Model & Generation')}</h2>
              </div>
              <p className={styles.panelDesc}>
                {t('Fine-tune the language model\'s output generation parameters.')}
              </p>

              <div className={styles.formGroup}>
                <label className={styles.label}>{t('AI Inference Provider')}</label>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 4 }}>
                  <button 
                    type="button"
                    onClick={() => setProvider('ollama')}
                    style={{
                      padding: '12px 14px',
                      borderRadius: 8,
                      border: provider === 'ollama' ? '1px solid var(--accent)' : '1px solid rgba(255,255,255,0.08)',
                      background: provider === 'ollama' ? 'rgba(99,102,241,0.15)' : 'rgba(255,255,255,0.03)',
                      color: provider === 'ollama' ? '#ffffff' : 'var(--text-secondary)',
                      cursor: 'pointer',
                      textAlign: 'left'
                    }}
                  >
                    <div style={{ fontWeight: 600, fontSize: '0.9rem', marginBottom: 2 }}>{t('🏠 Local Ollama')}</div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{t('100% Private & Offline')}</div>
                  </button>

                  <button 
                    type="button"
                    onClick={() => setProvider('openai_compatible')}
                    style={{
                      padding: '12px 14px',
                      borderRadius: 8,
                      border: provider === 'openai_compatible' ? '1px solid var(--accent)' : '1px solid rgba(255,255,255,0.08)',
                      background: provider === 'openai_compatible' ? 'rgba(99,102,241,0.15)' : 'rgba(255,255,255,0.03)',
                      color: provider === 'openai_compatible' ? '#ffffff' : 'var(--text-secondary)',
                      cursor: 'pointer',
                      textAlign: 'left'
                    }}
                  >
                    <div style={{ fontWeight: 600, fontSize: '0.9rem', marginBottom: 2 }}>{t('🌐 Custom / Cloud API')}</div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{t('DeepSeek, OpenRouter, Groq, LM Studio')}</div>
                  </button>
                </div>
              </div>

              {provider === 'openai_compatible' && (
                <div style={{
                  background: 'rgba(255, 255, 255, 0.025)',
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                  borderRadius: 8,
                  padding: 16,
                  marginBottom: 16,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 12
                }}>
                  <div>
                    <label style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 600, display: 'block', marginBottom: 6 }}>{t('Quick Presets')}</label>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <button 
                        type="button" 
                        className="badge badge-accent" 
                        style={{ cursor: 'pointer', padding: '5px 10px' }}
                        onClick={() => {
                          setBaseUrl('https://api.deepseek.com/v1');
                          setCustomModel('deepseek-chat');
                        }}
                      >
                        {t('DeepSeek (V3)')}
                      </button>
                      <button 
                        type="button" 
                        className="badge badge-accent" 
                        style={{ cursor: 'pointer', padding: '5px 10px' }}
                        onClick={() => {
                          setBaseUrl('https://api.deepseek.com/v1');
                          setCustomModel('deepseek-reasoner');
                        }}
                      >
                        {t('DeepSeek R1 (Reasoning)')}
                      </button>
                      <button 
                        type="button" 
                        className="badge badge-accent" 
                        style={{ cursor: 'pointer', padding: '5px 10px' }}
                        onClick={() => {
                          setBaseUrl('https://openrouter.ai/api/v1');
                          setCustomModel('anthropic/claude-3.5-sonnet');
                        }}
                      >
                        {t('OpenRouter (Claude 3.5)')}
                      </button>
                      <button 
                        type="button" 
                        className="badge badge-accent" 
                        style={{ cursor: 'pointer', padding: '5px 10px' }}
                        onClick={() => {
                          setBaseUrl('https://api.groq.com/openai/v1');
                          setCustomModel('llama-3.3-70b-versatile');
                        }}
                      >
                        {t('Groq Cloud (Fast)')}
                      </button>
                      <button 
                        type="button" 
                        className="badge badge-accent" 
                        style={{ cursor: 'pointer', padding: '5px 10px' }}
                        onClick={() => {
                          setBaseUrl('http://localhost:1234/v1');
                          setCustomModel('local-model');
                        }}
                      >
                        {t('LM Studio (Local)')}
                      </button>
                    </div>
                  </div>

                  <div className={styles.formGroup} style={{ marginBottom: 0 }}>
                    <label className={styles.label}>{t('Base URL')}</label>
                    <input 
                      type="text" 
                      className="input-field" 
                      placeholder={t('e.g. https://api.deepseek.com/v1')}
                      value={baseUrl}
                      onChange={e => setBaseUrl(e.target.value)}
                    />
                    {cloudHostFor('openai_compatible', baseUrl) && (
                      <div style={{ fontSize: '0.78rem', color: 'var(--warning)', marginTop: 6 }}>
                        Not local: your questions and the document passages found for them are sent to {cloudHostFor('openai_compatible', baseUrl)}. The chat shows this while it is active.
                      </div>
                    )}
                  </div>

                  <div className={styles.formGroup} style={{ marginBottom: 0 }}>
                    <label className={styles.label}>{t('API Key')}</label>
                    <input 
                      type="password" 
                      className="input-field" 
                      placeholder={t('sk-...')}
                      value={apiKey}
                      onChange={e => setApiKey(e.target.value)}
                    />
                  </div>

                  <div className={styles.formGroup} style={{ marginBottom: 0 }}>
                    <label className={styles.label}>{t('Model ID')}</label>
                    <input 
                      type="text" 
                      className="input-field" 
                      placeholder={t('e.g. deepseek-chat, gpt-4o, claude-3-5-sonnet')}
                      value={customModel}
                      onChange={e => setCustomModel(e.target.value)}
                    />
                  </div>

                  <div style={{ fontSize: '0.75rem', color: '#f59e0b', background: 'rgba(245, 158, 11, 0.08)', padding: '6px 10px', borderRadius: 6, border: '1px solid rgba(245, 158, 11, 0.2)' }}>
                    🔒 <strong>{t('Privacy Note:')}</strong> {t('When using external cloud APIs, chat messages are transmitted to the external provider\'s servers.')}
                  </div>
                </div>
              )}

              {provider === 'ollama' && (
                <div className={styles.formGroup}>
                  <label className={styles.label}>{t('Local Ollama Model')}</label>
                  <select 
                    className="input-field" 
                    value={modelName} 
                    onChange={(e) => setModelName(e.target.value)}
                  >
                    <option value="">{t('Default Backend Model')}</option>
                    {availableModels.map(m => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                  <p className={styles.hint}>{t('Choose the active local AI model to use for chat.')}</p>
                </div>
              )}

              <div className={styles.divider} />

              <div className={styles.formGroup}>
                <label className={styles.label}>
                  {t('Temperature ({value})', { value: temperature })}
                </label>
                <input 
                  type="range" 
                  min="0.0" 
                  max="1.5" 
                  step="0.1" 
                  value={temperature}
                  onChange={(e) => setTemperature(parseFloat(e.target.value))}
                  style={{ width: '100%', accentColor: 'var(--accent-color)' }}
                />
                <p className={styles.hint}>{t('Higher values make output more creative. Lower values make it more deterministic.')}</p>
              </div>

              <div className={styles.formGroup}>
                <label className={styles.label}>
                  {t('Top P ({value})', { value: topP })}
                </label>
                <input 
                  type="range" 
                  min="0.0" 
                  max="1.0" 
                  step="0.05" 
                  value={topP}
                  onChange={(e) => setTopP(parseFloat(e.target.value))}
                  style={{ width: '100%', accentColor: 'var(--accent-color)' }}
                />
                <p className={styles.hint}>{t('Controls diversity via nucleus sampling.')}</p>
              </div>

              <div className={styles.formGroup}>
                <label className={styles.label}>{t('Max Tokens')}</label>
                <input 
                  type="number" 
                  className="input-field" 
                  placeholder={t('e.g. 1024 (leave empty for model default)')}
                  value={maxTokens}
                  onChange={(e) => setMaxTokens(e.target.value)}
                />
                <p className={styles.hint}>{t('Maximum length of the generated response.')}</p>
              </div>

              <div style={{ display: 'flex', gap: '8px', marginTop: 12 }}>
                <button className="btn-primary" onClick={saveModelSettings} disabled={modelLoading}>
                  {modelLoading ? t('Saving…') : modelSaved ? <><CheckCircle size={14} /> {t('Saved!')}</> : <><Save size={14} /> {t('Save Settings')}</>}
                </button>
                <button className="btn-secondary" onClick={resetModelSettings} disabled={modelLoading}>
                  {t('Reset to Defaults')}
                </button>
              </div>
            </div>
          )}

          {/* ───── RAG ───── */}
          {activeSection === 'rag' && (
            <div className={styles.panel}>
              <div className={styles.panelHeader}>
                <Cpu size={18} />
                <h2>{t('RAG Engine Settings')}</h2>
              </div>
              <p className={styles.panelDesc}>
                {t('Configure how StarkLLM processes and retrieves documents. These settings affect retrieval quality and performance.')}
              </p>

              <div className={styles.toggleGroup}>
                <Toggle
                  checked={semanticChunking}
                  onChange={setSemanticChunking}
                  label={t('Semantic Chunking')}
                  hint={t('Splits documents at semantic boundaries instead of fixed character counts. Improves context quality.')}
                />
                <Toggle
                  checked={hybridSearch}
                  onChange={setHybridSearch}
                  label={t('Hybrid Search (Vector + TF-IDF)')}
                  hint={t('Combines vector similarity and keyword relevance using Reciprocal Rank Fusion.')}
                />
                <Toggle
                  checked={queryRewriting}
                  onChange={setQueryRewriting}
                  label={t('Query Rewriting')}
                  hint={t('Generates expanded query variants using the LLM to improve recall.')}
                />
                <Toggle
                  checked={contextCompression}
                  onChange={setContextCompression}
                  label={t('Context Compression')}
                  hint={t('Removes duplicate sentences across retrieved chunks before sending to the LLM.')}
                />
              </div>

              <button className="btn-primary" onClick={saveRag}>
                {ragSaved ? <><CheckCircle size={14} /> {t('Saved!')}</> : <><Save size={14} /> {t('Save RAG Settings')}</>}
              </button>

              <div className={styles.infoBox}>
                <strong>{t('Note:')}</strong> {t('These settings are stored locally. The backend defaults are controlled via')} <code>{t('config.py')}</code>.
              </div>
            </div>
          )}

          {/* ───── KB ───── */}
          {activeSection === 'kb' && (
            <div className={styles.panel}>
              <div className={styles.panelHeader}>
                <Database size={18} />
                <h2>{t('Knowledge Base Settings')}</h2>
              </div>
              <p className={styles.panelDesc}>
                {t('Control how documents are indexed and managed in your personal Knowledge Base.')}
              </p>

              <div className={styles.toggleGroup}>
                <Toggle
                  checked={autoIndex}
                  onChange={setAutoIndex}
                  label={t('Auto-index on Upload')}
                  hint={t('Automatically start indexing documents when they are added to a folder.')}
                />
              </div>

              <div className={styles.formGroup}>
                <label className={styles.label}>{t('Supported File Types')}</label>
                <div className={styles.tagList}>
                  {['PDF', 'DOCX', 'PNG', 'JPG', 'JPEG'].map(t => (
                    <span key={t} className="badge badge-accent">{t}</span>
                  ))}
                </div>
                <p className={styles.hint}>{t('Only the formats listed above can be indexed in the Knowledge Base.')}</p>
              </div>

              <button className="btn-primary" onClick={saveKb}>
                {kbSaved ? <><CheckCircle size={14} /> {t('Saved!')}</> : <><Save size={14} /> {t('Save KB Settings')}</>}
              </button>
            </div>
          )}

          {/* ───── MCP Host ───── */}
          {activeSection === 'mcp' && (
            <div className={styles.panel}>
              <div className={styles.panelHeader}>
                <Terminal size={18} />
                <h2>{t('Local MCP Host (Model Context Protocol)')}</h2>
              </div>
              <p className={styles.panelDesc}>
                {t('StarkLLM acts as a local, read-only MCP host for the model. All tool calls require explicit manual confirmation in the UI before execution, with arguments visible and editable.')}
              </p>

              <div className={styles.toggleGroup}>
                <Toggle
                  checked={mcpEnabled}
                  onChange={(val) => {
                    setMcpEnabled(val);
                    saveMcpSettings({ enabled: val });
                  }}
                  label={t('Enable Local MCP Host')}
                  hint={t('Allow the model to request local read-only tool calls (Workspace file listing, KB search, chunk inspection).')}
                />
              </div>

              <div className={styles.divider} />

              <h3 className={styles.h3} style={{ marginTop: '1.2rem', marginBottom: '0.6rem' }}>{t('Active Read-Only Tools')}</h3>
              <div className={styles.toggleGroup}>
                <Toggle
                  checked={mcpTools.list_workspace_files !== false}
                  onChange={(val) => {
                    const updated = { ...mcpTools, list_workspace_files: val };
                    setMcpTools(updated);
                    saveMcpSettings({ tools: updated });
                  }}
                  label={t('list_workspace_files')}
                  hint={t('Lists files and document metadata in the user\'s active workspace.')}
                />
                <Toggle
                  checked={mcpTools.search_local_kb !== false}
                  onChange={(val) => {
                    const updated = { ...mcpTools, search_local_kb: val };
                    setMcpTools(updated);
                    saveMcpSettings({ tools: updated });
                  }}
                  label={t('search_local_kb')}
                  hint={t('Performs hybrid retrieval against the local Knowledge Base and returns passage locators.')}
                />
                <Toggle
                  checked={mcpTools.fetch_cited_chunk !== false}
                  onChange={(val) => {
                    const updated = { ...mcpTools, fetch_cited_chunk: val };
                    setMcpTools(updated);
                    saveMcpSettings({ tools: updated });
                  }}
                  label={t('fetch_cited_chunk')}
                  hint={t('Fetches the exact text chunk for a cited document locator.')}
                />
              </div>

              <div className={styles.divider} />

              <div className={styles.formGroup}>
                <label className={styles.label}>{t('Configured Servers (Local Only)')}</label>
                <div style={{ background: 'rgba(0,0,0,0.3)', padding: '0.8rem 1rem', borderRadius: '6px', border: '1px solid #333', fontSize: '0.88rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <strong>{t('StarkLLM Builtin (In-Process)')}</strong>
                    <span className="badge badge-success" style={{ fontSize: '0.75rem' }}>{t('CONNECTED (READ-ONLY)')}</span>
                  </div>
                  <p style={{ color: 'var(--text-secondary)', margin: '0.4rem 0 0', fontSize: '0.82rem' }}>
                    {t('Type: in-process • Zero network egress • Localhost only')}
                  </p>
                </div>
              </div>

              <div className={styles.infoBox} style={{ marginTop: '1.2rem' }}>
                <strong>{t('Zero-Cloud Guarantee:')}</strong> {t('Tool execution runs 100% on your local machine. No external MCP registry is contacted, and every tool call requires manual user confirmation before running.')}
              </div>
            </div>
          )}

          {/* ───── Local API Server (OpenAI-Compatible) ───── */}
          {activeSection === 'dev-api' && (
            <div className={styles.panel}>
              <div className={styles.panelHeader}>
                <Server size={18} />
                <h2>{t('Local OpenAI-Compatible API Server')}</h2>
              </div>
              <p className={styles.panelDesc}>
                {t('Connect external developer tools (Cursor, VSCode Continue, Obsidian, Python SDK, cURL) directly to your local StarkLLM instance.')}
              </p>

              {/* Endpoint Status Card */}
              <div style={{
                padding: '14px 18px',
                background: 'rgba(16, 185, 129, 0.08)',
                border: '1px solid rgba(16, 185, 129, 0.25)',
                borderRadius: '8px',
                marginBottom: '20px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: '12px'
              }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                    <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#10b981' }}></span>
                    <strong style={{ color: '#10b981', fontSize: '0.88rem' }}>{t('Server Active & Ready')}</strong>
                  </div>
                  <div style={{ fontFamily: 'monospace', fontSize: '0.82rem', color: '#e5e7eb' }}>
                    {t('Base URL:')} <code style={{ color: '#6ee7b7' }}>http://localhost:8000/v1</code>
                  </div>
                </div>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={handleTestApi}
                  disabled={testingApi}
                  style={{ padding: '6px 14px', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '6px', background: '#10b981' }}
                >
                  {testingApi ? <Loader size={13} className="animate-spin" /> : <Play size={13} />}
                  <span>{apiLatency !== null ? t('Online ({ms} ms)', { ms: apiLatency }) : t('Test Connection')}</span>
                </button>
              </div>

              {/* Quick Connect Guides */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                {/* 1. Cursor / Continue Config */}
                <div style={{
                  padding: '14px',
                  background: 'rgba(255, 255, 255, 0.03)',
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                  borderRadius: '8px'
                }}>
                  <h4 style={{ margin: '0 0 10px 0', fontSize: '0.85rem', fontWeight: 600, color: '#f3f4f6' }}>
                    {t('1. Cursor / VSCode Continue Settings')}
                  </h4>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '10px' }}>
                    <div style={{ padding: '8px 12px', background: 'rgba(0,0,0,0.3)', borderRadius: '6px' }}>
                      <span style={{ fontSize: '0.7rem', color: '#9ca3af', display: 'block' }}>{t('Base URL')}</span>
                      <code style={{ fontSize: '0.8rem', color: '#818cf8' }}>http://localhost:8000/v1</code>
                    </div>
                    <div style={{ padding: '8px 12px', background: 'rgba(0,0,0,0.3)', borderRadius: '6px' }}>
                      <span style={{ fontSize: '0.7rem', color: '#9ca3af', display: 'block' }}>{t('Model ID')}</span>
                      <code style={{ fontSize: '0.8rem', color: '#818cf8' }}>{t('starkllm-default')}</code>
                    </div>
                    <div style={{ padding: '8px 12px', background: 'rgba(0,0,0,0.3)', borderRadius: '6px' }}>
                      <span style={{ fontSize: '0.7rem', color: '#9ca3af', display: 'block' }}>{t('API Key (Any string)')}</span>
                      <code style={{ fontSize: '0.8rem', color: '#818cf8' }}>{t('stark-local')}</code>
                    </div>
                  </div>
                </div>

                {/* 2. Python SDK Snippet */}
                <div style={{
                  padding: '14px',
                  background: 'rgba(255, 255, 255, 0.03)',
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                  borderRadius: '8px'
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                    <h4 style={{ margin: 0, fontSize: '0.85rem', fontWeight: 600, color: '#f3f4f6' }}>
                      {t('2. Python (openai SDK)')}
                    </h4>
                    <button
                      type="button"
                      className="badge badge-accent"
                      onClick={() => handleCopySnippet(pythonSnippet, 'py')}
                      style={{ cursor: 'pointer', padding: '3px 8px', fontSize: '0.72rem' }}
                    >
                      {copiedSnippet === 'py' ? t('Copied!') : t('Copy Code')}
                    </button>
                  </div>
                  <pre style={{
                    margin: 0,
                    padding: '10px 12px',
                    background: '#0d1117',
                    borderRadius: '6px',
                    fontSize: '0.78rem',
                    color: '#c9d1d9',
                    fontFamily: 'monospace',
                    overflowX: 'auto',
                    lineHeight: 1.45
                  }}>
                    {pythonSnippet}
                  </pre>
                </div>

                {/* 3. cURL Command */}
                <div style={{
                  padding: '14px',
                  background: 'rgba(255, 255, 255, 0.03)',
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                  borderRadius: '8px'
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                    <h4 style={{ margin: 0, fontSize: '0.85rem', fontWeight: 600, color: '#f3f4f6' }}>
                      {t('3. cURL Command')}
                    </h4>
                    <button
                      type="button"
                      className="badge badge-accent"
                      onClick={() => handleCopySnippet(curlSnippet, 'curl')}
                      style={{ cursor: 'pointer', padding: '3px 8px', fontSize: '0.72rem' }}
                    >
                      {copiedSnippet === 'curl' ? t('Copied!') : t('Copy cURL')}
                    </button>
                  </div>
                  <pre style={{
                    margin: 0,
                    padding: '10px 12px',
                    background: '#0d1117',
                    borderRadius: '6px',
                    fontSize: '0.78rem',
                    color: '#c9d1d9',
                    fontFamily: 'monospace',
                    overflowX: 'auto',
                    lineHeight: 1.45
                  }}>
                    {curlSnippet}
                  </pre>
                </div>
              </div>
            </div>
          )}

          {/* ───── UI ───── */}
          {activeSection === 'ui' && (
            <div className={styles.panel}>
              <div className={styles.panelHeader}>
                <Palette size={18} />
                <h2>{t('Appearance')}</h2>
              </div>
              <p className={styles.panelDesc}>
                {t('Customize the visual experience of StarkLLM.')}
              </p>

              <div className={styles.formGroup}>
                <label className={styles.label}>{t('Font Size')}</label>
                <div className={styles.segmentedControl}>
                  {['small', 'medium', 'large'].map(size => (
                    <button
                      key={size}
                      className={`${styles.segment} ${fontSize === size ? styles.segmentActive : ''}`}
                      onClick={() => setFontSize(size)}
                    >
                      {size.charAt(0).toUpperCase() + size.slice(1)}
                    </button>
                  ))}
                </div>
              </div>

              <div className={styles.formGroup}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '8px' }}>
                  <label className={styles.label} style={{ margin: 0 }}>{t('Color Theme & Palette')}</label>
                  <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                    {AVAILABLE_THEMES.length} Presets Available
                  </span>
                </div>
                <div className={styles.themeGrid}>
                  {AVAILABLE_THEMES.map(t => {
                    const isSelected = theme === t.id;
                    return (
                      <div
                        key={t.id}
                        className={`${styles.themeCard} ${isSelected ? styles.themeCardActive : ''}`}
                        onClick={() => handleThemeChange(t.id)}
                        role="button"
                        tabIndex={0}
                      >
                        {/* Visual Preview Banner */}
                        <div
                          className={styles.themePreviewBanner}
                          style={{
                            background: t.card,
                            borderLeft: `4px solid ${t.accent}`
                          }}
                        >
                          <div className={styles.themeDotGroup}>
                            <span className={styles.themeDot} style={{ background: t.bg }} title={t('Background')} />
                            <span className={styles.themeDot} style={{ background: t.card }} title={t('Surface')} />
                            <span className={styles.themeDot} style={{ background: t.accent, boxShadow: `0 0 8px ${t.accent}` }} title={t('Accent')} />
                          </div>
                          <div
                            style={{
                              width: '28px',
                              height: '14px',
                              borderRadius: '4px',
                              background: t.gradient,
                              opacity: 0.95
                            }}
                          />
                        </div>

                        {/* Text info */}
                        <div className={styles.themeCardBody}>
                          <div className={styles.themeTitleRow}>
                            <span className={styles.themeName}>{t.name}</span>
                            <span className={styles.themeBadge}>{t.badge}</span>
                          </div>
                          <p className={styles.themeDesc}>{t.desc}</p>
                        </div>

                        {isSelected && <CheckCircle size={18} className={styles.themeCheck} />}
                      </div>
                    );
                  })}
                </div>
              </div>

              <button className="btn-primary" onClick={saveUi}>
                {uiSaved ? <><CheckCircle size={14} /> {t('Applied!')}</> : <><Save size={14} /> {t('Apply Settings')}</>}
              </button>
            </div>
          )}

          {/* ───── Language & Locale ───── */}
          {activeSection === 'language' && (
            <div className={styles.panel}>
              <div className={styles.panelHeader}>
                <Globe size={24} className={styles.panelIcon} />
                <h2>{t('Language & Locale')}</h2>
              </div>
              <p className={styles.panelDesc}>
                {t('Without a choice here, StarkLLM uses the language of Windows. The page reloads when you change it.')}
              </p>

              <div className={styles.languageGrid}>
                {SUPPORTED_LANGUAGES.map(lang => {
                  const isActive = lang.code === language();
                  return (
                    <div
                      key={lang.code}
                      className={`${styles.languageCard} ${isActive ? styles.languageCardActive : ''}`}
                      onClick={() => setLanguage(lang.code)}
                    >
                      <div className={styles.languageHeaderRow}>
                        <div className={styles.languageTitleGroup}>
                          <span className={styles.languageFlag}>{lang.flag}</span>
                          <div className={styles.languageNames}>
                            <span className={styles.languageNative}>{lang.nativeName}</span>
                            <span className={styles.languageEnglish}>{lang.name}</span>
                          </div>
                        </div>
                        {isActive ? (
                          <span className={styles.languageBadgeActive}>{t('Active')}</span>
                        ) : (
                          <span className={styles.languageBadgeRoadmap}>{t('Select')}</span>
                        )}
                      </div>

                      <div className={styles.languageFooterRow}>
                        <span>{lang.region}</span>
                        <strong>{lang.users}</strong>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className={styles.languageRoadmapNotice}>
                <strong>{t('German interface')}</strong>
                <span>
                  {t('The start page, the side bar and the sign-in are in German; the other pages follow step by step and are shown in English until then.')}
                </span>
              </div>
            </div>
          )}

          {/* ───── Keyboard Shortcuts ───── */}
          {activeSection === 'shortcuts' && (
            <div className={styles.panel}>
              <div className={styles.panelHeader}>
                <Keyboard size={18} />
                <h2>{t('Keyboard Shortcuts')}</h2>
              </div>
              <p className={styles.panelDesc}>
                {t('Quick reference for all keyboard shortcuts available in StarkLLM.')}
              </p>

              {[
                {
                  category: t('Navigation & Search'),
                  shortcuts: [
                    { keys: ['Ctrl', 'K'], desc: t('Open Global Search / Command Palette') },
                    { keys: ['Esc'], desc: t('Close modal, dialog, or dropdown') },
                  ]
                },
                {
                  category: t('Chat'),
                  shortcuts: [
                    { keys: ['Enter'], desc: t('Send message') },
                    { keys: ['Shift', 'Enter'], desc: t('Insert new line in message') },
                    { keys: ['Ctrl', 'Z'], desc: t('Undo text in input field') },
                  ]
                },
                {
                  category: t('Message Actions'),
                  shortcuts: [
                    { keys: ['Click Copy'], desc: t('Copy message content to clipboard') },
                    { keys: ['Click Edit ✏️'], desc: t('Edit a user message (re-runs from that point)') },
                    { keys: ['Click Regenerate ↺'], desc: t('Regenerate the last AI response') },
                  ]
                },
                {
                  category: t('Input Bar'),
                  shortcuts: [
                    { keys: ['Paperclip 📎'], desc: t('Attach file (PDF, TXT, PNG, JPG)') },
                    { keys: ['Mic 🎙️'], desc: t('Start / Stop voice recording (Whisper transcription)') },
                    { keys: ['FileCode 📝'], desc: t('Open Prompt Templates library') },
                    { keys: ['Database 🗃️'], desc: t('Toggle Knowledge Base retrieval') },
                    { keys: ['Globe 🌐'], desc: t('Toggle Web Search') },
                  ]
                },
              ].map(group => (
                <div key={group.category} style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <div className={styles.panelSubheader} style={{ marginTop: '8px' }}>
                    {group.category}
                  </div>
                  <div style={{
                    background: 'var(--bg-tertiary)',
                    border: '1px solid var(--border-color)',
                    borderRadius: 'var(--radius-md)',
                    overflow: 'hidden'
                  }}>
                    {group.shortcuts.map((s, si) => (
                      <div key={si} style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '10px 16px',
                        borderBottom: si < group.shortcuts.length - 1 ? '1px solid var(--border-subtle)' : 'none',
                        gap: '16px'
                      }}>
                        <span style={{ fontSize: '0.88rem', color: 'var(--text-secondary)' }}>{s.desc}</span>
                        <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                          {s.keys.map((k, ki) => (
                            <React.Fragment key={ki}>
                              {ki > 0 && <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem', alignSelf: 'center' }}>+</span>}
                              <kbd style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                padding: '2px 8px',
                                background: 'var(--bg-primary)',
                                border: '1px solid var(--border-color)',
                                borderBottom: '2px solid var(--border-color)',
                                borderRadius: '6px',
                                fontSize: '0.78rem',
                                fontFamily: 'ui-monospace, monospace',
                                color: 'var(--text-primary)',
                                fontWeight: 500,
                                whiteSpace: 'nowrap'
                              }}>{k}</kbd>
                            </React.Fragment>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* ───── System ───── */}
          {activeSection === 'system' && (
            <BackupRestoreSettings token={token} />
          )}

          {/* ───── About ───── */}
          {activeSection === 'about' && (
            <div className={styles.panel}>
              <div className={styles.panelHeader}>
                <Info size={18} />
                <h2>{t('About StarkLLM')}</h2>
              </div>
              
              <div className={styles.aboutCard}>
                <div className={styles.aboutHeader}>
                  <h4>StarkLLM</h4>
                  <span className={styles.aboutVersion}>{appVersion ? t('Version {version}', { version: appVersion }) : t('Version unknown')}</span>
                  {desktop && (
                    <button type="button" className="btn-primary" style={{ marginLeft: 'auto', alignSelf: 'center' }} onClick={checkForUpdates} disabled={updateState === 'Checking...'}>
                      {updateState === 'Checking...' ? t('Checking...') : t('Check for updates')}
                    </button>
                  )}
                </div>
                {updateState && updateState !== 'Checking...' && <p className={styles.aboutText}>{updateState}</p>}
                
                <p className={styles.aboutText}>
                  {t('StarkLLM is')} <strong>{t('free')}</strong> {t('and')} <strong>{t('open source')}</strong> {t('under the')} <strong>{t('Apache License 2.0')}</strong>. 
                  It is designed from the ground up with a local-first privacy architecture, ensuring your data stays securely on your machine.
                </p>

                <p className={styles.aboutText}>
                  {t('Because the code is open, you can check what the app sends over the network: nothing, unless you turn on a cloud model or web search yourself.')}
                </p>

                <div className={styles.aboutGrid}>
                  <div className={styles.aboutGridItem}>
                    <span className={styles.aboutLabel}>{t('Created by')}</span>
                    <span className={styles.aboutValue}>{t('Christian Stark')}</span>
                  </div>
                  <div className={styles.aboutGridItem}>
                    <span className={styles.aboutLabel}>{t('Contact Email')}</span>
                    <span className={styles.aboutValue}>
                      <a href="mailto:info@starkllm.com">{t('info@starkllm.com')}</a>
                    </span>
                  </div>
                  <div className={styles.aboutGridItem}>
                    <span className={styles.aboutLabel}>{t('Official Website')}</span>
                    <span className={styles.aboutValue}>
                      <a href="https://starkllm.com" target="_blank" rel="noreferrer">https://starkllm.com</a>
                    </span>
                  </div>
                  <div className={styles.aboutGridItem}>
                    <span className={styles.aboutLabel}>{t('Location')}</span>
                    <span className={styles.aboutValue}>{t('Maxstr. 14')}<br/><span className={styles.aboutMuted}>{t('52070 Aachen')}</span></span>
                  </div>
                </div>

                <div className={styles.aboutLegal}>
                  <strong>{t('No Warranty / No Liability:')}</strong> This software is provided "as is", 
                  without warranty of any kind, express or implied. In no event shall the authors 
                  be liable for any claim, damages or other liability.
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
