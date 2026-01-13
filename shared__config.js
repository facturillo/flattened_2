// product-management/shared/config.js

import crypto from "crypto";

/**
 * Centralized configuration for product management service
 * Single source of truth for brands, delays, and feature flags
 */

// ═══════════════════════════════════════════════════════════════════════════
// VENDOR BRANDS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * All supported vendor brands for price enhancement
 * Add new brands here - this is the single source of truth
 */
export const ALL_BRANDS = Object.freeze([
  "super99",
  "elmachetazo",
  "ribasmith",
  "superxtra",
  "supermercadorey",
  "superbaru",
  "supercarnes",
]);

/**
 * Brand metadata for future extensibility
 */
export const BRAND_CONFIG = Object.freeze({
  super99: { displayName: "Super 99", tier: 1 },
  elmachetazo: { displayName: "El Machetazo", tier: 1 },
  ribasmith: { displayName: "Riba Smith", tier: 1 },
  superxtra: { displayName: "Super Xtra", tier: 1 },
  supermercadorey: { displayName: "Supermercado Rey", tier: 1 },
  superbaru: { displayName: "Super Baru", tier: 2 },
  supercarnes: { displayName: "Super Carnes", tier: 2 },
});

// ═══════════════════════════════════════════════════════════════════════════
// TIMING CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Delay before reprocessing temporary globalProducts (in seconds)
 */
export const TEMPORARY_PRODUCT_DELAY_SECONDS = 60;

/**
 * TTL for temporary products before cleanup (in hours)
 */
export const TEMPORARY_PRODUCT_TTL_HOURS = 24;

/**
 * Maximum age for stale locks before override (in ms)
 */
export const LOCK_TTL_MS = parseInt(process.env.LOCK_TTL_MS || "1200000"); // 20 minutes

// ═══════════════════════════════════════════════════════════════════════════
// PROCESSING FLAGS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Batch context identifier - used by listeners to skip batch-originated writes
 */
export const BATCH_CONTEXT = "vendor-prices-batch";

/**
 * Enhancement context identifier - used to track enhancement-originated writes
 */
export const ENHANCEMENT_CONTEXT = "product-enhancement";

// ═══════════════════════════════════════════════════════════════════════════
// DATE UTILITIES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get start of today as Firestore Timestamp
 * Uses UTC to ensure consistency across timezones
 * @param {admin.firestore.Timestamp} Timestamp - Firestore Timestamp class
 * @returns {admin.firestore.Timestamp}
 */
export function getStartOfTodayTimestamp(Timestamp) {
  const now = new Date();
  // Use UTC to prevent timezone drift issues
  const start = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      0,
      0,
      0,
      0
    )
  );
  return Timestamp.fromDate(start);
}

/**
 * Format timestamp as YYYYMMDD string (UTC)
 * @param {Date|admin.firestore.Timestamp} ts
 * @returns {string}
 */
export function formatAsYYYYMMDD(ts) {
  const d = ts.toDate ? ts.toDate() : ts;
  // Use UTC methods for consistency
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// ID GENERATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generate deterministic document ID from input string
 * @param {string} input
 * @returns {string}
 */
export function generateDocIdSync(input) {
  return crypto.createHash("sha256").update(input).digest("base64url");
}
