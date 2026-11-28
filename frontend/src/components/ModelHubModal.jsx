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
import ModelFitBadge from './ModelFitBadge';
import { t } from '../i18n';
import { createDownloadTracker, sortForThisPc, sizeText } from '../utils/modelFit';
import { durationText, recommendationSentence, hardwareSummary } from '../utils/modelFitText';

export default function ModelHubModal({ isOpen, onClose, token, currentModel, onModelSelect }) {
  const toast = useToast();
  const [activeTab, setActiveTab] = useState('explore'); // 'installed' | 'explore'
  const [catalog, setCatalog] = useState([]);
  const [installedModels, setInstalledModels] = useState([]);
  const [loading, setLoading] = useState(false);
  const [activeCategory, setActiveCategory] = useState('All');
  const [customModelName, setCustomModelName] = useState('');
  // the model picker: this PC's hardware and the chat and image model recommended for it (engine: /models/hardware)
  const [hardware, setHardware] = useState(null);
  const [recommendation, setRecommendation] = useState(null);

  // Pull progress state
  const [pullingModel, setPullingModel] = useState(null);
  const [pullProgress, setPullProgress] = useState({
    status: '',
    completed: 0,
    total: 0,
    percent: 0,
    secondsLeft: null
  });

  const getHeaders = () => ({
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  });

  const loadData = async () => {
    setLoading(true);
    try {
      const [catRes, instRes, hwRes] = await Promise.all([
        fetch('/api/v1/chat/models/catalog', { headers: getHeaders() }),
        fetch('/api/v1/chat/models/detailed', { headers: getHeaders() }),
        fetch('/api/v1/chat/models/hardware', { headers: getHeaders() })
      ]);

      if (catRes.ok) {
        const catData = await catRes.json();
        setCatalog(sortForThisPc(catData.catalog || []));
      }

      if (hwRes.ok) {
        const hwData = await hwRes.json();
        setHardware(hwData.hardware || null);
        setRecommendation(hwData.recommendation || null);
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
    setPullProgress({ status: t('Starting the download...'), completed: 0, total: 0, percent: 0, secondsLeft: null });
    // the speed comes from this download's own first seconds: no extra request to test it
    const tracker = createDownloadTracker();

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

            // one figure for the whole model: Ollama reports each file of it (a few small ones and one large one)
            tracker.feed(data);
            const sum = tracker.state();

            setPullProgress({
              status: data.status || t('Downloading...'),
              completed: sum.completed,
              total: sum.total,
              percent: sum.percent,
              secondsLeft: sum.secondsLeft
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
      toast.error(t('Download failed: {error}', { error: err.message }));
    } finally {
      setPullingModel(null);
    }
  };

  const handleDeleteModel = async (modelName) => {
    if (!window.confirm(t('Delete {model}? This frees disk space.', { model: modelName }))) {
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
        toast.error(t('Delete failed: {error}', { error: err.detail || t('Unknown error') }));
      }
    } catch (err) {
      console.error('Delete failed:', err);
      toast.error(t('Network error while deleting model'));
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

  // the catalog of the engine (llm_service.RECOMMENDED) describes its models in English
  const modelDescription = (m) => ({
    'qwen3:4b': t('Alibaba’s compact Qwen 3 model: fast on the processor or a small graphics card, good with documents and many languages.'),
    'qwen3:8b': t('The medium Qwen 3 model: careful answers from documents, for a graphics card with 12 GB or more.'),
    'qwen3:14b': t('The large Qwen 3 model: the most careful answers of the list, for a graphics card with 16 to 24 GB.'),
    'gemma3:4b': t('Google’s small Gemma 3 model: answers questions about photos, scans and screenshots.'),
    'qwen2.5vl:7b': t('A Qwen image model that reads text in photos and scans well, for a graphics card with 12 GB or more.'),
    'gemma3:12b': t('The larger Gemma 3 model: more careful answers about photos and scans, for a graphics card with 16 GB or more.'),
    'llama3.2:3b': t('Meta’s compact model for fast chat, e-mails and light work with local documents.'),
    'deepseek-r1:8b': t('An open reasoning model, strong in mathematics, logic and analysis.'),
    'qwen2.5-coder:7b': t('A local model for programming, with Python, JavaScript, Go, Rust and more.'),
    'mistral:7b': t('A popular Mistral model that understands long texts and works well with the knowledge base.'),
    'phi3.5:mini': t('A small Microsoft model with good reasoning and writing, and fast answers.'),
    'nomic-embed-text:latest': t('The model that turns document passages into vectors for the search of the knowledge base.'),
  }[m.name] || m.description);
  const modelTagline = (m) => ({
    'qwen3:4b': t('Small and fast, good answers on every PC'),
    'qwen3:8b': t('Balanced quality and speed'),
    'qwen3:14b': t('Careful answers for a large graphics card'),
    'gemma3:4b': t('Reads images, small and fast'),
    'qwen2.5vl:7b': t('Reads images and documents precisely'),
    'gemma3:12b': t('Reads images, for a large graphics card'),
    'llama3.2:3b': t('Very fast and light, for every computer'),
    'deepseek-r1:8b': t('Careful reasoning, step by step'),
    'qwen2.5-coder:7b': t('Writing, fixing and explaining code'),
    'mistral:7b': t('Steady and precise, good with documents'),
    'phi3.5:mini': t('Small and efficient, from Microsoft'),
    'nomic-embed-text:latest': t('Precise search of your documents'),
  }[m.name] || m.tagline);
  const categories = ['All', 'General / Fast', 'Reasoning / Math', 'Coding', 'General / RAG', 'Vision', 'Compact', 'Embedding'];
  const categoryLabel = (c) => ({ All: t('All'), 'General / Fast': t('General / Fast'), 'Reasoning / Math': t('Reasoning / Math'), Coding: t('Coding'),
    'General / RAG': t('General / documents'), Vision: t('Images'), Compact: t('Compact'), Embedding: t('Embedding') }[c] || c);
  const recommendedText = recommendationSentence(recommendation, hardware);
  const pcText = hardwareSummary(hardware);

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
              <h2 className={styles.title}>{t('StarkLLM Model Hub')}</h2>
              <p className={styles.subtitle}>{t('Discover, download and manage offline local AI models')}</p>
            </div>
          </div>
          <button 
            className={styles.closeBtn} 
            onClick={onClose} 
            disabled={!!pullingModel}
            title={t('Close')}
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
            <span>{t('Recommended Models')}</span>
            <span className={styles.countBadge}>{catalog.length}</span>
          </button>
          <button 
            className={`${styles.tabBtn} ${activeTab === 'installed' ? styles.tabBtnActive : ''}`}
            onClick={() => setActiveTab('installed')}
          >
            <HardDrive size={16} />
            <span>{t('Installed Local Models')}</span>
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
                  {t('Downloading {model}...', { model: pullingModel })}
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
                    {/* the size from the start; the time left only once the first seconds of this download measured the speed */}
                    {pullProgress.secondsLeft == null
                      ? t('{done} of {total}', { done: sizeText(pullProgress.completed), total: sizeText(pullProgress.total) })
                      : t('{done} of {total}, about {time} left', { done: sizeText(pullProgress.completed), total: sizeText(pullProgress.total), time: durationText(pullProgress.secondsLeft) })}
                  </span>
                )}
              </div>
            </div>
          )}

          {(pcText || recommendedText) && (
            <div className={styles.pcBox}>
              {pcText && <div className={styles.pcHardware}>{t('This PC: {hardware}', { hardware: pcText })}</div>}
              {recommendedText && <p className={styles.pcRecommendation}>{recommendedText}</p>}
              {recommendation?.vision?.name && (
                <div className={styles.pcHardware}>{t('For questions about images: {model}', { model: recommendation.vision.name })}</div>
              )}
            </div>
          )}

          {activeTab === 'explore' && (
            <>
              {/* Custom Model Pull Bar */}
              <div className={styles.customPullBox}>
                <input 
                  type="text"
                  placeholder={t('Enter any Ollama model tag (e.g. llama3.1:8b, mistral-nemo, codellama)...')}
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
                  <span>{t('Pull Model')}</span>
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
                    {categoryLabel(cat)}
                  </button>
                ))}
              </div>

              {/* Catalog Grid */}
              <div className={styles.grid}>
                {filteredCatalog.map(model => (
                  <div key={model.name} className={`${styles.card} ${model.recommended ? styles.recommendedCard : ''}`}>
                    <div>
                      {model.recommended && (
                        <span className={styles.recommendedBadge}>
                          <Sparkles size={11} /> {model.recommended === 'vision' ? t('Recommended for images on this PC') : t('Recommended for this PC')}
                        </span>
                      )}
                      <div className={styles.cardTop}>
                        <h3 className={styles.cardName}>{model.title}</h3>
                        {model.is_installed && (
                          <span className={styles.installedBadge}>
                            <Check size={12} /> {t('Installed')}
                          </span>
                        )}
                      </div>
                      <div className={styles.tagline}>{modelTagline(model)}</div>
                      <p className={styles.description}>{modelDescription(model)}</p>
                      
                      <div className={styles.metaRow}>
                        <span className={styles.metaBadge}>
                          <HardDrive size={11} /> {model.is_installed ? model.size : t('Download: {size}', { size: model.size })}
                        </span>
                      </div>
                      <ModelFitBadge fit={model.fit} />
                      <div style={{ height: 12 }} />
                    </div>

                    <div className={styles.cardActions}>
                      <span className={styles.metaBadge} style={{ textTransform: 'uppercase' }}>
                        {categoryLabel(model.category)}
                      </span>
                      {model.is_installed ? (
                        <button 
                          className={styles.installBtn}
                          onClick={() => {
                            if (onModelSelect) onModelSelect(model.name);
                            toast.success(t('Now using {model}', { model: model.name }));
                            onClose();
                          }}
                        >
                          <CheckCircle2 size={14} /> {t('Select as Active')}
                        </button>
                      ) : (
                        <button 
                          className={styles.installBtn}
                          onClick={() => handlePullModel(model.name)}
                          disabled={!!pullingModel}
                        >
                          <Download size={14} /> {t('Install Model')}
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
                  <p>{t('No models detected in your local Ollama instance.')}</p>
                  <button 
                    className={styles.pullBtn} 
                    style={{ margin: '14px auto 0' }}
                    onClick={() => setActiveTab('explore')}
                  >
                    {t('Browse Recommended Models')}
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
                                {t('Active')}
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
                          <ModelFitBadge fit={m.fit} />
                          <div style={{ height: 12 }} />
                        </div>

                        <div className={styles.cardActions}>
                          <button 
                            className={styles.installBtn}
                            onClick={() => {
                              if (onModelSelect) onModelSelect(m.name);
                              toast.success(t('Now using {model}', { model: m.name }));
                              onClose();
                            }}
                          >
                            <Check size={14} /> {t('Use This Model')}
                          </button>
                          <button 
                            className={styles.deleteBtn}
                            onClick={() => handleDeleteModel(m.name)}
                            disabled={!!pullingModel}
                            title={t('Delete model from disk')}
                          >
                            <Trash2 size={14} /> {t('Delete')}
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
