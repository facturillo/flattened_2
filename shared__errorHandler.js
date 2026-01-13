/**
 * Standardized error wrapper for extractor functions
 */
export async function withErrorHandling(fn, context = {}) {
  const { brandId, barcode, method } = context;
  const contextStr = `${brandId || "unknown"}/${barcode || "unknown"}`;

  try {
    const result = await fn();

    if (result === null) {
      console.log(`[${contextStr}] ${method}: Product not found`);
    }

    return result;
  } catch (error) {
    const errorMsg = error.message || "Unknown error";
    const stack = error.stack?.split("\n")[1]?.trim() || "";

    console.error(`[${contextStr}] ${method} uncaught error:`, errorMsg, stack);

    return null;
  }
}
