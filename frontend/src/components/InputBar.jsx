import React, { useState, useRef, useEffect } from 'react';
import styles from './InputBar.module.css';
import { Paperclip, Mic, Send, Square, Loader, Database, Globe, FileCode, Settings, Cloud, Compass, TerminalSquare, X } from 'lucide-react';
import PromptTemplateModal from './PromptTemplateModal';
import { useToast } from './Toast';
import { UPLOAD_ACCEPT } from '../utils/uploadTypes';
import { UI_LOCALE } from '../utils/locale';
import { t } from '../i18n';
import { isWebTaskTemplate } from '../utils/webTask';

export default function InputBar({ onSendMessage, onFileUpload, useKb, onToggleKb, useWebSearch, onToggleWebSearch, webTaskAvailable, useWebTask, onToggleWebTask, terminalFolder, onChooseTerminalFolder, onClearTerminalFolder, offline, cloudHost, onOpenSettings, isGenerating, onStopGeneration, token, activeWorkspace, onOpenKbSettings }) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isTemplatesOpen, setIsTemplatesOpen] = useState(false);
  const fileInputRef = useRef(null);
  const textareaRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const recordingTimerRef = useRef(null);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  }, [text]);

  const estimatedTokens = Math.max(1, Math.round(text.length / 4));

  const formatDuration = (sec) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  const handleSend = () => {
    if (isGenerating) return;
    if (text.trim()) {
      onSendMessage(text);
      setText('');
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleFileClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e) => {
    const files = [...(e.target.files || [])];
    if (!files.length) return;

    setIsUploading(true);
    try {
      // one after the other: each upload shows its own progress line in the chat
      for (const file of files) {
        try {
          await onFileUpload(file);
        } catch (error) {
          console.error("File upload failed", error);
          toast.error(t('Failed to upload {file}: {error}', { file: file.name, error: error.message }));
        }
      }
    } finally {
      setIsUploading(false);
      e.target.value = null; // reset
    }
  };

  const toggleRecording = async () => {
    if (isRecording) {
      if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
      mediaRecorderRef.current?.stop();
      setIsRecording(false);
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        stream.getTracks().forEach(track => track.stop());

        const formData = new FormData();
        formData.append('file', audioBlob, 'recording.webm');

        setIsTranscribing(true);
        try {
          const response = await fetch('/api/v1/voice/transcribe', {
            method: 'POST',
            headers: token ? { Authorization: `Bearer ${token}` } : {},
            body: formData,
          });
          if (!response.ok) throw new Error("Transcription failed");

          const data = await response.json();
          if (data.text) {
            setText(prev => prev + (prev ? ' ' : '') + data.text);
          }
        } catch (error) {
          console.error(error);
          toast.error(t('Transcription failed: ') + error.message);
        } finally {
          setIsTranscribing(false);
        }
      };

      setRecordingDuration(0);
      recordingTimerRef.current = setInterval(() => {
        setRecordingDuration(prev => prev + 1);
      }, 1000);
      mediaRecorder.start();
      setIsRecording(true);
    } catch (error) {
      console.error("Microphone access denied", error);
      toast.error(t('Microphone access denied'));
    }
  };

  const handleInsertTemplate = (templateContent, template) => {
    setText(prev => prev ? prev + '\n' + templateContent : templateContent);
    // a saved web task: the message is a task for StarkLLM's browser window again
    if (isWebTaskTemplate(template) && webTaskAvailable && !useWebTask && !offline) onToggleWebTask();
  };

  return (
    <div className={styles.container}>
      {/* KB toggle row */}
      <div className={styles.toolbar}>
        <button
          id="kb-toggle-btn"
          className={`${styles.kbToggle} ${useKb ? styles.kbToggleOn : ''}`}
          onClick={onToggleKb}
          title={useKb ? t('Knowledge Base active — click to disable') : t('Enable Knowledge Base retrieval')}
          type="button"
        >
          <Database size={16} />
          {useKb ? t('Knowledge Base ON') : t('Knowledge Base')}
        </button>
        {useKb && (
          <button 
            className={styles.kbSettingsBtn} 
            onClick={onOpenKbSettings}
            title={t('Configure Workspace Knowledge Base filters')}
            type="button"
          >
            {activeWorkspace?.active_kb_dir_ids ? (() => {
                try {
                  const ids = JSON.parse(activeWorkspace.active_kb_dir_ids);
                  if (Array.isArray(ids)) {
                    if (ids.length === 0) return t('Knowledge base search off (no folder chosen)');
                    return ids.length === 1 ? t('Searching 1 knowledge base folder') : t('Searching {count} knowledge base folders', { count: ids.length });
                  }
                  return t('Searching all knowledge base folders');
                } catch {
                  return t('Searching all knowledge base folders');
                }
              })()
            : t('Searching all knowledge base folders')}
            <Settings size={14} style={{ marginLeft: '6px' }} />
          </button>
        )}
        <button
          className={`${styles.kbToggle} ${useWebSearch ? styles.kbToggleOn : ''}`}
          onClick={onToggleWebSearch}
          disabled={offline}
          title={offline ? t('Web Search is off while StarkLLM is fully offline') : useWebSearch ? t('Web Search active — click to disable') : t('Enable Web Search')}
          type="button"
        >
          <Globe size={16} />
          {useWebSearch ? t('Web Search ON') : t('Web Search')}
        </button>
        {useWebSearch && (
          <span className={styles.onlineNote} role="status">{t('Your question is sent to DuckDuckGo.')}</span>
        )}
        {webTaskAvailable && (
          <button
            className={`${styles.kbToggle} ${useWebTask ? styles.kbToggleOn : ''}`}
            onClick={onToggleWebTask}
            disabled={offline}
            title={offline ? t('Web tasks are off while StarkLLM is fully offline') : t('StarkLLM does the task on websites in its own browser window')}
            type="button"
          >
            <Compass size={16} />
            {useWebTask ? t('Web task ON') : t('Web task')}
          </button>
        )}
        {useWebTask && (
          <span className={styles.onlineNote} role="status">{t('StarkLLM opens its own browser window and works on websites. It asks you before buying, booking or sending anything.')}</span>
        )}
        {webTaskAvailable && onChooseTerminalFolder && !terminalFolder && (
          <button
            className={styles.kbToggle}
            onClick={async () => {
              const r = await onChooseTerminalFolder();
              if (r === 'unsuitable') toast.error(t('Choose a project folder, not a whole drive, your user folder or a system folder.'));
            }}
            title={t('Choose a project folder: StarkLLM can then read and change its files and run commands there, each after your yes.')}
            type="button"
          >
            <TerminalSquare size={16} />
            {t('Terminal')}
          </button>
        )}
        {terminalFolder && (
          <span className={`${styles.kbToggle} ${styles.kbToggleOn}`} role="status" title={terminalFolder.folder}>
            <TerminalSquare size={16} />
            {t('Terminal: {folder}', { folder: terminalFolder.name })}
            <button type="button" onClick={onClearTerminalFolder} title={t('Stop using this folder')} aria-label={t('Stop using this folder')}
              style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', display: 'inline-flex', padding: 0, marginLeft: 4 }}>
              <X size={14} />
            </button>
          </span>
        )}
        {terminalFolder && (
          <span className={styles.onlineNote} role="status">{t('StarkLLM works in the folder {folder}. It asks you before each change of a file and each command.', { folder: terminalFolder.name })}</span>
        )}
        {cloudHost && (
          <button
            type="button"
            className={styles.cloudBadge}
            onClick={onOpenSettings}
            title={t('A cloud model provider is selected in Settings. Click to change it.')}
            role="status"
          >
            <Cloud size={14} />
            {t('Cloud: {host} receives your question and document passages', { host: cloudHost })}
          </button>
        )}
      </div>

      <div className={styles.inputWrapper}>
        <div style={{ display: 'flex', gap: '4px' }}>
          <button className={styles.iconBtn} onClick={() => setIsTemplatesOpen(true)} title={t('Prompt Templates')}>
            <FileCode size={24} />
          </button>
          <button className={styles.iconBtn} onClick={handleFileClick} disabled={isUploading} title={t('Attach files (PDF, Word, Excel, CSV, Markdown, text, JSON, XML, HTML, images) or drop them on the window')}>
            {isUploading ? <Loader size={24} className="spinner" /> : <Paperclip size={24} />}
          </button>
        </div>
        <input
          type="file"
          ref={fileInputRef}
          style={{ display: 'none' }}
          onChange={handleFileChange}
          accept={UPLOAD_ACCEPT}
          multiple
        />

        {isRecording ? (
          <div className={styles.recordingIndicator}>
            <span className={styles.recordingPulseDot} />
            <span className={styles.recordingText}>Listening... {formatDuration(recordingDuration)}</span>
            <div className={styles.waveformBars}>
              <span className={styles.bar1} />
              <span className={styles.bar2} />
              <span className={styles.bar3} />
              <span className={styles.bar4} />
              <span className={styles.bar5} />
            </div>
          </div>
        ) : isTranscribing ? (
          <div className={styles.transcribingIndicator}>
            <Loader size={16} className={styles.spinnerIcon} />
            <span>{t('Transcribing audio with Whisper...')}</span>
          </div>
        ) : (
          <textarea
            ref={textareaRef}
            className={styles.textarea}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('Message StarkLLM or drop a file here...')}
            rows={1}
          />
        )}

        <div className={styles.actions}>
          <button
            className={`${styles.iconBtn} ${isRecording ? styles.recordingBtn : ''}`}
            onClick={toggleRecording}
            title={t('Record voice message')}
          >
            {isRecording ? <Square size={24} color="red" /> : <Mic size={24} />}
          </button>
          {isGenerating ? (
            <button className={`${styles.iconBtn} ${styles.stopBtn}`} onClick={onStopGeneration} title={t('Stop generating')}>
              <Square size={18} />
            </button>
          ) : (
            <button className={`${styles.iconBtn} ${styles.sendBtn}`} onClick={handleSend} title={t('Send message')}>
              <Send size={22} />
            </button>
          )}
        </div>
      </div>

      {/* Character / token counter */}
      {text.length > 0 && (
        <div className={styles.charCounter}>
          <span className={text.length > 8000 ? styles.charCounterWarn : ''}>
            {text.length.toLocaleString(UI_LOCALE)} chars
          </span>
          <span className={styles.charCounterDot}>·</span>
          <span>~{estimatedTokens.toLocaleString(UI_LOCALE)} tokens</span>
          {text.length > 8000 && (
            <span className={styles.charCounterOverLimit}> {t('· Long message — consider splitting')}</span>
          )}
        </div>
      )}

      <PromptTemplateModal 
        isOpen={isTemplatesOpen} 
        onClose={() => setIsTemplatesOpen(false)} 
        token={token} 
        onInsertTemplate={handleInsertTemplate} 
      />
    </div>
  );
}
