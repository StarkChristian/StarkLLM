import React, { useState, useRef, useEffect } from 'react';
import styles from './InputBar.module.css';
import { Paperclip, Mic, Send, Square, Loader, Database, Globe, FileCode, Settings } from 'lucide-react';
import PromptTemplateModal from './PromptTemplateModal';
import { useToast } from './Toast';

export default function InputBar({ onSendMessage, onFileUpload, useKb, onToggleKb, useWebSearch, onToggleWebSearch, isGenerating, onStopGeneration, token, activeWorkspace, onOpenKbSettings }) {
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
    const file = e.target.files?.[0];
    if (!file) return;

    setIsUploading(true);
    try {
      await onFileUpload(file);
    } catch (error) {
      console.error("File upload failed", error);
      toast.error("Failed to upload file: " + error.message);
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
          toast.error("Transcription failed: " + error.message);
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
      toast.error("Microphone access denied");
    }
  };

  const handleInsertTemplate = (templateContent) => {
    setText(prev => prev ? prev + '\n' + templateContent : templateContent);
  };

  return (
    <div className={styles.container}>
      {/* KB toggle row */}
      <div className={styles.toolbar}>
        <button
          id="kb-toggle-btn"
          className={`${styles.kbToggle} ${useKb ? styles.kbToggleOn : ''}`}
          onClick={onToggleKb}
          title={useKb ? "Knowledge Base active — click to disable" : "Enable Knowledge Base retrieval"}
          type="button"
        >
          <Database size={16} />
          {useKb ? 'Knowledge Base ON' : 'Knowledge Base'}
        </button>
        {useKb && (
          <button 
            className={styles.kbSettingsBtn} 
            onClick={onOpenKbSettings}
            title="Configure Workspace Knowledge Base filters"
            type="button"
          >
            {activeWorkspace?.active_kb_dir_ids ? (() => {
                try {
                  const ids = JSON.parse(activeWorkspace.active_kb_dir_ids);
                  if (Array.isArray(ids)) {
                    if (ids.length === 0) return 'KB Search Disabled (0 folders)';
                    return `Searching ${ids.length} KB Folder${ids.length === 1 ? '' : 's'}`;
                  }
                  return 'Searching all KB Folders';
                } catch {
                  return 'Searching all KB Folders';
                }
              })()
            : 'Searching all KB Folders'}
            <Settings size={14} style={{ marginLeft: '6px' }} />
          </button>
        )}
        <button
          className={`${styles.kbToggle} ${useWebSearch ? styles.kbToggleOn : ''}`}
          onClick={onToggleWebSearch}
          title={useWebSearch ? "Web Search active — click to disable" : "Enable Web Search"}
          type="button"
        >
          <Globe size={16} />
          {useWebSearch ? 'Web Search ON' : 'Web Search'}
        </button>
      </div>

      <div className={styles.inputWrapper}>
        <div style={{ display: 'flex', gap: '4px' }}>
          <button className={styles.iconBtn} onClick={() => setIsTemplatesOpen(true)} title="Prompt Templates">
            <FileCode size={24} />
          </button>
          <button className={styles.iconBtn} onClick={handleFileClick} disabled={isUploading} title="Attach file">
            {isUploading ? <Loader size={24} className="spinner" /> : <Paperclip size={24} />}
          </button>
        </div>
        <input
          type="file"
          ref={fileInputRef}
          style={{ display: 'none' }}
          onChange={handleFileChange}
          accept=".pdf,.txt,.png,.jpg,.jpeg"
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
            <span>Transcribing audio with Whisper...</span>
          </div>
        ) : (
          <textarea
            ref={textareaRef}
            className={styles.textarea}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Message StarkLLM or drop a file here..."
            rows={1}
          />
        )}

        <div className={styles.actions}>
          <button
            className={`${styles.iconBtn} ${isRecording ? styles.recordingBtn : ''}`}
            onClick={toggleRecording}
            title="Record voice message"
          >
            {isRecording ? <Square size={24} color="red" /> : <Mic size={24} />}
          </button>
          {isGenerating ? (
            <button className={`${styles.iconBtn} ${styles.stopBtn}`} onClick={onStopGeneration} title="Stop generating">
              <Square size={18} />
            </button>
          ) : (
            <button className={`${styles.iconBtn} ${styles.sendBtn}`} onClick={handleSend} title="Send message">
              <Send size={22} />
            </button>
          )}
        </div>
      </div>

      {/* Character / token counter */}
      {text.length > 0 && (
        <div className={styles.charCounter}>
          <span className={text.length > 8000 ? styles.charCounterWarn : ''}>
            {text.length.toLocaleString()} chars
          </span>
          <span className={styles.charCounterDot}>·</span>
          <span>~{estimatedTokens.toLocaleString()} tokens</span>
          {text.length > 8000 && (
            <span className={styles.charCounterOverLimit}> · Long message — consider splitting</span>
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
