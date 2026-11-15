// Small in-memory limiters. Nothing here is persisted: a restart forgets everything, which is the
// point (no state to steal, nothing to subpoena).

/** Token bucket: `rate` tokens per second, up to `burst`. */
export class TokenBucket {
  constructor(rate, burst, now = Date.now) {
    this.rate = rate;
    this.burst = burst;
    this.tokens = burst;
    this.now = now;
    this.last = now();
  }
  take(n = 1) {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.rate);
    this.last = t;
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }
}

/** Counts per key that reset at the start of every window (used for bytes per day). */
export class WindowCounter {
  constructor(windowMs, now = Date.now) {
    this.windowMs = windowMs;
    this.now = now;
    /** @type {Map<string, { start: number, n: number }>} */
    this.map = new Map();
  }
  /** Adds n to the key; returns the total in the current window. */
  add(key, n) {
    const t = this.now();
    let e = this.map.get(key);
    if (!e || t - e.start >= this.windowMs) {
      e = { start: t, n: 0 };
      this.map.set(key, e);
    }
    e.n += n;
    return e.n;
  }
  get(key) {
    const e = this.map.get(key);
    return e && this.now() - e.start < this.windowMs ? e.n : 0;
  }
  sweep() {
    const t = this.now();
    for (const [k, e] of this.map) if (t - e.start >= this.windowMs) this.map.delete(k);
  }
}

/** Number of open connections per key. */
export class ConnectionCounter {
  constructor() {
    /** @type {Map<string, number>} */
    this.map = new Map();
  }
  tryAcquire(key, max) {
    const n = this.map.get(key) ?? 0;
    if (n >= max) return false;
    this.map.set(key, n + 1);
    return true;
  }
  release(key) {
    const n = (this.map.get(key) ?? 1) - 1;
    if (n <= 0) this.map.delete(key);
    else this.map.set(key, n);
  }
}
