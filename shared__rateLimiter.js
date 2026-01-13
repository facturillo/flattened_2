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
  "algolia.net": { rate: 50, burst: 80 }, // Was 30/50 - Algolia handles 1000s/sec
  "adobe.io": { rate: 40, burst: 60 }, // Was 20/35 - Adobe Commerce is robust
  "instaleap.io": { rate: 40, burst: 60 }, // Was 20/35 - Built for grocery scale
  "searchserverapi1.com": { rate: 30, burst: 50 }, // Was 15/25
  "fastsimon.com": { rate: 30, burst: 50 }, // Was 15/25

  // ═══════════════════════════════════════════════════════════════════════════
  // TIER 2: MAJOR RETAILERS - Solid infrastructure
  // ═══════════════════════════════════════════════════════════════════════════
  "super99.com": { rate: 25, burst: 40 }, // Was 15/25 - Adobe Commerce API
  "smrey.com": { rate: 25, burst: 40 }, // Was 15/25 - Instaleap backend
  "elmachetazo.com": { rate: 20, burst: 35 }, // Was 10/20 - VTEX handles traffic
  "superxtra.com": { rate: 20, burst: 35 }, // Was 10/20 - VTEX
  "arrocha.com": { rate: 20, burst: 35 }, // Was 10/20 - Large chain

  // ═══════════════════════════════════════════════════════════════════════════
  // TIER 3: MID-SIZE RETAIL - Good capacity
  // ═══════════════════════════════════════════════════════════════════════════
  "ribasmith.com": { rate: 15, burst: 25 }, // Was 10/15
  "novey.com.pa": { rate: 15, burst: 25 }, // Was 8/15 - Algolia-powered
  "doitcenter.com.pa": { rate: 15, burst: 25 }, // Was 8/15 - Algolia-powered
  "panafoto.com": { rate: 15, burst: 25 }, // Was 8/15 - Algolia-powered
  "felipemotta.store": { rate: 15, burst: 25 }, // Was 8/15 - Algolia-powered
  "conwayclick.com": { rate: 15, burst: 25 }, // Was 8/15 - Magento
  "stevens.com.pa": { rate: 15, burst: 25 }, // Was 8/15 - Magento
  "supercarnes.com": { rate: 15, burst: 25 }, // Was 8/15 - Magento

  // ═══════════════════════════════════════════════════════════════════════════
  // TIER 4: SHOPIFY - Platform is resilient
  // ═══════════════════════════════════════════════════════════════════════════
  "superbaru.com": { rate: 12, burst: 20 }, // Was 8/15
  "felix.com.pa": { rate: 12, burst: 20 }, // Was 8/15
  "titan.com.pa": { rate: 12, burst: 20 }, // Was 8/15
  "americanpetspanama.com": { rate: 10, burst: 18 }, // Was 6/12
  "melopetandgarden.com": { rate: 10, burst: 18 }, // Was 6/12

  // ═══════════════════════════════════════════════════════════════════════════
  // TIER 5: SMALLER SITES - Still conservative
  // ═══════════════════════════════════════════════════════════════════════════
  "blackdogpanama.com": { rate: 8, burst: 15 }, // Was 5/10 - Odoo
};

const DEFAULT_RATE = 10; // Was 6
const DEFAULT_BURST = 18; // Was 12

// Higher queue depth for aggressive batching
const MAX_QUEUE_DEPTH = 10000; // Was 5000

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
