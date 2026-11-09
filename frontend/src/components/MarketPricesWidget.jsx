import React, { useState, useEffect, useRef } from 'react';
import { TrendingUp, TrendingDown, RefreshCw, Layers, Settings2, X, Check } from 'lucide-react';
import styles from './MarketPricesWidget.module.css';
import { UI_LOCALE } from '../utils/locale';

// ─── All Available Assets ───────────────────────────────────────────────────
const ALL_ASSETS = {
  btc: {
    id: 'btc',
    name: 'Bitcoin',
    symbol: 'BTC',
    category: 'Crypto',
    decimals: 0,
    fetchType: 'coingecko',
    coingeckoId: 'bitcoin',
  },
  eth: {
    id: 'eth',
    name: 'Ethereum',
    symbol: 'ETH',
    category: 'Crypto',
    decimals: 2,
    fetchType: 'coingecko',
    coingeckoId: 'ethereum',
  },
  gold: {
    id: 'gold',
    name: 'Gold Spot',
    symbol: 'XAU',
    category: 'Commodity',
    decimals: 2,
    fetchType: 'yahoo',
    yahooSymbol: 'GC=F',
  },
  silver: {
    id: 'silver',
    name: 'Silver Spot',
    symbol: 'XAG',
    category: 'Commodity',
    decimals: 2,
    fetchType: 'yahoo',
    yahooSymbol: 'SI=F',
  },
  brent: {
    id: 'brent',
    name: 'Brent Crude',
    symbol: 'OIL',
    category: 'Commodity',
    decimals: 2,
    fetchType: 'yahoo',
    yahooSymbol: 'BZ=F',
  },
  eur: {
    id: 'eur',
    name: 'EUR / USD',
    symbol: 'EUR',
    category: 'Forex',
    decimals: 4,
    fetchType: 'yahoo',
    yahooSymbol: 'EURUSD=X',
  },
  spx: {
    id: 'spx',
    name: 'S&P 500',
    symbol: 'SPX',
    category: 'Index',
    decimals: 2,
    fetchType: 'yahoo',
    yahooSymbol: '^GSPC',
  },
};

const DEFAULT_SELECTED = ['btc', 'gold', 'brent'];
const CONSENT_KEY = 'starkllm_market_prices_consent';
const LS_KEY = 'starkllm_market_assets';
// Last real prices with the time they were fetched, shown at start and when a fetch fails (never invented prices).
const LAST_KEY = 'starkllm_market_last';

function loadLast() {
  try {
    const saved = JSON.parse(localStorage.getItem(LAST_KEY) || '{}');
    return saved && typeof saved === 'object' ? saved : {};
  } catch (_) {
    return {};
  }
}

const fmtTime = (ms) => new Date(ms).toLocaleTimeString(UI_LOCALE, { hour: '2-digit', minute: '2-digit' });

function loadSelected() {
  try {
    const saved = localStorage.getItem(LS_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      // Validate that saved keys still exist in ALL_ASSETS
      const valid = parsed.filter((k) => ALL_ASSETS[k]);
      return valid.length > 0 ? valid : DEFAULT_SELECTED;
    }
  } catch (_) {}
  return DEFAULT_SELECTED;
}

export default function MarketPricesWidget({ token }) {
  const [selectedIds, setSelectedIds] = useState(loadSelected);
  const [prices, setPrices] = useState(loadLast);
  const [loading, setLoading] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(() => {
    const times = Object.values(loadLast()).map((v) => v && v.at).filter(Boolean);
    return times.length ? new Date(Math.max(...times)) : null;
  });
  const [failed, setFailed] = useState([]);
  const [showConfig, setShowConfig] = useState(false);
  const configRef = useRef(null);
  // StarkLLM is local-first: this widget talks to CoinGecko (directly) and Yahoo Finance (via the backend),
  // so it stays off until the user switches it on.
  const [consent, setConsent] = useState(() => {
    try { return localStorage.getItem(CONSENT_KEY) === 'yes'; } catch (_) { return false; }
  });
  const setLiveConsent = (on) => {
    try { localStorage.setItem(CONSENT_KEY, on ? 'yes' : 'no'); } catch (_) { /* private mode */ }
    setConsent(on);
    if (!on) { setFailed([]); setShowConfig(false); }
  };

  // Close config panel when clicking outside
  useEffect(() => {
    function handleClick(e) {
      if (configRef.current && !configRef.current.contains(e.target)) {
        setShowConfig(false);
      }
    }
    if (showConfig) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showConfig]);

  // Helper — Yahoo Finance proxy
  const fetchYahooQuote = async (symbol) => {
    const res = await fetch(`/api/v1/dashboard/market-prices?consent=1&symbol=${encodeURIComponent(symbol)}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) return null;
    const json = await res.json();
    const meta = json?.chart?.result?.[0]?.meta;
    if (!meta) return null;
    const price = meta.regularMarketPrice;
    const prevClose = meta.chartPreviousClose || meta.previousClose;
    const change = price && prevClose ? ((price - prevClose) / prevClose) * 100 : 0;
    return { price, change };
  };

  // Batch-fetch CoinGecko for all selected crypto
  const fetchCoingeckoBatch = async (ids) => {
    const joined = ids.join(',');
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${joined}&vs_currencies=usd&include_24hr_change=true`
    );
    if (!res.ok) return null;
    return res.json();
  };

  const fetchPrices = async () => {
    setLoading(true);
    const fresh = {};
    const assets = selectedIds.map((id) => ALL_ASSETS[id]);
    const cryptoAssets = assets.filter((a) => a.fetchType === 'coingecko');
    const yahooAssets = assets.filter((a) => a.fetchType === 'yahoo');

    // All crypto in one request
    if (cryptoAssets.length > 0) {
      try {
        const geckoData = await fetchCoingeckoBatch(cryptoAssets.map((a) => a.coingeckoId));
        cryptoAssets.forEach((a) => {
          const d = geckoData?.[a.coingeckoId];
          if (d && typeof d.usd === 'number') fresh[a.id] = { price: d.usd, change: d.usd_24h_change || 0 };
        });
      } catch (_) { /* shown as not available below */ }
    }

    // Yahoo one by one (rate limit of the free API)
    for (const a of yahooAssets) {
      try {
        const q = await fetchYahooQuote(a.yahooSymbol);
        if (q && q.price) fresh[a.id] = { price: q.price, change: q.change };
      } catch (_) { /* shown as not available below */ }
    }

    const now = Date.now();
    const loaded = Object.keys(fresh);
    setFailed(selectedIds.filter((id) => !fresh[id]));
    if (loaded.length > 0) {
      setPrices((prev) => {
        const next = { ...prev };
        loaded.forEach((id) => { next[id] = { ...fresh[id], at: now }; });
        try { localStorage.setItem(LAST_KEY, JSON.stringify(next)); } catch (_) { /* private mode */ }
        return next;
      });
      setLastUpdated(new Date(now));
    }
    setLoading(false);
  };

  useEffect(() => {
    if (!consent) return undefined;
    fetchPrices();
    const interval = setInterval(fetchPrices, 40000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds, consent]);

  const toggleAsset = (id) => {
    setSelectedIds((prev) => {
      if (prev.includes(id)) {
        if (prev.length <= 1) return prev; // keep at least one
        const next = prev.filter((x) => x !== id);
        localStorage.setItem(LS_KEY, JSON.stringify(next));
        return next;
      } else {
        if (prev.length >= 6) return prev; // cap at 6 for space
        const next = [...prev, id];
        localStorage.setItem(LS_KEY, JSON.stringify(next));
        return next;
      }
    });
  };

  const categories = [...new Set(Object.values(ALL_ASSETS).map((a) => a.category))];

  if (!consent) {
    return (
      <div className={styles.card}>
        <div className={styles.header}>
          <div className={styles.titleWrap}>
            <Layers className={styles.headerIcon} size={16} />
            <h3 className={styles.title}>Live Market Indicators</h3>
          </div>
        </div>
        <p style={{ margin: '0.8rem 0', fontSize: '0.85rem', opacity: 0.8, lineHeight: 1.5 }}>
          Off by default: StarkLLM keeps your data on this PC. Turning this on contacts CoinGecko and Yahoo Finance
          from now on to fetch prices (they can see that your IP address uses StarkLLM).
        </p>
        <button className={styles.chip} onClick={() => setLiveConsent(true)}>Turn on live prices</button>
      </div>
    );
  }

  return (
    <div className={styles.card}>
      {/* Header */}
      <div className={styles.header}>
        <div className={styles.titleWrap}>
          <Layers className={styles.headerIcon} size={16} />
          <h3 className={styles.title}>Live Market Indicators</h3>
        </div>
        <div className={styles.headerActions}>
          <button
            className={`${styles.iconBtn} ${showConfig ? styles.iconBtnActive : ''}`}
            onClick={() => setShowConfig((v) => !v)}
            title="Configure assets"
          >
            <Settings2 size={14} />
          </button>
          <button
            className={`${styles.iconBtn} ${loading ? styles.loading : ''}`}
            onClick={fetchPrices}
            disabled={loading}
            title="Refresh"
          >
            <RefreshCw size={14} />
          </button>
        </div>
      </div>

      {/* Config Panel */}
      {showConfig && (
        <div className={styles.configPanel} ref={configRef}>
          <div className={styles.configHeader}>
            <span className={styles.configTitle}>Select Assets</span>
            <span className={styles.configHint}>{selectedIds.length}/6 selected</span>
            <button className={styles.chip} onClick={() => setLiveConsent(false)} title="Stop contacting CoinGecko and Yahoo Finance">Turn off live prices</button>
          </div>
          {categories.map((cat) => (
            <div key={cat} className={styles.configGroup}>
              <span className={styles.configCatLabel}>{cat}</span>
              <div className={styles.chipRow}>
                {Object.values(ALL_ASSETS)
                  .filter((a) => a.category === cat)
                  .map((a) => {
                    const active = selectedIds.includes(a.id);
                    return (
                      <button
                        key={a.id}
                        onClick={() => toggleAsset(a.id)}
                        className={`${styles.chip} ${active ? styles.chipActive : ''}`}
                        title={a.name}
                      >
                        {active && <Check size={10} />}
                        {a.symbol}
                      </button>
                    );
                  })}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Price List */}
      <div className={styles.priceList}>
        {selectedIds.map((id) => {
          const asset = ALL_ASSETS[id];
          const p = prices[id];
          // older than two refreshes, or the last fetch failed: show its time instead of the change
          const stale = p && (failed.includes(id) || Date.now() - p.at > 2 * 60 * 1000);
          if (!p) {
            return (
              <div key={id} className={styles.priceItem}>
                <div className={styles.assetMeta}>
                  <span className={styles.assetName}>{asset.name}</span>
                  <span className={styles.assetSymbol}>{asset.symbol}</span>
                </div>
                <div className={styles.assetValuation}>
                  <span className={styles.price}>—</span>
                  <span className={styles.assetSymbol}>{loading ? 'loading…' : 'not available'}</span>
                </div>
              </div>
            );
          }
          const isUp = p.change >= 0;
          const fmtPrice = p.price.toLocaleString(UI_LOCALE, { minimumFractionDigits: asset.decimals, maximumFractionDigits: asset.decimals });
          return (
            <div key={id} className={styles.priceItem}>
              <div className={styles.assetMeta}>
                <span className={styles.assetName}>{asset.name}</span>
                <span className={styles.assetSymbol}>{asset.symbol}</span>
              </div>
              <div className={styles.assetValuation}>
                <span className={styles.price}>{asset.symbol === 'EUR' ? fmtPrice : `$${fmtPrice}`}</span>
                {stale ? (
                  <span className={styles.assetSymbol} title="The last fetch failed; this is the last price that was loaded">as of {fmtTime(p.at)}</span>
                ) : (
                  <span className={`${styles.change} ${isUp ? styles.up : styles.down}`}>
                    {isUp ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
                    {isUp ? '+' : ''}{p.change.toFixed(2)}%
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Footer */}
      <div className={styles.footer}>
        <span>{lastUpdated ? `Updated: ${lastUpdated.toLocaleTimeString(UI_LOCALE, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : loading ? 'Loading prices…' : 'Not updated yet'}</span>
        {failed.length > 0 && !loading && (
          <span className={styles.simLabel} title="CoinGecko or Yahoo Finance did not answer; it is tried again every 40 seconds">
            {failed.length === selectedIds.length ? 'Prices not available' : 'Some prices not available'}
          </span>
        )}
      </div>
    </div>
  );
}
