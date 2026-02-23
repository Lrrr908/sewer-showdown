// In-memory token bucket rate limiter.
// Interface: consume(key, cost) -> { ok, retryAfterMs }
// Swappable to Redis by reimplementing this module with the same interface.

const config = require('../config');

const RULES = {
  'ip:guest:':  { max: config.GUEST_RATE_LIMIT_PER_MIN,    refillMs: 60000 },
  'ip:login:':  { max: config.LOGIN_RATE_LIMIT_PER_MIN,    refillMs: 60000 },
  'ip:reg:':    { max: config.REGISTER_RATE_LIMIT_PER_MIN, refillMs: 60000 },
  'acct:ugc:':  { max: config.UGC_SUBMIT_RATE_LIMIT_PER_MIN, refillMs: config.UGC_SUBMIT_RATE_WINDOW_MS },
};

class RateLimiter {
  constructor(rules) {
    this.rules = rules || {};
    this.buckets = new Map();
    this._cleanupInterval = setInterval(() => this._cleanup(), 120000);
  }

  _ruleFor(key) {
    for (const prefix in this.rules) {
      if (key.startsWith(prefix)) return this.rules[prefix];
    }
    return null;
  }

  /**
   * @param {string} key - e.g. 'ip:guest:127.0.0.1' or 'acct:ugc:<accountId>'
   * @param {number} cost - tokens to consume (default 1)
   * @returns {{ ok: boolean, retryAfterMs: number }}
   */
  consume(key, cost) {
    if (cost === undefined) cost = 1;
    const rule = this._ruleFor(key);
    if (!rule) return { ok: true, retryAfterMs: 0 };

    const now = Date.now();
    let bucket = this.buckets.get(key);

    if (!bucket) {
      bucket = { tokens: rule.max, lastRefill: now };
      this.buckets.set(key, bucket);
    }

    const elapsed = now - bucket.lastRefill;
    const refill = (elapsed / rule.refillMs) * rule.max;
    bucket.tokens = Math.min(rule.max, bucket.tokens + refill);
    bucket.lastRefill = now;

    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      return { ok: true, retryAfterMs: 0 };
    }

    const deficit = cost - bucket.tokens;
    const retryAfterMs = Math.ceil((deficit / rule.max) * rule.refillMs);
    return { ok: false, retryAfterMs };
  }

  _cleanup() {
    const cutoff = Date.now() - 300000;
    for (const [key, bucket] of this.buckets) {
      if (bucket.lastRefill < cutoff) this.buckets.delete(key);
    }
  }

  destroy() {
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
      this._cleanupInterval = null;
    }
    this.buckets.clear();
  }
}

const limiter = new RateLimiter(RULES);

module.exports = { limiter, RateLimiter };
