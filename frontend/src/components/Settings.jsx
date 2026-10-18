import React, { useState, useEffect } from 'react';
import { User, Shield, Cpu, Database, Palette, Save, CheckCircle, ChevronRight, Moon, Sun, Archive, FileText, Info, Terminal } from 'lucide-react';
import styles from './Settings.module.css';
import BackupRestoreSettings from './BackupRestoreSettings';

const SECTIONS = [
  { id: 'account',  label: 'Account',       icon: User },
  { id: 'instructions', label: 'Custom Instructions', icon: FileText },
  { id: 'model',    label: 'Model Settings',icon: Cpu },
  { id: 'rag',      label: 'RAG Engine',    icon: Database },
  { id: 'kb',       label: 'Knowledge Base', icon: Shield },
  { id: 'mcp',      label: 'Local Tools',   icon: Terminal },
  { id: 'ui',       label: 'Appearance',    icon: Palette },
  { id: 'system',   label: 'Backup & Restore', icon: Archive },
  { id: 'about',    label: 'About StarkLLM',icon: Info },
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

export default function Settings({ token, username }) {
  // Account
  const [newPassword, setNewPassword] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [pwMsg, setPwMsg] = useState(null);
  const [pwLoading, setPwLoading] = useState(false);

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

  // Apply saved theme on mount
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleThemeChange = (newTheme) => {
    setTheme(newTheme);
    document.documentElement.setAttribute('data-theme', newTheme);
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
      setPwMsg({ type: 'error', text: 'Passwords do not match.' });
      return;
    }
    if (newPassword.length < 6) {
      setPwMsg({ type: 'error', text: 'Password must be at least 6 characters.' });
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
        setPwMsg({ type: 'success', text: 'Password changed successfully!' });
        setNewPassword('');
        setConfirmPw('');
      } else {
        const err = await res.json().catch(() => ({}));
        setPwMsg({ type: 'error', text: err.detail || 'Failed to change password.' });
      }
    } catch {
      setPwMsg({ type: 'error', text: 'Network error. Please try again.' });
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
        <h1 className={styles.pageTitle}>Settings</h1>
        <p className={styles.pageSubtitle}>Manage your account and application preferences.</p>
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
                <h2>Account Settings</h2>
              </div>

              <div className={styles.formGroup}>
                <label className={styles.label}>Username</label>
                <div className={styles.staticField}>{username || '—'}</div>
                <p className={styles.hint}>Your username cannot be changed after registration.</p>
              </div>

              <div className={styles.divider} />

              <form onSubmit={handleChangePassword} className={styles.form}>
                <div className={styles.panelSubheader}>
                  <Shield size={15} />
                  Change Password
                </div>

                <div className={styles.formGroup}>
                  <label className={styles.label}>New Password</label>
                  <input
                    type="password"
                    className="input-field"
                    placeholder="Enter new password"
                    value={newPassword}
                    onChange={e => setNewPassword(e.target.value)}
                    minLength={6}
                    required
                  />
                </div>

                <div className={styles.formGroup}>
                  <label className={styles.label}>Confirm Password</label>
                  <input
                    type="password"
                    className="input-field"
                    placeholder="Re-enter new password"
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
                  {pwLoading ? 'Saving…' : <><Save size={14} /> Change Password</>}
                </button>
              </form>
            </div>
          )}

          {/* ───── Custom Instructions ───── */}
          {activeSection === 'instructions' && (
            <div className={styles.panel}>
              <div className={styles.panelHeader}>
                <FileText size={18} />
                <h2>Custom Instructions</h2>
              </div>
              <p className={styles.panelDesc}>
                Personalize how StarkLLM interacts with you globally. These settings shape the AI's default behavior and persona.
              </p>

              <div className={styles.formGroup}>
                <label className={styles.label}>Profile Context</label>
                <textarea
                  className="input-field"
                  placeholder="What would you like StarkLLM to know about you to provide better responses? (e.g. I work as a frontend developer, I live in Berlin...)"
                  rows={4}
                  value={profileContext}
                  onChange={e => setProfileContext(e.target.value)}
                  style={{ resize: 'vertical' }}
                />
              </div>

              <div className={styles.formGroup}>
                <label className={styles.label}>Custom Instructions</label>
                <textarea
                  className="input-field"
                  placeholder="How would you like StarkLLM to respond? (e.g. Always be concise, use bullet points, adopt a formal tone...)"
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
                {instructionsLoading ? 'Saving…' : instructionsSaved ? <><CheckCircle size={14} /> Saved!</> : <><Save size={14} /> Save Instructions</>}
              </button>
            </div>
          )}

          {/* ───── Model & Generation ───── */}
          {activeSection === 'model' && (
            <div className={styles.panel}>
              <div className={styles.panelHeader}>
                <Cpu size={18} />
                <h2>Model & Generation</h2>
              </div>
              <p className={styles.panelDesc}>
                Fine-tune the language model's output generation parameters.
              </p>

              <div className={styles.formGroup}>
                <label className={styles.label}>AI Inference Provider</label>
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
                    <div style={{ fontWeight: 600, fontSize: '0.9rem', marginBottom: 2 }}>🏠 Local Ollama</div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>100% Private & Offline</div>
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
                    <div style={{ fontWeight: 600, fontSize: '0.9rem', marginBottom: 2 }}>🌐 Custom / Cloud API</div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>DeepSeek, OpenRouter, Groq, LM Studio</div>
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
                    <label style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 600, display: 'block', marginBottom: 6 }}>Quick Presets</label>
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
                        DeepSeek (V3)
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
                        DeepSeek R1 (Reasoning)
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
                        OpenRouter (Claude 3.5)
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
                        Groq Cloud (Fast)
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
                        LM Studio (Local)
                      </button>
                    </div>
                  </div>

                  <div className={styles.formGroup} style={{ marginBottom: 0 }}>
                    <label className={styles.label}>Base URL</label>
                    <input 
                      type="text" 
                      className="input-field" 
                      placeholder="e.g. https://api.deepseek.com/v1"
                      value={baseUrl}
                      onChange={e => setBaseUrl(e.target.value)}
                    />
                  </div>

                  <div className={styles.formGroup} style={{ marginBottom: 0 }}>
                    <label className={styles.label}>API Key</label>
                    <input 
                      type="password" 
                      className="input-field" 
                      placeholder="sk-..."
                      value={apiKey}
                      onChange={e => setApiKey(e.target.value)}
                    />
                  </div>

                  <div className={styles.formGroup} style={{ marginBottom: 0 }}>
                    <label className={styles.label}>Model ID</label>
                    <input 
                      type="text" 
                      className="input-field" 
                      placeholder="e.g. deepseek-chat, gpt-4o, claude-3-5-sonnet"
                      value={customModel}
                      onChange={e => setCustomModel(e.target.value)}
                    />
                  </div>

                  <div style={{ fontSize: '0.75rem', color: '#f59e0b', background: 'rgba(245, 158, 11, 0.08)', padding: '6px 10px', borderRadius: 6, border: '1px solid rgba(245, 158, 11, 0.2)' }}>
                    🔒 <strong>Privacy Note:</strong> When using external cloud APIs, chat messages are transmitted to the external provider's servers.
                  </div>
                </div>
              )}

              {provider === 'ollama' && (
                <div className={styles.formGroup}>
                  <label className={styles.label}>Local Ollama Model</label>
                  <select 
                    className="input-field" 
                    value={modelName} 
                    onChange={(e) => setModelName(e.target.value)}
                  >
                    <option value="">Default Backend Model</option>
                    {availableModels.map(m => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                  <p className={styles.hint}>Choose the active local AI model to use for chat.</p>
                </div>
              )}

              <div className={styles.divider} />

              <div className={styles.formGroup}>
                <label className={styles.label}>
                  Temperature ({temperature})
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
                <p className={styles.hint}>Higher values make output more creative. Lower values make it more deterministic.</p>
              </div>

              <div className={styles.formGroup}>
                <label className={styles.label}>
                  Top P ({topP})
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
                <p className={styles.hint}>Controls diversity via nucleus sampling.</p>
              </div>

              <div className={styles.formGroup}>
                <label className={styles.label}>Max Tokens</label>
                <input 
                  type="number" 
                  className="input-field" 
                  placeholder="e.g. 1024 (leave empty for model default)"
                  value={maxTokens}
                  onChange={(e) => setMaxTokens(e.target.value)}
                />
                <p className={styles.hint}>Maximum length of the generated response.</p>
              </div>

              <div style={{ display: 'flex', gap: '8px', marginTop: 12 }}>
                <button className="btn-primary" onClick={saveModelSettings} disabled={modelLoading}>
                  {modelLoading ? 'Saving…' : modelSaved ? <><CheckCircle size={14} /> Saved!</> : <><Save size={14} /> Save Settings</>}
                </button>
                <button className="btn-secondary" onClick={resetModelSettings} disabled={modelLoading}>
                  Reset to Defaults
                </button>
              </div>
            </div>
          )}

          {/* ───── RAG ───── */}
          {activeSection === 'rag' && (
            <div className={styles.panel}>
              <div className={styles.panelHeader}>
                <Cpu size={18} />
                <h2>RAG Engine Settings</h2>
              </div>
              <p className={styles.panelDesc}>
                Configure how StarkLLM processes and retrieves documents. These settings affect retrieval quality and performance.
              </p>

              <div className={styles.toggleGroup}>
                <Toggle
                  checked={semanticChunking}
                  onChange={setSemanticChunking}
                  label="Semantic Chunking"
                  hint="Splits documents at semantic boundaries instead of fixed character counts. Improves context quality."
                />
                <Toggle
                  checked={hybridSearch}
                  onChange={setHybridSearch}
                  label="Hybrid Search (Vector + TF-IDF)"
                  hint="Combines vector similarity and keyword relevance using Reciprocal Rank Fusion."
                />
                <Toggle
                  checked={queryRewriting}
                  onChange={setQueryRewriting}
                  label="Query Rewriting"
                  hint="Generates expanded query variants using the LLM to improve recall."
                />
                <Toggle
                  checked={contextCompression}
                  onChange={setContextCompression}
                  label="Context Compression"
                  hint="Removes duplicate sentences across retrieved chunks before sending to the LLM."
                />
              </div>

              <button className="btn-primary" onClick={saveRag}>
                {ragSaved ? <><CheckCircle size={14} /> Saved!</> : <><Save size={14} /> Save RAG Settings</>}
              </button>

              <div className={styles.infoBox}>
                <strong>Note:</strong> These settings are stored locally. The backend defaults are controlled via <code>config.py</code>.
              </div>
            </div>
          )}

          {/* ───── KB ───── */}
          {activeSection === 'kb' && (
            <div className={styles.panel}>
              <div className={styles.panelHeader}>
                <Database size={18} />
                <h2>Knowledge Base Settings</h2>
              </div>
              <p className={styles.panelDesc}>
                Control how documents are indexed and managed in your personal Knowledge Base.
              </p>

              <div className={styles.toggleGroup}>
                <Toggle
                  checked={autoIndex}
                  onChange={setAutoIndex}
                  label="Auto-index on Upload"
                  hint="Automatically start indexing documents when they are added to a folder."
                />
              </div>

              <div className={styles.formGroup}>
                <label className={styles.label}>Supported File Types</label>
                <div className={styles.tagList}>
                  {['PDF', 'DOCX', 'PNG', 'JPG', 'JPEG'].map(t => (
                    <span key={t} className="badge badge-accent">{t}</span>
                  ))}
                </div>
                <p className={styles.hint}>Only the formats listed above can be indexed in the Knowledge Base.</p>
              </div>

              <button className="btn-primary" onClick={saveKb}>
                {kbSaved ? <><CheckCircle size={14} /> Saved!</> : <><Save size={14} /> Save KB Settings</>}
              </button>
            </div>
          )}

          {/* ───── MCP Host ───── */}
          {activeSection === 'mcp' && (
            <div className={styles.panel}>
              <div className={styles.panelHeader}>
                <Terminal size={18} />
                <h2>Local MCP Host (Model Context Protocol)</h2>
              </div>
              <p className={styles.panelDesc}>
                StarkLLM acts as a local, read-only MCP host for the model. All tool calls require explicit manual confirmation in the UI before execution, with arguments visible and editable.
              </p>

              <div className={styles.toggleGroup}>
                <Toggle
                  checked={mcpEnabled}
                  onChange={(val) => {
                    setMcpEnabled(val);
                    saveMcpSettings({ enabled: val });
                  }}
                  label="Enable Local MCP Host"
                  hint="Allow the model to request local read-only tool calls (Workspace file listing, KB search, chunk inspection)."
                />
              </div>

              <div className={styles.divider} />

              <h3 className={styles.h3} style={{ marginTop: '1.2rem', marginBottom: '0.6rem' }}>Active Read-Only Tools</h3>
              <div className={styles.toggleGroup}>
                <Toggle
                  checked={mcpTools.list_workspace_files !== false}
                  onChange={(val) => {
                    const updated = { ...mcpTools, list_workspace_files: val };
                    setMcpTools(updated);
                    saveMcpSettings({ tools: updated });
                  }}
                  label="list_workspace_files"
                  hint="Lists files and document metadata in the user's active workspace."
                />
                <Toggle
                  checked={mcpTools.search_local_kb !== false}
                  onChange={(val) => {
                    const updated = { ...mcpTools, search_local_kb: val };
                    setMcpTools(updated);
                    saveMcpSettings({ tools: updated });
                  }}
                  label="search_local_kb"
                  hint="Performs hybrid retrieval against the local Knowledge Base and returns passage locators."
                />
                <Toggle
                  checked={mcpTools.fetch_cited_chunk !== false}
                  onChange={(val) => {
                    const updated = { ...mcpTools, fetch_cited_chunk: val };
                    setMcpTools(updated);
                    saveMcpSettings({ tools: updated });
                  }}
                  label="fetch_cited_chunk"
                  hint="Fetches the exact text chunk for a cited document locator."
                />
              </div>

              <div className={styles.divider} />

              <div className={styles.formGroup}>
                <label className={styles.label}>Configured Servers (Local Only)</label>
                <div style={{ background: 'rgba(0,0,0,0.3)', padding: '0.8rem 1rem', borderRadius: '6px', border: '1px solid #333', fontSize: '0.88rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <strong>StarkLLM Builtin (In-Process)</strong>
                    <span className="badge badge-success" style={{ fontSize: '0.75rem' }}>CONNECTED (READ-ONLY)</span>
                  </div>
                  <p style={{ color: 'var(--text-secondary)', margin: '0.4rem 0 0', fontSize: '0.82rem' }}>
                    Type: in-process &bull; Zero network egress &bull; Localhost only
                  </p>
                </div>
              </div>

              <div className={styles.infoBox} style={{ marginTop: '1.2rem' }}>
                <strong>Zero-Cloud Guarantee:</strong> Tool execution runs 100% on your local machine. No external MCP registry is contacted, and every tool call requires manual user confirmation before running.
              </div>
            </div>
          )}

          {/* ───── UI ───── */}
          {activeSection === 'ui' && (
            <div className={styles.panel}>
              <div className={styles.panelHeader}>
                <Palette size={18} />
                <h2>Appearance</h2>
              </div>
              <p className={styles.panelDesc}>
                Customize the visual experience of StarkLLM.
              </p>

              <div className={styles.formGroup}>
                <label className={styles.label}>Font Size</label>
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
                <label className={styles.label}>Color Theme</label>
                <div className={styles.themeGrid}>
                  <button
                    className={`${styles.themeCard} ${theme === 'dark' ? styles.themeCardActive : ''}`}
                    onClick={() => handleThemeChange('dark')}
                  >
                    <Moon size={20} />
                    <span>Dark</span>
                    {theme === 'dark' && <CheckCircle size={14} className={styles.themeCheck} />}
                  </button>
                  <button
                    className={`${styles.themeCard} ${theme === 'light' ? styles.themeCardActive : ''}`}
                    onClick={() => handleThemeChange('light')}
                  >
                    <Sun size={20} />
                    <span>Light</span>
                    {theme === 'light' && <CheckCircle size={14} className={styles.themeCheck} />}
                  </button>
                </div>
              </div>

              <button className="btn-primary" onClick={saveUi}>
                {uiSaved ? <><CheckCircle size={14} /> Applied!</> : <><Save size={14} /> Apply Settings</>}
              </button>
            </div>
          )}

          {/* ───── System ───── */}
          {activeSection === 'system' && (
            <BackupRestoreSettings token={token} />
          )}

          {/* ───── About ───── */}
          {activeSection === 'about' && (
            <div className={styles.section}>
              <h3 className={styles.h3}>About StarkLLM</h3>
              
              <div className={styles.aboutCard}>
                <div className={styles.aboutHeader}>
                  <h4>StarkLLM</h4>
                  <span className={styles.aboutVersion}>v1.0.0-beta (Snapshot: 2026-09-09)</span>
                </div>
                
                <p className={styles.aboutText}>
                  StarkLLM is a <strong>completely free</strong> and <strong>open source</strong> project intended for <strong>research and non-commercial use</strong>. 
                  It is designed from the ground up with a local-first privacy architecture, ensuring your data stays securely on your machine.
                </p>

                <p className={styles.aboutText}>
                  Because the project is open source, you can independently inspect the code and verify that no data is ever sent to external third parties.
                </p>

                <div className={styles.aboutGrid}>
                  <div className={styles.aboutGridItem}>
                    <span className={styles.aboutLabel}>Created by</span>
                    <span className={styles.aboutValue}>Christian Stark</span>
                  </div>
                  <div className={styles.aboutGridItem}>
                    <span className={styles.aboutLabel}>Contact Email</span>
                    <span className={styles.aboutValue}>
                      <a href="mailto:info@starkllm.com">info@starkllm.com</a>
                    </span>
                  </div>
                  <div className={styles.aboutGridItem}>
                    <span className={styles.aboutLabel}>Official Website</span>
                    <span className={styles.aboutValue}>
                      <a href="https://starkllm.com" target="_blank" rel="noreferrer">https://starkllm.com</a>
                    </span>
                  </div>
                  <div className={styles.aboutGridItem}>
                    <span className={styles.aboutLabel}>Location</span>
                    <span className={styles.aboutValue}>Maxstr. 14<br/><span className={styles.aboutMuted}>52070 Aachen</span></span>
                  </div>
                </div>

                <div className={styles.aboutLegal}>
                  <strong>No Warranty / No Liability:</strong> This software is provided "as is", 
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
