/**
 * Safely access nested object properties
 */
export function safeGet(obj, path, defaultValue = null) {
  if (!obj || typeof obj !== "object") return defaultValue;

  const keys = path.split(".");
  let result = obj;

  for (const key of keys) {
    if (result == null || typeof result !== "object") {
      return defaultValue;
    }
    result = result[key];
  }

  return result !== undefined ? result : defaultValue;
}

/**
 * Parse price from various formats
 */
export function parsePrice(value) {
  if (typeof value === "number") return value;
  if (!value) return 0;

  const cleaned = String(value).replace(/[^0-9.\-]+/g, "");
  const parsed = parseFloat(cleaned);
  return isNaN(parsed) ? 0 : parsed;
}

/**
 * Validate and normalize product data
 */
export function validateProductData(data, context = {}) {
  if (!data) {
    console.warn(`[${context.brandId}/${context.barcode}] Null product data`);
    return null;
  }

  if (!data.url && !data.enhancedData?.name) {
    console.warn(
      `[${context.brandId}/${context.barcode}] Invalid product: no URL or name`
    );
    return null;
  }

  return data;
}

/**
 * Safe array access
 */
export function safeArray(value, defaultValue = []) {
  return Array.isArray(value) ? value : defaultValue;
}

/**
 * Safe string trim
 */
export function safeTrim(value, defaultValue = "") {
  if (typeof value !== "string") return defaultValue;
  const trimmed = value.trim();
  return trimmed || defaultValue;
}
