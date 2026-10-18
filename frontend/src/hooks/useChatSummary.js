import { useState } from 'react';

export function useChatSummary({ getHeaders, handleLogout, chats, activeChatId }) {
  const [showSummaryModal, setShowSummaryModal] = useState(false);
  const [summaryText, setSummaryText] = useState('');
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState(null);
  const [summaryChatTitle, setSummaryChatTitle] = useState('');
  const [summaryCopied, setSummaryCopied] = useState(false);

  const handleSummarizeChat = async () => {
    if (!activeChatId) return;
    const activeChat = chats?.find(c => c.id === activeChatId);
    setSummaryChatTitle(activeChat?.title || 'Chat');
    setSummaryText('');
    setSummaryError(null);
    setSummaryCopied(false);
    setShowSummaryModal(true);
    setSummaryLoading(true);
    try {
      const model = localStorage.getItem('starkllm_model_name') || null;
      const res = await fetch(`/api/v1/chat/session/${activeChatId}/summarize`, {
        method: 'POST',
        headers: getHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ model }),
      });
      if (res.status === 401) { handleLogout(); return; }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || `Server error ${res.status}`);
      }
      const data = await res.json();
      setSummaryText(data.summary || '');
    } catch (err) {
      console.error('Summarize error:', err);
      setSummaryError(err.message);
    } finally {
      setSummaryLoading(false);
    }
  };

  const handleCopySummary = async () => {
    if (!summaryText) return;
    try {
      await navigator.clipboard.writeText(summaryText);
      setSummaryCopied(true);
      setTimeout(() => setSummaryCopied(false), 2000);
    } catch (_) {}
  };

  return {
    showSummaryModal,
    setShowSummaryModal,
    summaryText,
    summaryLoading,
    summaryError,
    summaryChatTitle,
    summaryCopied,
    handleSummarizeChat,
    handleCopySummary,
  };
}
