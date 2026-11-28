import React, { useEffect, useState } from 'react';
import { X, Users, Loader, UserPlus, LogOut, Trash2, Check, History, Lock } from 'lucide-react';
import styles from './KnowledgeBase.module.css';
import { t } from '../i18n';
import { UI_LOCALE } from '../utils/locale';
import { useEscape } from '../utils/useEscape';

// Shared household workspaces (docs/household-design.md): one account creates a workspace for the household and invites
// the other accounts of this PC by name; an invited account accepts once. Letters, inbox, deadlines and cases are
// shared; chats stay private. The owner removes members and deletes the workspace; a member can only leave.

const ACTION_TEXT = {
  created: (a) => t('{name} created the workspace', { name: a.actor }),
  invited: (a) => t('{name} invited {member}', { name: a.actor, member: a.target }),
  joined: (a) => t('{name} joined', { name: a.actor }),
  declined: (a) => t('{name} declined the invitation', { name: a.actor }),
  left: (a) => t('{name} left the workspace', { name: a.actor }),
  removed: (a) => t('{name} removed {member}', { name: a.actor, member: a.target }),
  invitation_withdrawn: (a) => t('{name} withdrew the invitation of {member}', { name: a.actor, member: a.target }),
  document_added: (a) => t('{name} added {file}', { name: a.actor, file: a.document }),
  document_deleted: (a) => t('{name} deleted {file}', { name: a.actor, file: a.document }),
  marked_done: (a) => t('{name} marked {file} as done', { name: a.actor, file: a.document }),
  marked_new: (a) => t('{name} marked {file} as new', { name: a.actor, file: a.document }),
  edited: (a) => t('{name} changed the title or case of {file}', { name: a.actor, file: a.document }),
  deadline_done: (a) => t('{name} marked the deadline of {file} as done', { name: a.actor, file: a.document }),
  deadline_open: (a) => t('{name} took back the done mark of {file}', { name: a.actor, file: a.document }),
  date_read: (a) => t('{name} chose how to read a date in {file}', { name: a.actor, file: a.document }),
  key_created: () => t('The workspace received its own key'),
  key_replaced: () => t('The workspace key was replaced'),
};

const ERRORS = {
  no_account: t('There is no account with this name on this PC.'),
  already: t('This account is already a member or invited.'),
  self: t('You are already in this workspace.'),
  owner_only: t('Only the owner of the workspace can do this.'),
  owner_cannot_leave: t('The owner cannot leave the workspace; delete it instead.'),
};

export default function HouseholdModal({ isOpen, onClose, token, onChanged }) {
  useEscape(onClose, isOpen);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [newName, setNewName] = useState('');
  const [inviteName, setInviteName] = useState({});
  const [activity, setActivity] = useState({});
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/v1/household', { headers });
      if (!res.ok) throw new Error();
      setData(await res.json());
    } catch (_) {
      setError(t('The shared workspaces could not be loaded.'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { if (isOpen) { setError(null); load(); } }, [isOpen]);

  const call = async (url, method = 'POST', body) => {
    setError(null);
    const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    if (!res.ok) {
      let code = null;
      try { code = (await res.json())?.detail?.code; } catch (_) { /* no body */ }
      setError(ERRORS[code] || (res.status === 423 ? t('StarkLLM is locked. Please unlock it first.') : t('That did not work. Please try again.')));
      return false;
    }
    await load();
    onChanged?.();
    return true;
  };

  const showActivity = async (wsId) => {
    if (activity[wsId]) { setActivity({ ...activity, [wsId]: null }); return; }
    const res = await fetch(`/api/v1/household/workspaces/${wsId}/activity`, { headers });
    if (res.ok) setActivity({ ...activity, [wsId]: (await res.json()).activity });
  };

  if (!isOpen) return null;
  const row = { display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 0' };
  const muted = { fontSize: '0.8rem', color: 'var(--text-muted)' };

  return (
    <div className={styles.modalOverlay}>
      <div className={styles.modalContent} style={{ maxWidth: '560px', maxHeight: '85vh', overflowY: 'auto' }}>
        <button className={styles.closeBtn} onClick={onClose} aria-label={t('Close')}><X size={20} /></button>
        <h3 className={styles.modalTitle} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Users size={20} className={styles.iconAccent} /> {t('Shared workspaces')}
        </h3>
        <p className={styles.modalDesc}>
          {t('A shared workspace holds the letters of your household. Other accounts on this PC see its letters, inbox, deadlines and cases once they accept your invitation. Your chats stay private, and so do your other workspaces.')}
        </p>
        {error && <div className={styles.error} role="alert">{error}</div>}
        {loading && !data && <div style={{ padding: '20px', textAlign: 'center' }}><Loader size={20} className={styles.spin} /></div>}

        {data?.invitations?.length > 0 && (
          <section style={{ marginBottom: '16px' }}>
            <h4>{t('Invitations')}</h4>
            {data.invitations.map((i) => (
              <div key={i.workspace_id} style={row}>
                <span style={{ flex: 1 }}>{t('{name} invites you to the shared workspace {workspace}.', { name: i.owner, workspace: i.name })}</span>
                <button className={styles.saveBtn} onClick={() => call(`/api/v1/household/invitations/${i.workspace_id}/accept`)}>
                  <Check size={14} /> {t('Accept')}
                </button>
                <button className={styles.cancelBtn} onClick={() => call(`/api/v1/household/invitations/${i.workspace_id}/decline`)}>
                  {t('Decline')}
                </button>
              </div>
            ))}
          </section>
        )}

        {(data?.workspaces || []).map((ws) => (
          <section key={ws.id} style={{ border: '1px solid var(--border-color)', borderRadius: '8px', padding: '12px', marginBottom: '12px' }}>
            <div style={row}>
              <strong style={{ flex: 1 }}>{ws.name}</strong>
              {ws.protected && <span style={muted} title={t('The letters of this workspace are encrypted with its own key.')}><Lock size={12} /></span>}
              <span style={muted}>{ws.role === 'owner' ? t('You are the owner') : t('Owner: {name}', { name: ws.owner })}</span>
            </div>
            <ul style={{ listStyle: 'none', padding: 0, margin: '4px 0' }}>
              {ws.members.map((m) => (
                <li key={m.user_id} style={row}>
                  <span style={{ flex: 1 }}>
                    {m.name} <span style={muted}>
                      · {m.role === 'owner' ? t('Owner') : m.status === 'invited' ? t('Invited') : t('Member')}
                    </span>
                  </span>
                  {ws.role === 'owner' && m.role !== 'owner' && (
                    <button className={styles.cancelBtn} title={m.status === 'invited' ? t('Withdraw the invitation') : t('Remove from the workspace')}
                      onClick={() => window.confirm(t('Remove {name} from {workspace}? {name} loses access at once.', { name: m.name, workspace: ws.name }))
                        && call(`/api/v1/household/workspaces/${ws.id}/members/${m.user_id}`, 'DELETE')}>
                      <Trash2 size={14} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {ws.role === 'owner' && (
              <form style={row} onSubmit={async (e) => {
                e.preventDefault();
                if (await call(`/api/v1/household/workspaces/${ws.id}/invite`, 'POST', { username: inviteName[ws.id] || '' })) {
                  setInviteName({ ...inviteName, [ws.id]: '' });
                }
              }}>
                <input className={styles.input} style={{ flex: 1 }} value={inviteName[ws.id] || ''} placeholder={t('Account name')}
                  aria-label={t('Account name')} onChange={(e) => setInviteName({ ...inviteName, [ws.id]: e.target.value })} />
                <button className={styles.saveBtn} type="submit" disabled={!(inviteName[ws.id] || '').trim()}>
                  <UserPlus size={14} /> {t('Invite')}
                </button>
              </form>
            )}
            <div style={{ ...row, justifyContent: 'flex-end' }}>
              <button className={styles.cancelBtn} onClick={() => showActivity(ws.id)}><History size={14} /> {t('Who did what')}</button>
              {ws.role === 'owner' ? (
                <button className={styles.cancelBtn}
                  onClick={() => window.confirm(t('Delete {workspace} with all its letters and every member\'s chats in it? This cannot be undone.', { workspace: ws.name }))
                    && call(`/api/v1/household/workspaces/${ws.id}`, 'DELETE')}>
                  <Trash2 size={14} /> {t('Delete workspace')}
                </button>
              ) : (
                <button className={styles.cancelBtn}
                  onClick={() => window.confirm(t('Leave {workspace}? You lose access to its letters, and your chats in it are deleted.', { workspace: ws.name }))
                    && call(`/api/v1/household/workspaces/${ws.id}/leave`)}>
                  <LogOut size={14} /> {t('Leave')}
                </button>
              )}
            </div>
            {activity[ws.id] && (
              <ul style={{ listStyle: 'none', padding: 0, margin: '8px 0 0', maxHeight: '200px', overflowY: 'auto' }}>
                {activity[ws.id].map((a) => (
                  <li key={a.id} style={{ ...row, alignItems: 'baseline' }}>
                    <span style={{ ...muted, minWidth: '7.5em' }}>{a.at ? new Date(`${a.at}Z`).toLocaleString(UI_LOCALE, { dateStyle: 'short', timeStyle: 'short' }) : ''}</span>
                    <span>{(ACTION_TEXT[a.action] || (() => a.action))({ ...a, actor: a.actor || t('A former member'), target: a.target || t('a former member'), document: a.document || t('a document') })}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}

        <form style={{ ...row, marginTop: '8px' }} onSubmit={async (e) => {
          e.preventDefault();
          if (await call('/api/v1/household/workspaces', 'POST', { name: newName.trim() })) setNewName('');
        }}>
          <input className={styles.input} style={{ flex: 1 }} value={newName} onChange={(e) => setNewName(e.target.value)}
            placeholder={t('For example: Our home')} aria-label={t('Name of the new shared workspace')} maxLength={120} />
          <button className={styles.saveBtn} type="submit" disabled={!newName.trim()}>
            <Users size={14} /> {t('Create shared workspace')}
          </button>
        </form>
      </div>
    </div>
  );
}
