import React from 'react';
import { t } from '../i18n';

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    console.error('ErrorBoundary caught:', error, info);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '1rem',
          padding: '2rem',
          background: 'var(--bg-primary)',
          color: 'var(--text-primary)',
        }}>
          <div style={{ fontSize: '3rem' }}>⚠️</div>
          <h2 style={{ margin: 0, fontWeight: 700 }}>{t('Something went wrong')}</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', textAlign: 'center', maxWidth: 440 }}>
            {t('An unexpected error occurred in this view. You can try to recover by clicking the button below.')}
          </p>
          {this.state.error && (
            <pre style={{
              fontSize: '0.75rem',
              color: 'var(--danger)',
              background: 'rgba(239,68,68,0.08)',
              padding: '0.75rem 1rem',
              borderRadius: 8,
              maxWidth: 540,
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
            }}>
              {this.state.error.toString()}
            </pre>
          )}
          <button
            onClick={this.handleReset}
            className="btn-primary"
            style={{ fontSize: '0.875rem' }}
          >
            {t('Try to Recover')}
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
