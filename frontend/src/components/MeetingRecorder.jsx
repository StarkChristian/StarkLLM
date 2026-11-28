import React, { useEffect, useRef, useState } from 'react';
import { X, Mic, Pause, Play, Square, Loader, AlertTriangle, Trash2, FileText, MonitorSpeaker } from 'lucide-react';
import { t } from '../i18n';
import { useEscape } from '../utils/useEscape';
import { PART_MS, PartQueue, formatClock, levelOf, meetingTitle, pickMime, systemAudioAvailable } from '../utils/meeting';
import styles from './Meeting.module.css';

// "Record a meeting" (2.8, option 13): the microphone, on Windows also the sound of this PC (an online call on this
// PC, without a bot joining it). Parts are sent every 15 s, so a crash loses at most that. After Stop the meeting is
// written down on this PC and becomes a document of the chosen workspace.

const desktop = () => (typeof window !== 'undefined' ? window.starkllmDesktop : null);

export default function MeetingRecorder({ token, workspaceId, onClose, onRecorded }) {
  const headers = { Authorization: `Bearer ${token}` };
  const [workspaces, setWorkspaces] = useState([]);
  const [target, setTarget] = useState(workspaceId);
  const [consent, setConsent] = useState(false);
  const [withSystem, setWithSystem] = useState(false);
  const [phase, setPhase] = useState('setup'); // setup, recording, paused, saving, done
  const [seconds, setSeconds] = useState(0);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState('');
  const [systemMissing, setSystemMissing] = useState(false);
  const [unfinished, setUnfinished] = useState([]);
  const rec = useRef({});
  const systemPossible = systemAudioAvailable(desktop());

  useEscape(() => { if (phase === 'setup' || phase === 'done') onClose(); }, true);

  const loadUnfinished = async () => {
    try {
      const res = await fetch('/api/v1/meetings/sessions/unfinished', { headers });
      if (res.ok) setUnfinished(((await res.json()).sessions || []).filter((s) => !s.active));
    } catch (_) { /* the list stays empty */ }
  };

  useEffect(() => {
    fetch('/api/v1/workspaces/', { headers }).then((r) => (r.ok ? r.json() : [])).then((list) => setWorkspaces(Array.isArray(list) ? list : [])).catch(() => {});
    loadUnfinished();
    return () => cleanup();
  }, []);

  // closing the window while recording: the browser asks first (the parts already sent are safe)
  useEffect(() => {
    if (phase !== 'recording' && phase !== 'paused') return undefined;
    const warn = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [phase]);

  function cleanup() {
    const r = rec.current;
    clearInterval(r.clock);
    cancelAnimationFrame(r.meter);
    (r.streams || []).forEach((s) => s.getTracks().forEach((tr) => tr.stop()));
    try { r.context && r.context.close(); } catch (_) { /* closed */ }
    rec.current = {};
  }

  const sendPart = (sid) => async (index, blob) => {
    const res = await fetch(`/api/v1/meetings/sessions/${sid}/parts/${index}`, {
      method: 'PUT', headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body: blob,
    });
    if (!res.ok) throw new Error(String(res.status));
  };

  const start = async () => {
    setError('');
    setSystemMissing(false);
    if (!consent) return;
    let mic;
    try {
      mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (_) {
      setError(t('StarkLLM may not use the microphone. Please allow it in the Windows settings (Privacy > Microphone).'));
      return;
    }
    const streams = [mic];
    const context = new AudioContext();
    const mix = context.createMediaStreamDestination();
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    const micSource = context.createMediaStreamSource(mic);
    micSource.connect(mix);
    micSource.connect(analyser);
    let systemOn = false;
    if (withSystem && systemPossible) {
      try {
        await desktop().meeting.armSystemAudio();
        const screen = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        streams.push(screen); // the picture is never recorded: only its sound is connected
        const tracks = screen.getAudioTracks();
        if (tracks.length) {
          const sys = context.createMediaStreamSource(new MediaStream(tracks));
          sys.connect(mix);
          sys.connect(analyser);
          systemOn = true;
        }
      } catch (_) { /* the microphone alone */ }
      if (!systemOn) setSystemMissing(true);
    }
    const mimeType = pickMime((m) => MediaRecorder.isTypeSupported(m));
    let sid;
    try {
      const res = await fetch('/api/v1/meetings/sessions', {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: Number(target), consent: true, system_audio: systemOn, mime: mimeType || 'audio/webm' }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || String(res.status));
      sid = (await res.json()).id;
    } catch (e) {
      streams.forEach((s) => s.getTracks().forEach((tr) => tr.stop()));
      context.close();
      setError(t('The recording could not be started: {error}', { error: e.message }));
      return;
    }
    const recorder = new MediaRecorder(mix.stream, mimeType ? { mimeType } : undefined);
    const queue = new PartQueue(sendPart(sid));
    recorder.ondataavailable = (e) => queue.push(e.data);
    recorder.start(PART_MS);
    const samples = new Uint8Array(analyser.fftSize);
    const tick = () => {
      analyser.getByteTimeDomainData(samples);
      setLevel(levelOf(samples));
      rec.current.meter = requestAnimationFrame(tick);
    };
    rec.current = { sid, recorder, queue, streams, context, clock: setInterval(() => setSeconds((s) => s + 1), 1000) };
    rec.current.meter = requestAnimationFrame(tick);
    setSeconds(0);
    setPhase('recording');
  };

  const pause = () => {
    const r = rec.current;
    if (!r.recorder) return;
    r.recorder.pause();
    clearInterval(r.clock);
    setPhase('paused');
  };

  const resume = () => {
    const r = rec.current;
    if (!r.recorder) return;
    r.recorder.resume();
    r.clock = setInterval(() => setSeconds((s) => s + 1), 1000);
    setPhase('recording');
  };

  const finish = async (sid, queue) => {
    if (queue) await queue.flush();
    const res = await fetch(`/api/v1/meetings/sessions/${sid}/stop`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: meetingTitle(t('Meeting')) }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || String(res.status));
    return res.json();
  };

  const stop = async () => {
    const r = rec.current;
    if (!r.recorder) return;
    setPhase('saving');
    const stopped = new Promise((resolve) => { r.recorder.onstop = resolve; });
    r.recorder.stop();
    await stopped;
    const { sid, queue } = r;
    cleanup();
    setLevel(0);
    try {
      const meeting = await finish(sid, queue);
      setPhase('done');
      onRecorded?.(meeting);
    } catch (e) {
      // the parts that reached the engine are kept: the recording is offered again the next time
      setError(t('The recording could not be saved completely: {error}. The parts that were saved can be written down later.', { error: e.message }));
      setPhase('setup');
      loadUnfinished();
    }
  };

  const recover = async (s) => {
    setError('');
    try {
      const meeting = await finish(s.id, null);
      setUnfinished((list) => list.filter((x) => x.id !== s.id));
      onRecorded?.(meeting);
    } catch (e) {
      setError(t('The recording could not be saved completely: {error}. The parts that were saved can be written down later.', { error: e.message }));
    }
  };

  const discard = async (s) => {
    if (!window.confirm(t('Delete this recording? This cannot be undone.'))) return;
    await fetch(`/api/v1/meetings/sessions/${s.id}`, { method: 'DELETE', headers }).catch(() => {});
    setUnfinished((list) => list.filter((x) => x.id !== s.id));
  };

  const live = phase === 'recording' || phase === 'paused';

  return (
    <div className={styles.backdrop} onClick={(e) => { if (e.target === e.currentTarget && !live && phase !== 'saving') onClose(); }}>
      <div className={styles.modal} role="dialog" aria-modal="true" aria-label={t('Record a meeting')}>
        <div className={styles.header}>
          <h3 className={styles.title}><Mic size={16} /> {t('Record a meeting')}</h3>
          {!live && phase !== 'saving' && (
            <button className={styles.closeBtn} onClick={onClose} title={t('Close')} aria-label={t('Close')}><X size={16} /></button>
          )}
        </div>

        <div className={styles.body}>
          {error && <p className={styles.error} role="alert"><AlertTriangle size={14} /> {error}</p>}

          {phase === 'setup' && (
            <>
              {unfinished.length > 0 && (
                <div className={styles.recover}>
                  <strong>{t('A recording was interrupted')}</strong>
                  {unfinished.map((s) => (
                    <div key={s.id} className={styles.recoverRow}>
                      <span>{new Date(s.started).toLocaleString()} · {t('about {time} saved', { time: formatClock(s.seconds) })}</span>
                      <button className="btn-secondary" onClick={() => recover(s)}><FileText size={14} /> {t('Write it down')}</button>
                      <button className="btn-secondary" onClick={() => discard(s)}><Trash2 size={14} /> {t('Delete')}</button>
                    </div>
                  ))}
                </div>
              )}

              <label className={styles.field}>
                <span>{t('Workspace for the document')}</span>
                <select value={target} onChange={(e) => setTarget(e.target.value)}>
                  {workspaces.length === 0 && <option value={workspaceId}>{t('This workspace')}</option>}
                  {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                </select>
              </label>

              {systemPossible && (
                <label className={styles.check}>
                  <input type="checkbox" checked={withSystem} onChange={(e) => setWithSystem(e.target.checked)} />
                  <span>
                    <MonitorSpeaker size={14} /> {t('Also record the sound of this PC (an online call on this PC)')}
                    <small>{t('No participant is added to the call. Windows may ask which screen to share: only the sound is recorded.')}</small>
                  </span>
                </label>
              )}

              <div className={styles.legal}>
                <p>{t('Recording a conversation without the consent of everyone taking part is prohibited in many countries and can be a criminal offence. Please tell everyone at the start that you are recording and ask for their consent.')}</p>
                <label className={styles.check}>
                  <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
                  <span>{t('I confirm that everyone in this meeting has agreed to be recorded.')}</span>
                </label>
              </div>

              <p className={styles.hint}>{t('Everything stays on this PC: the recording, the text and the summary. With protection on, the recording is stored encrypted.')}</p>
              <button className={styles.recordBtn} disabled={!consent} onClick={start}>
                <Mic size={16} /> {t('Start recording')}
              </button>
            </>
          )}

          {live && (
            <div className={styles.live}>
              <div className={styles.liveTop}>
                <span className={phase === 'recording' ? styles.dot : styles.dotPaused} aria-hidden="true" />
                <strong>{phase === 'recording' ? t('Recording') : t('Paused')}</strong>
                <span className={styles.clock} aria-live="off">{formatClock(seconds)}</span>
              </div>
              <div className={styles.meter} role="meter" aria-label={t('Input level')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)}>
                <div className={styles.meterFill} style={{ width: `${Math.round((phase === 'paused' ? 0 : level) * 100)}%` }} />
              </div>
              {systemMissing && <p className={styles.hint}>{t('The sound of this PC could not be added: only the microphone is recorded.')}</p>}
              <p className={styles.hint}>{t('Saved every 15 seconds. If StarkLLM or the PC stops, the recording up to then is kept.')}</p>
              <div className={styles.liveButtons}>
                {phase === 'recording'
                  ? <button className="btn-secondary" onClick={pause}><Pause size={15} /> {t('Pause')}</button>
                  : <button className="btn-secondary" onClick={resume}><Play size={15} /> {t('Continue')}</button>}
                <button className={styles.stopBtn} onClick={stop}><Square size={14} /> {t('Stop and write down')}</button>
              </div>
            </div>
          )}

          {phase === 'saving' && (
            <p className={styles.hint}><Loader size={14} className={styles.spin} /> {t('Saving the recording…')}</p>
          )}

          {phase === 'done' && (
            <div className={styles.done}>
              <p>{t('The meeting is being written down on this PC. It appears as a document in the workspace when it is ready; that can take a while for a long meeting.')}</p>
              <button className="btn-secondary" onClick={onClose}>{t('Close')}</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
