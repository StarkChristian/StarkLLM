import React, { useEffect, useState, useRef } from 'react';
import { MessageSquare, ArrowRight, MessageCircle, FileText, History, Upload, CalendarClock, Image } from 'lucide-react';
import DocumentViewerModal from './DocumentViewerModal';
import { UPLOAD_ACCEPT } from '../utils/uploadTypes';
import { UI_LOCALE } from '../utils/locale';
import styles from './Dashboard.module.css';
import DateTimeWidget from './DateTimeWidget';
import MarketPricesWidget from './MarketPricesWidget';
import SystemStatusWidget from './SystemStatusWidget';
import EmptyState from './EmptyState';
import { t } from '../i18n';

const IMAGE_TYPES = new Set(['png', 'jpg', 'jpeg', 'webp', 'tif', 'tiff']);
const KIND_STYLE = { deadline: 'kindDeadline', payment: 'kindPayment', appointment: 'kindAppointment' };

export default function Dashboard({ token, username, workspaces, onNewWorkspace, onViewChange, onSelectWorkspace, chats = [], onSelectChat, onUpload }) {
  const getHeaders = () => ({ Authorization: `Bearer ${token}` });

  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let animationFrameId;

    const resizeCanvas = () => {
      canvas.width = canvas.parentElement.clientWidth;
      canvas.height = canvas.parentElement.clientHeight;
    };
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    class Particle {
      constructor() {
        this.reset();
        this.y = Math.random() * canvas.height; // start anywhere vertically
      }
      reset() {
        this.x = Math.random() * canvas.width;
        this.y = Math.random() * canvas.height;
        this.vx = (Math.random() - 0.5) * 0.5;
        this.vy = (Math.random() - 0.5) * 0.5;
        this.radius = Math.random() * 2.5 + 1.5;
      }
      update() {
        this.x += this.vx;
        this.y += this.vy;

        if (this.x < 0 || this.x > canvas.width) this.vx = -this.vx;
        if (this.y < 0 || this.y > canvas.height) this.vy = -this.vy;
      }
      draw() {
        // Use CSS accent color if available
        const accentColor = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#4f46e5';
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
        ctx.fillStyle = accentColor;
        ctx.globalAlpha = 0.65;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }

    const particleCount = 45;
    const particles = Array.from({ length: particleCount }, () => new Particle());

    const drawLines = () => {
      const accentColor = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#4f46e5';
      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const dx = particles[i].x - particles[j].x;
          const dy = particles[i].y - particles[j].y;
          const dist = Math.hypot(dx, dy);

          if (dist < 120) {
            ctx.beginPath();
            ctx.moveTo(particles[i].x, particles[i].y);
            ctx.lineTo(particles[j].x, particles[j].y);
            // parse hex accent color
            const r = parseInt(accentColor.slice(1, 3), 16) || 79;
            const g = parseInt(accentColor.slice(3, 5), 16) || 70;
            const b = parseInt(accentColor.slice(5, 7), 16) || 229;
            ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${0.35 * (1 - dist / 120)})`;
            ctx.lineWidth = 1.1;
            ctx.stroke();
          }
        }
      }
    };

    const animate = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      particles.forEach(p => {
        p.update();
        p.draw();
      });
      drawLines();
      animationFrameId = requestAnimationFrame(animate);
    };
    animate();

    return () => {
      window.removeEventListener('resize', resizeCanvas);
      cancelAnimationFrame(animationFrameId);
    };
  }, []);



  const hour = new Date().getHours();
  const greeting = hour < 12 ? t('Good morning') : hour < 17 ? t('Good afternoon') : t('Good evening');

  const fileRef = useRef(null);
  const [home, setHome] = useState(null);
  const [viewing, setViewing] = useState(null);

  const loadHome = async () => {
    try {
      const res = await fetch('/api/v1/dashboard/home', { headers: getHeaders() });
      if (res.ok) setHome(await res.json());
    } catch (_) { /* the cards show their empty state */ }
  };
  useEffect(() => {
    if (!token) return undefined;
    loadHome();
    const timer = setInterval(loadHome, 15000);  // new uploads and folder files show up without a reload
    return () => clearInterval(timer);
  }, [token]);

  const fmtDate = (iso, opts) => new Date(iso + 'T12:00:00').toLocaleDateString(UI_LOCALE, opts);
  const daysFrom = (iso) => Math.round((new Date(iso + 'T12:00:00') - new Date(`${home.today}T12:00:00`)) / 86400000);
  const whenText = (iso) => {
    const d = daysFrom(iso);
    if (d < 0) return t('passed');
    if (d === 0) return t('today');
    if (d === 1) return t('tomorrow');
    return t('in {days} days', { days: d });
  };
  const openDoc = (item) => {
    if (item.scope === 'ws' && item.workspace_id) {
      setViewing({ workspaceId: item.workspace_id, documentId: item.document_id ?? item.id, page: item.page || 1, highlight: item.text });
    } else {
      onViewChange('knowledge-base');
    }
  };

  const dates = home?.dates || [];
  const recent = home?.recent || [];
  const recentChats = chats.slice(0, 5);

  return (
    <div className={styles.page}>
      <canvas ref={canvasRef} className={styles.neuralNetCanvas} />

      {/* ── Hero: what this is for, and the two things people come here to do ── */}
      <div className={styles.hero}>
        <div className={styles.heroContent}>
          <p className={styles.heroGreeting}>{greeting}{username && username !== 'local' ? `, ${username}` : ''}</p>
          <h1 className={styles.heroTitle}>{t('Your documents')}</h1>
          <p className={styles.heroSubtitle}>{t('Your private assistant for letters and documents, on this PC.')}</p>
          <div className={styles.heroActions}>
            <button className="btn-primary" onClick={() => fileRef.current && fileRef.current.click()} disabled={!onUpload}>
              <Upload size={16} /> {t('Add a letter or document')}
            </button>
            <button className="btn-secondary" onClick={() => onViewChange('chat')}>
              <MessageSquare size={16} /> {t('Ask a question')}
            </button>
            <input
              ref={fileRef}
              type="file"
              multiple
              accept={UPLOAD_ACCEPT}
              hidden
              onChange={async (e) => {
                const files = [...(e.target.files || [])];
                e.target.value = '';
                for (const f of files) {
                  try { await onUpload(f); } catch (_) { /* the chat shows the error */ }
                }
                onViewChange('chat');
              }}
            />
          </div>
        </div>
        <img src="/Logo.png" alt="" className={styles.heroLogo} />
      </div>

      <div className={styles.twoCol}>
        {/* ── Dates found in the documents ── */}
        <section className={styles.card} aria-labelledby="home-dates">
          <div className={styles.cardHeader} id="home-dates">
            <CalendarClock size={16} />
            {t('Upcoming dates')}
          </div>
          {!home ? (
            <p className={styles.homeNote}>{t('Looking through your documents…')}</p>
          ) : dates.length === 0 ? (
            <p className={styles.homeNote}>{t('No deadlines or payment dates found in your documents. When a letter names one, it shows up here.')}</p>
          ) : (
            <ul className={styles.homeList}>
              {dates.map((d, i) => (
                <li key={i}>
                  <button className={`${styles.dateRow} ${d.passed ? styles.datePassed : ''}`} onClick={() => openDoc(d)}>
                    <span className={styles.dateBox}>
                      <span className={styles.dateDay}>{fmtDate(d.date, { day: 'numeric' })}</span>
                      <span className={styles.dateMonth}>{fmtDate(d.date, { month: 'short', year: 'numeric' })}</span>
                    </span>
                    <span className={styles.dateBody}>
                      <span className={styles.dateMeta}>
                        <span className={KIND_STYLE[d.kind] ? styles[KIND_STYLE[d.kind]] : styles.kindPayment}>
                          {d.kind === 'deadline' ? t('Deadline') : d.kind === 'appointment' ? t('Appointment') : t('Payment')}
                        </span>
                        <span>{whenText(d.date)}{d.time ? ` · ${t('at {time}', { time: d.time })}` : ''}</span>
                        {d.amount && <strong>{d.amount}</strong>}
                      </span>
                      <span className={styles.dateText}>{d.text}</span>
                      <span className={styles.dateSource}>{d.filename} · {t('Page {page}', { page: d.page })}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {dates.length > 0 && <p className={styles.homeHint}>{t('Found word for word in your documents. Check the letter before you act on it.')}</p>}
        </section>

        {/* ── Newest documents ── */}
        <section className={styles.card} aria-labelledby="home-recent">
          <div className={styles.cardHeader} id="home-recent">
            <FileText size={16} />
            {t('Newest documents')}
          </div>
          {!home ? (
            <p className={styles.homeNote}>{t('Looking through your documents…')}</p>
          ) : recent.length === 0 ? (
            <EmptyState
              icon={FileText}
              title={t('No documents yet')}
              hint={t('Add a letter, a scan or a photo, or put files into your knowledge base folder.')}
            />
          ) : (
            <ul className={styles.homeList}>
              {recent.map((doc) => (
                <li key={`${doc.scope}-${doc.id}`}>
                  <button className={styles.docRow} onClick={() => openDoc({ ...doc, document_id: doc.id })}>
                    <span className={styles.docIcon}>{IMAGE_TYPES.has((doc.file_type || '').toLowerCase()) ? <Image size={16} /> : <FileText size={16} />}</span>
                    <span className={styles.docName}>{doc.filename}</span>
                    {doc.replaced && <span className={styles.docReplaced}>{t('Replaced by a newer letter')}</span>}
                    <span className={styles.docWhere}>
                      {doc.scope === 'kb' ? t('Knowledge base') : doc.workspace}
                      {doc.added ? ` · ${new Date(doc.added).toLocaleDateString(UI_LOCALE)}` : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* ── This PC ── */}
      <div className={styles.widgetsRow}>
        <DateTimeWidget />
        <SystemStatusWidget token={token} />
        <MarketPricesWidget token={token} />
      </div>

      {/* ── Recent chats ── */}
      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <History size={16} />
          {t('Recent Chats')}
          <button className={styles.cardAction} onClick={() => onViewChange('chat')}>
            {t('View All')}
          </button>
        </div>
        {recentChats.length === 0 ? (
          <p className={styles.homeNote}>{t('No chats yet.')}</p>
        ) : (
          <div className={styles.wsList}>
            {recentChats.map(chat => (
              <button
                key={chat.id}
                className={styles.wsRow}
                onClick={() => {
                  if (onSelectChat) onSelectChat(chat);
                  onViewChange('chat');
                }}
              >
                <div className={styles.wsRowIcon} style={{ background: 'var(--bg-active)', color: 'var(--accent-bright)' }}>
                  <MessageCircle size={14} />
                </div>
                <span className={styles.wsRowName}>{chat.title || t('Untitled chat')}</span>
                <ArrowRight size={13} className={styles.wsRowArrow} />
              </button>
            ))}
          </div>
        )}
      </section>

      {viewing && (
        <DocumentViewerModal
          isOpen
          onClose={() => setViewing(null)}
          workspaceId={viewing.workspaceId}
          documentId={viewing.documentId}
          initialPage={viewing.page}
          highlight={viewing.highlight}
          token={token}
        />
      )}
    </div>
  );
}
