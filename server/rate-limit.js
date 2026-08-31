// Simple in-memory sliding-window rate limiter for login attempts. Structured as a small
// interface (recordFailure/recordSuccess/isBlocked) rather than middleware tied to Express, so a
// Redis- or database-backed implementation can drop in later behind the same three methods
// without touching any call site.
//
// Policy: MAX_FAILURES failed attempts within WINDOW_MS blocks further attempts for that key
// until BLOCK_MS has passed since the most recent failure in the window, or until a successful
// login clears it. Never a permanent lock -- always a rolling cooldown.
const WINDOW_MS = 15 * 60 * 1000;   // 15 minutes
const MAX_FAILURES = 8;
const BLOCK_MS = 15 * 60 * 1000;    // cooldown once blocked
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const MAX_TRACKED_KEYS = 50000;     // hard cap so a flood of distinct keys can't grow this unbounded between sweeps

function createRateLimiter(now = () => Date.now()) {
  // key -> { failures: number[] (timestamps within the window), blockedUntil: number|null }
  const buckets = new Map();

  function getBucket(key) {
    let b = buckets.get(key);
    if (!b) {
      b = { failures: [], blockedUntil: null };
      buckets.set(key, b);
    }
    return b;
  }

  function pruneOld(bucket, t) {
    while (bucket.failures.length && t - bucket.failures[0] > WINDOW_MS) bucket.failures.shift();
  }

  // Returns { blocked, retryAfterMs } without recording anything -- call before attempting the
  // login so a blocked caller never even reaches the password check.
  function isBlocked(key) {
    const b = buckets.get(key);
    if (!b) return { blocked: false, retryAfterMs: 0 };
    const t = now();
    if (b.blockedUntil && t < b.blockedUntil) return { blocked: true, retryAfterMs: b.blockedUntil - t };
    if (b.blockedUntil && t >= b.blockedUntil) { b.blockedUntil = null; b.failures = []; }
    return { blocked: false, retryAfterMs: 0 };
  }

  function recordFailure(key) {
    if (buckets.size > MAX_TRACKED_KEYS) sweep();
    const b = getBucket(key);
    const t = now();
    pruneOld(b, t);
    b.failures.push(t);
    if (b.failures.length >= MAX_FAILURES) {
      b.blockedUntil = t + BLOCK_MS;
      return true; // just crossed the threshold
    }
    return false;
  }

  function recordSuccess(key) {
    buckets.delete(key);
  }

  // Drops any bucket that's neither currently blocked nor has a failure within the window --
  // keeps the map bounded without needing an external scheduler to run reliably.
  function sweep() {
    const t = now();
    for (const [key, b] of buckets) {
      if (b.blockedUntil && t < b.blockedUntil) continue;
      pruneOld(b, t);
      if (!b.failures.length) buckets.delete(key);
    }
  }

  const timer = setInterval(sweep, SWEEP_INTERVAL_MS);
  if (timer.unref) timer.unref(); // never keep the process alive just for this

  return { isBlocked, recordFailure, recordSuccess, sweep, _buckets: buckets };
}

module.exports = { createRateLimiter, WINDOW_MS, MAX_FAILURES, BLOCK_MS };
