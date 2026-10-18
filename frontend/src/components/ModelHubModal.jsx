import React, { useState, useEffect } from 'react';
import styles from './ModelHubModal.module.css';
import { 
  Cpu, 
  Download, 
  Trash2, 
  Check, 
  X, 
  HardDrive, 
  Sparkles, 
  Layers, 
  AlertCircle,
  Loader2,
  CheckCircle2
} from 'lucide-react';
import { useToast } from './Toast';

export default function ModelHubModal({ isOpen, onClose, token, currentModel, onModelSelect }) {
  const toast = useToast();
  const [activeTab, setActiveTab] = useState('explore'); // 'installed' | 'explore'
  const [catalog, setCatalog] = useState([]);
  const [installedModels, setInstalledModels] = useState([]);
  const [loading, setLoading] = useState(false);
  const [activeCategory, setActiveCategory] = useState('All');
  const [customModelName, setCustomModelName] = useState('');

  // Pull progress state
  const [pullingModel, setPullingModel] = useState(null);
  const [pullProgress, setPullProgress] = useState({
    status: '',
    completed: 0,
    total: 0,
    percent: 0
  });

  const getHeaders = () => ({
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  });

  const loadData = async () => {
    setLoading(true);
    try {
      const [catRes, instRes] = await Promise.all([
        fetch('/api/v1/chat/models/catalog', { headers: getHeaders() }),
        fetch('/api/v1/chat/models/detailed', { headers: getHeaders() })
      ]);

      if (catRes.ok) {
        const catData = await catRes.json();
        setCatalog(catData.catalog || []);
      }

      if (instRes.ok) {
        const instData = await instRes.json();
        setInstalledModels(instData.models || []);
      }
    } catch (err) {
      console.error('Failed to load Model Hub data:', err);
    }
    setLoading(false);
  };

  useEffect(() => {
    if (isOpen) {
      loadData();
    }
  }, [isOpen]);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape' && !pullingModel) {
        onClose();
      }
    };
    if (isOpen) {
      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
    }
  }, [isOpen, pullingModel, onClose]);

  const handlePullModel = async (modelName) => {
    const target = modelName.trim();
    if (!target) return;

    setPullingModel(target);
    setPullProgress({ status: 'Starting pull...', completed: 0, total: 0, percent: 0 });

    try {
      const response = await fetch('/api/v1/chat/models/pull', {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ model_name: target })
      });

      if (!response.ok) {
        throw new Error(`Failed to initiate pull: ${response.statusText}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep last incomplete line

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const data = JSON.parse(line);
            if (data.error) {
              throw new Error(data.error);
            }

            const total = data.total || 0;
            const completed = data.completed || 0;
            const percent = total > 0 ? Math.round((completed / total) * 100) : 0;

            setPullProgress({
              status: data.status || 'Downloading...',
              completed,
              total,
              percent
            });
          } catch (e) {
            console.error('Error parsing pull line:', e);
          }
        }
      }

      toast.success(`Model ${target} installed successfully!`);
      if (onModelSelect) {
        onModelSelect(target);
      }
      setCustomModelName('');
      await loadData();
    } catch (err) {
      console.error('Pull failed:', err);
      toast.error(`Download failed: ${err.message}`);
    } finally {
      setPullingModel(null);
    }
  };

  const handleDeleteModel = async (modelName) => {
    if (!window.confirm(`Are you sure you want to delete ${modelName}? This will free disk space.`)) {
      return;
    }

    try {
      const res = await fetch(`/api/v1/chat/models/${encodeURIComponent(modelName)}`, {
        method: 'DELETE',
        headers: getHeaders()
      });

      if (res.ok) {
        toast.success(`Model ${modelName} deleted.`);
        await loadData();
      } else {
        const err = await res.json();
        toast.error(`Delete failed: ${err.detail || 'Unknown error'}`);
      }
    } catch (err) {
      console.error('Delete failed:', err);
      toast.error('Network error while deleting model');
    }
  };

  const formatBytes = (bytes) => {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  };

  if (!isOpen) return null;

  const categories = ['All', 'General / Fast', 'Reasoning / Math', 'Coding', 'General / RAG', 'Compact', 'Embedding'];

  const filteredCatalog = activeCategory === 'All' 
    ? catalog 
    : catalog.filter(m => m.category === activeCategory);

  return (
    <div className={styles.overlay} onClick={(e) => e.target === e.currentTarget && !pullingModel && onClose()}>
      <div className={styles.modal}>
        {/* Header */}
        <div className={styles.header}>
          <div className={styles.titleGroup}>
            <div className={styles.iconBadge}>
              <Cpu size={22} />
            </div>
            <div>
              <h2 className={styles.title}>StarkLLM Model Hub</h2>
              <p className={styles.subtitle}>Discover, download and manage offline local AI models</p>
            </div>
          </div>
          <button 
            className={styles.closeBtn} 
            onClick={onClose} 
            disabled={!!pullingModel}
            title="Close"
          >
            <X size={18} />
          </button>
        </div>

        {/* Tabs Bar */}
        <div className={styles.tabsBar}>
          <button 
            className={`${styles.tabBtn} ${activeTab === 'explore' ? styles.tabBtnActive : ''}`}
            onClick={() => setActiveTab('explore')}
          >
            <Sparkles size={16} />
            <span>Recommended Models</span>
            <span className={styles.countBadge}>{catalog.length}</span>
          </button>
          <button 
            className={`${styles.tabBtn} ${activeTab === 'installed' ? styles.tabBtnActive : ''}`}
            onClick={() => setActiveTab('installed')}
          >
            <HardDrive size={16} />
            <span>Installed Local Models</span>
            <span className={styles.countBadge}>{installedModels.length}</span>
          </button>
        </div>

        {/* Modal Body */}
        <div className={styles.body}>
          {/* Active Download Banner */}
          {pullingModel && (
            <div className={styles.progressBanner}>
              <div className={styles.progressHeader}>
                <span className={styles.progressTitle}>
                  <Loader2 size={16} className="animate-spin" />
                  Downloading {pullingModel}...
                </span>
                <span className={styles.progressPercent}>{pullProgress.percent}%</span>
              </div>
              <div className={styles.progressBarTrack}>
                <div 
                  className={styles.progressBarFill} 
                  style={{ width: `${Math.max(5, pullProgress.percent)}%` }} 
                />
              </div>
              <div className={styles.progressDetail}>
                <span>{pullProgress.status}</span>
                {pullProgress.total > 0 && (
                  <span>
                    {formatBytes(pullProgress.completed)} / {formatBytes(pullProgress.total)}
                  </span>
                )}
              </div>
            </div>
          )}

          {activeTab === 'explore' && (
            <>
              {/* Custom Model Pull Bar */}
              <div className={styles.customPullBox}>
                <input 
                  type="text"
                  placeholder="Enter any Ollama model tag (e.g. llama3.1:8b, mistral-nemo, codellama)..."
                  className={styles.customInput}
                  value={customModelName}
                  onChange={(e) => setCustomModelName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handlePullModel(customModelName)}
                  disabled={!!pullingModel}
                />
                <button 
                  className={styles.pullBtn}
                  onClick={() => handlePullModel(customModelName)}
                  disabled={!customModelName.trim() || !!pullingModel}
                >
                  <Download size={15} />
                  <span>Pull Model</span>
                </button>
              </div>

              {/* Category Filter Pills */}
              <div className={styles.categoryBar}>
                {categories.map(cat => (
                  <button 
                    key={cat}
                    className={`${styles.catBtn} ${activeCategory === cat ? styles.catBtnActive : ''}`}
                    onClick={() => setActiveCategory(cat)}
                  >
                    {cat}
                  </button>
                ))}
              </div>

              {/* Catalog Grid */}
              <div className={styles.grid}>
                {filteredCatalog.map(model => (
                  <div key={model.name} className={styles.card}>
                    <div>
                      <div className={styles.cardTop}>
                        <h3 className={styles.cardName}>{model.title}</h3>
                        {model.is_installed && (
                          <span className={styles.installedBadge}>
                            <Check size={12} /> Installed
                          </span>
                        )}
                      </div>
                      <div className={styles.tagline}>{model.tagline}</div>
                      <p className={styles.description}>{model.description}</p>
                      
                      <div className={styles.metaRow}>
                        <span className={styles.metaBadge}>
                          <HardDrive size={11} /> {model.size}
                        </span>
                        <span className={`${styles.metaBadge} ${styles.ramBadge}`}>
                          Min {model.min_ram} RAM
                        </span>
                        <span className={styles.metaBadge}>
                          Rec {model.recommended_ram}
                        </span>
                      </div>
                    </div>

                    <div className={styles.cardActions}>
                      <span className={styles.metaBadge} style={{ textTransform: 'uppercase' }}>
                        {model.category}
                      </span>
                      {model.is_installed ? (
                        <button 
                          className={styles.installBtn}
                          onClick={() => {
                            if (onModelSelect) onModelSelect(model.name);
                            toast.success(`Switched active model to ${model.name}`);
                            onClose();
                          }}
                        >
                          <CheckCircle2 size={14} /> Select as Active
                        </button>
                      ) : (
                        <button 
                          className={styles.installBtn}
                          onClick={() => handlePullModel(model.name)}
                          disabled={!!pullingModel}
                        >
                          <Download size={14} /> Install Model
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {activeTab === 'installed' && (
            <div>
              {installedModels.length === 0 ? (
                <div className={styles.emptyState}>
                  <AlertCircle size={36} color="var(--text-muted)" />
                  <p>No models detected in your local Ollama instance.</p>
                  <button 
                    className={styles.pullBtn} 
                    style={{ margin: '14px auto 0' }}
                    onClick={() => setActiveTab('explore')}
                  >
                    Browse Recommended Models
                  </button>
                </div>
              ) : (
                <div className={styles.grid}>
                  {installedModels.map(m => {
                    const isCurrent = currentModel && (currentModel === m.name || currentModel.startsWith(m.name.split(':')[0]));
                    return (
                      <div key={m.name} className={styles.card}>
                        <div>
                          <div className={styles.cardTop}>
                            <h3 className={styles.cardName}>{m.name}</h3>
                            {isCurrent && (
                              <span className={styles.installedBadge}>
                                Active
                              </span>
                            )}
                          </div>
                          <div className={styles.metaRow} style={{ marginTop: 10 }}>
                            <span className={styles.metaBadge}>
                              <HardDrive size={12} /> {formatBytes(m.size)}
                            </span>
                            {m.details?.parameter_size && (
                              <span className={styles.metaBadge}>
                                {m.details.parameter_size}
                              </span>
                            )}
                            {m.details?.quantization_level && (
                              <span className={styles.metaBadge}>
                                {m.details.quantization_level}
                              </span>
                            )}
                            {m.details?.family && (
                              <span className={styles.metaBadge}>
                                {m.details.family}
                              </span>
                            )}
                          </div>
                        </div>

                        <div className={styles.cardActions}>
                          <button 
                            className={styles.installBtn}
                            onClick={() => {
                              if (onModelSelect) onModelSelect(m.name);
                              toast.success(`Active model set to ${m.name}`);
                              onClose();
                            }}
                          >
                            <Check size={14} /> Use This Model
                          </button>
                          <button 
                            className={styles.deleteBtn}
                            onClick={() => handleDeleteModel(m.name)}
                            disabled={!!pullingModel}
                            title="Delete model from disk"
                          >
                            <Trash2 size={14} /> Delete
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
