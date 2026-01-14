// product-management/shared/rateLimiter.js

/**
 * Per-domain rate limiter using token bucket algorithm
 * Tuned for batch processing of 30-40k products/day
 */

const buckets = new Map();

const DOMAIN_LIMITS = {
  // ═══════════════════════════════════════════════════════════════════════════
  // TIER 1: ENTERPRISE APIs - Built for high volume
  // ═══════════════════════════════════════════════════════════════════════════
  "algolia.net": { rate: 50, burst: 80 },
  "adobe.io": { rate: 40, burst: 60 },
  "instaleap.io": { rate: 40, burst: 60 },
  "searchserverapi1.com": { rate: 30, burst: 50 },
  "fastsimon.com": { rate: 30, burst: 50 },

  // ═══════════════════════════════════════════════════════════════════════════
  // TIER 2: MAJOR RETAILERS - Solid infrastructure
  // ═══════════════════════════════════════════════════════════════════════════
  "super99.com": { rate: 25, burst: 40 },
  "smrey.com": { rate: 25, burst: 40 },
  "elmachetazo.com": { rate: 20, burst: 35 },
  "superxtra.com": { rate: 20, burst: 35 },
  "arrocha.com": { rate: 20, burst: 35 },

  // ═══════════════════════════════════════════════════════════════════════════
  // TIER 3: MID-SIZE RETAIL - Good capacity
  // ═══════════════════════════════════════════════════════════════════════════
  "ribasmith.com": { rate: 15, burst: 25 },
  "novey.com.pa": { rate: 15, burst: 25 },
  "doitcenter.com.pa": { rate: 15, burst: 25 },
  "panafoto.com": { rate: 15, burst: 25 },
  "felipemotta.store": { rate: 15, burst: 25 },
  "conwayclick.com": { rate: 15, burst: 25 },
  "stevens.com.pa": { rate: 15, burst: 25 },
  "supercarnes.com": { rate: 15, burst: 25 },

  // ═══════════════════════════════════════════════════════════════════════════
  // TIER 4: SHOPIFY - Platform is resilient
  // ═══════════════════════════════════════════════════════════════════════════
  "superbaru.com": { rate: 12, burst: 20 },
  "felix.com.pa": { rate: 12, burst: 20 },
  "titan.com.pa": { rate: 12, burst: 20 },
  "americanpetspanama.com": { rate: 10, burst: 18 },
  "melopetandgarden.com": { rate: 10, burst: 18 },

  // ═══════════════════════════════════════════════════════════════════════════
  // TIER 5: SMALLER SITES - Still conservative
  // ═══════════════════════════════════════════════════════════════════════════
  "blackdogpanama.com": { rate: 8, burst: 15 },
};

const DEFAULT_RATE = 10;
const DEFAULT_BURST = 18;

// Higher queue depth for aggressive batching
const MAX_QUEUE_DEPTH = 10000;

// FIX: Idle bucket cleanup settings
const BUCKET_IDLE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const BUCKET_CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

function extractDomain(url) {
  try {
    const hostname = new URL(url).hostname;
    return hostname.replace(/^www\./, "");
  } catch {
    return "unknown";
  }
}

function getLimits(domain) {
  for (const [key, limits] of Object.entries(DOMAIN_LIMITS)) {
    if (domain.endsWith(key)) {
      return limits;
    }
  }
  return { rate: DEFAULT_RATE, burst: DEFAULT_BURST };
}

function getBucket(domain) {
  if (!buckets.has(domain)) {
    const { burst } = getLimits(domain);
    buckets.set(domain, {
      tokens: burst,
      lastRefill: Date.now(),
      waiting: [],
    });
  }
  return buckets.get(domain);
}

function refillTokens(bucket, limits) {
  const now = Date.now();
  const elapsed = now - bucket.lastRefill;
  const tokensToAdd = (elapsed / 1000) * limits.rate;

  bucket.tokens = Math.min(limits.burst, bucket.tokens + tokensToAdd);
  bucket.lastRefill = now;
}

function releaseWaiters(domain) {
  const bucket = getBucket(domain);
  const limits = getLimits(domain);

  while (bucket.waiting.length > 0 && bucket.tokens >= 1) {
    bucket.tokens -= 1;
    const { resolve } = bucket.waiting.shift();
    resolve();
  }

  if (bucket.waiting.length > 0) {
    const waitTime = Math.ceil((1 / limits.rate) * 1000);
    setTimeout(() => {
      refillTokens(bucket, limits);
      releaseWaiters(domain);
    }, waitTime);
  }
}

/**
 * Wait for rate limit token before making request
 * @throws {Error} if queue depth exceeds MAX_QUEUE_DEPTH
 */
export async function acquireToken(url) {
  const domain = extractDomain(url);
  const bucket = getBucket(domain);
  const limits = getLimits(domain);

  refillTokens(bucket, limits);

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return;
  }

  // Fail fast if queue is too deep - prevents memory bloat
  if (bucket.waiting.length >= MAX_QUEUE_DEPTH) {
    const estWait = Math.ceil((bucket.waiting.length / limits.rate) * 1000);
    throw new Error(
      `Rate limit queue full for ${domain} (depth: ${bucket.waiting.length}, est. wait: ${estWait}ms)`
    );
  }

  return new Promise((resolve) => {
    bucket.waiting.push({ resolve, queuedAt: Date.now() });

    if (bucket.waiting.length === 1) {
      const waitTime = Math.ceil(((1 - bucket.tokens) / limits.rate) * 1000);
      setTimeout(() => {
        refillTokens(bucket, limits);
        releaseWaiters(domain);
      }, waitTime);
    }
  });
}

/**
 * Report a 429 error - penalize this domain
 */
export function report429(url) {
  const domain = extractDomain(url);
  const bucket = getBucket(domain);

  // Penalize: negative tokens mean waiting longer
  bucket.tokens = Math.min(bucket.tokens, -5);

  console.warn(
    `[RateLimiter] 429 from ${domain}, queue: ${
      bucket.waiting.length
    }, tokens: ${bucket.tokens.toFixed(1)}`
  );
}

/**
 * Get stats for monitoring
 */
export function getStats() {
  const stats = {};
  for (const [domain, bucket] of buckets) {
    if (bucket.waiting.length > 0 || bucket.tokens < 0) {
      stats[domain] = {
        tokens: bucket.tokens.toFixed(1),
        waiting: bucket.waiting.length,
      };
    }
  }
  return stats;
}

/**
 * Get detailed stats for all domains (for debugging)
 */
export function getAllStats() {
  const stats = {};
  for (const [domain, bucket] of buckets) {
    stats[domain] = {
      tokens: bucket.tokens.toFixed(1),
      waiting: bucket.waiting.length,
      limits: getLimits(domain),
    };
  }
  return stats;
}

// Periodic stats logging - only when there's activity
setInterval(() => {
  const stats = getStats();
  if (Object.keys(stats).length > 0) {
    console.log("[RateLimiter] Active queues:", JSON.stringify(stats));
  }
}, 30000);

// FIX: Cleanup idle buckets to prevent memory leak
setInterval(() => {
  const now = Date.now();
  let cleanedCount = 0;

  for (const [domain, bucket] of buckets) {
    // Remove buckets that have been idle and have no waiters
    const isIdle = now - bucket.lastRefill > BUCKET_IDLE_TTL_MS;
    const hasNoWaiters = bucket.waiting.length === 0;

    if (isIdle && hasNoWaiters) {
      buckets.delete(domain);
      cleanedCount++;
    }
  }

  if (cleanedCount > 0) {
    console.log(
      `[RateLimiter] Cleaned ${cleanedCount} idle buckets, ${buckets.size} remaining`
    );
  }
}, BUCKET_CLEANUP_INTERVAL_MS);
