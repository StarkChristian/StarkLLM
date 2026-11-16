import React, { useState, useEffect } from 'react';
import styles from './PromptTemplateModal.module.css';
import { X, Search, FileCode, Plus, Trash2, Edit2, Check, ArrowLeft } from 'lucide-react';
import { useToast } from './Toast';
import { t } from '../i18n';
import { useEscape } from '../utils/useEscape';

export default function PromptTemplateModal({ isOpen, onClose, token, onInsertTemplate }) {
  useEscape(onClose, isOpen);
  const toast = useToast();
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(false);
  
  // view: 'list', 'edit', or 'fill'
  const [view, setView] = useState('list');
  const [editingTemplate, setEditingTemplate] = useState(null); // null = creating new
  
  // Fill form state
  const [fillingTemplate, setFillingTemplate] = useState(null);
  const [variableValues, setVariableValues] = useState({});
  
  // Edit form state
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [tags, setTags] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  // Search state
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    if (isOpen) {
      fetchTemplates();
      setView('list');
      setSearchQuery('');
    }
  }, [isOpen]);

  const fetchTemplates = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/v1/prompts', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setTemplates(data);
      }
    } catch (e) {
      console.error("Failed to fetch templates", e);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateNew = () => {
    setEditingTemplate(null);
    setTitle('');
    setContent('');
    setTags('');
    setView('edit');
  };

  const handleEdit = (template) => {
    setEditingTemplate(template);
    setTitle(template.title);
    setContent(template.content);
    setTags(template.tags || '');
    setView('edit');
  };

  const handleSave = async () => {
    if (!title.trim() || !content.trim()) return;
    
    setIsSaving(true);
    try {
      const payload = { title, content, tags };
      const url = editingTemplate 
        ? `/api/v1/prompts/${editingTemplate.id}`
        : '/api/v1/prompts';
      const method = editingTemplate ? 'PUT' : 'POST';
      
      const res = await fetch(url, {
        method,
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
      
      if (res.ok) {
        await fetchTemplates();
        setView('list');
      }
    } catch (e) {
      console.error("Failed to save template", e);
      toast.error(t('Failed to save template.'));
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (e, id) => {
    e.stopPropagation();
    if (!window.confirm(t('Are you sure you want to delete this template?'))) return;
    
    try {
      const res = await fetch(`/api/v1/prompts/${id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        setTemplates(prev => prev.filter(tpl => tpl.id !== id));
      }
    } catch (e) {
      console.error("Failed to delete template", e);
    }
  };

  const getVariables = (content) => {
    const matches = [...content.matchAll(/\{\{([^}]+)\}\}/g)];
    return [...new Set(matches.map(m => m[1].trim()))];
  };

  const handleInsertClick = (template) => {
    const vars = getVariables(template.content);
    if (vars.length > 0) {
      setFillingTemplate(template);
      const initVals = {};
      vars.forEach(v => initVals[v] = '');
      setVariableValues(initVals);
      setView('fill');
    } else {
      onInsertTemplate(template.content);
      onClose();
    }
  };

  const handleConfirmInsert = () => {
    if (!fillingTemplate) return;
    let resolved = fillingTemplate.content;
    Object.keys(variableValues).forEach(key => {
      // Replace all instances of the variable
      const regex = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
      resolved = resolved.replace(regex, variableValues[key]);
    });
    onInsertTemplate(resolved);
    onClose();
  };

  if (!isOpen) return null;

  const filteredTemplates = templates.filter(tpl => 
    tpl.title.toLowerCase().includes(searchQuery.toLowerCase()) || 
    (tpl.tags && tpl.tags.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={e => e.stopPropagation()}>
        
        {/* Header */}
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            {view === 'edit' || view === 'fill' ? (
              <button className={styles.iconBtn} onClick={() => setView('list')}>
                <ArrowLeft size={20} />
              </button>
            ) : (
              <FileCode size={20} className={styles.headerIcon} />
            )}
            <h2>
              {view === 'edit' ? (editingTemplate ? t('Edit Template') : t('New Template')) : 
               view === 'fill' ? t('Fill Template Variables') : t('Prompt Templates')}
            </h2>
          </div>
          <button className={styles.iconBtn} onClick={onClose}><X size={20} /></button>
        </div>

        {/* Content */}
        {view === 'list' ? (
          <div className={styles.listContainer}>
            <div className={styles.listToolbar}>
              <div className={styles.searchBox}>
                <Search size={16} />
                <input 
                  type="text" 
                  placeholder={t('Search templates...')} 
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>
              <button className={styles.createBtn} onClick={handleCreateNew}>
                <Plus size={16} /> {t('Create')}
              </button>
            </div>

            <div className={styles.listBody}>
              {loading ? (
                <div className={styles.emptyState}>{t('Loading templates...')}</div>
              ) : templates.length === 0 ? (
                <div className={styles.emptyState}>
                  <FileCode size={48} className={styles.emptyIcon} />
                  <p>{t('No prompt templates yet.')}</p>
                  <button className={styles.createBtnOutline} onClick={handleCreateNew}>
                    {t('Create your first template')}
                  </button>
                </div>
              ) : filteredTemplates.length === 0 ? (
                <div className={styles.emptyState}>{t('No templates match your search.')}</div>
              ) : (
                <div className={styles.grid}>
                  {filteredTemplates.map(tpl => (
                    <div key={tpl.id} className={styles.card} onClick={() => handleInsertClick(tpl)}>
                      <div className={styles.cardHeader}>
                        <h4 title={tpl.title}>{tpl.title}</h4>
                        <div className={styles.cardActions}>
                          <button 
                            className={styles.cardBtn} 
                            onClick={(e) => { e.stopPropagation(); handleEdit(tpl); }}
                            title={t('Edit')}
                          >
                            <Edit2 size={14} />
                          </button>
                          <button 
                            className={styles.cardBtnDanger} 
                            onClick={(e) => handleDelete(e, tpl.id)}
                            title={t('Delete')}
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </div>
                      <p className={styles.cardPreview}>{tpl.content}</p>
                      {tpl.tags && (
                        <div className={styles.tags}>
                          {tpl.tags.split(',').map(tag => (
                            <span key={tag.trim()} className={styles.tag}>{tag.trim()}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : view === 'edit' ? (
          <div className={styles.editContainer}>
            <div className={styles.formGroup}>
              <label>{t('Title')}</label>
              <input 
                type="text" 
                value={title} 
                onChange={(e) => setTitle(e.target.value)} 
                placeholder={t('e.g. Code Review prompt')}
                autoFocus
              />
            </div>
            <div className={styles.formGroup}>
              <label>{t('Prompt Content')}</label>
              <textarea 
                value={content} 
                onChange={(e) => setContent(e.target.value)} 
                placeholder={t('Type your prompt here...')}
                rows={8}
              />
              <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                Tip: Use {"{{variable_name}}"} to create fillable variables.
              </span>
            </div>
            <div className={styles.formGroup}>
              <label>{t('Tags (optional)')}</label>
              <input 
                type="text" 
                value={tags} 
                onChange={(e) => setTags(e.target.value)} 
                placeholder={t('e.g. coding, review, ui')}
              />
            </div>
            <div className={styles.editFooter}>
              <button className={styles.cancelBtn} onClick={() => setView('list')} disabled={isSaving}>
                {t('Cancel')}
              </button>
              <button className={styles.saveBtn} onClick={handleSave} disabled={isSaving || !title.trim() || !content.trim()}>
                {isSaving ? t('Saving...') : <><Check size={16} /> {t('Save Template')}</>}
              </button>
            </div>
          </div>
        ) : view === 'fill' && fillingTemplate ? (
          <div className={styles.editContainer}>
            <div style={{ marginBottom: '16px', color: 'var(--text-secondary)' }}>
              <strong>{fillingTemplate.title}</strong> {t('contains variables. Fill them out below:')}
            </div>
            {Object.keys(variableValues).map(key => (
              <div key={key} className={styles.formGroup}>
                <label>{key}</label>
                <input 
                  type="text" 
                  value={variableValues[key]} 
                  onChange={(e) => setVariableValues(prev => ({ ...prev, [key]: e.target.value }))}
                  placeholder={`Enter ${key}...`}
                />
              </div>
            ))}
            <div className={styles.editFooter}>
              <button className={styles.cancelBtn} onClick={() => setView('list')}>
                {t('Cancel')}
              </button>
              <button className={styles.saveBtn} onClick={handleConfirmInsert}>
                <Check size={16} /> {t('Insert Prompt')}
              </button>
            </div>
          </div>
        ) : null}

      </div>
    </div>
  );
}
