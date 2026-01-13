// product-management/services/productEnhancer.js

import crypto from "crypto";
import admin, { db, FieldValue, Timestamp } from "../shared/firebase.js";
import { productDataEnhancer } from "../productDataExtractors/extractors.js";
import {
  getBarcodeTypes,
  generateVariations,
} from "../shared/barcodeValidator.js";
import {
  generateDocIdSync,
  formatAsYYYYMMDD,
  getStartOfTodayTimestamp,
  ENHANCEMENT_CONTEXT,
} from "../shared/config.js";

export class ProductResponse {
  constructor() {
    this.url = null;
    this.skuCode = null;
    this.enhancedData = {
      name: null,
      description: null,
      categories: null,
      brand: null,
      price: 0,
      packSize: null,
    };
    this.ean13Code = null;
  }
}

/**
 * Continue global product processing after successful enhancement
 * Uses atomic flag to prevent duplicate Vertex AI calls
 */
async function continueGlobalProductProcessing(
  globalProductId,
  enhancedDataInput
) {
  try {
    // Quick check: is it already processed?
    const globalProductRef = db
      .collection("globalProducts")
      .doc(globalProductId);
    const gpDoc = await globalProductRef.get();

    if (!gpDoc.exists) {
      console.log(
        `[enhancer/${globalProductId}] GlobalProduct no longer exists`
      );
      return;
    }

    const gpData = gpDoc.data();

    // Skip if already processed
    if (gpData.processed === true) {
      console.log(
        `[enhancer/${globalProductId}] Already processed, skipping AI trigger`
      );
      return;
    }

    // Skip if no longer temporary (another enhancer already triggered processing)
    if (gpData.temporary === false && gpData._processingClaimed) {
      console.log(
        `[enhancer/${globalProductId}] Processing already claimed, skipping`
      );
      return;
    }

    // Import dynamically to avoid circular dependency
    const { processGlobalProduct } = await import(
      "./globalProductProcessor.js"
    );

    return processGlobalProduct({
      globalProductId,
      enhancedDataInput,
    });
  } catch (err) {
    console.error(
      `[enhancer/${globalProductId}] Error triggering processing:`,
      err.message
    );
  }
}

/**
 * Main product enhancement function
 *
 * @param {Object} params
 * @param {string} params.brandId - Vendor brand ID
 * @param {string} params.code - Product barcode
 * @param {string} params.initialName - Initial product name
 * @param {string} params.productUrl - Direct product URL (optional)
 * @param {string} params.globalProductId - Associated globalProduct ID (optional)
 * @returns {Promise<{enhancedProductData: ProductResponse|null, barcodeResults: Array}>}
 */
export async function enhanceProduct({
  brandId,
  code,
  initialName,
  productUrl,
  globalProductId,
}) {
  const requestId = `enh-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 6)}`;
  const normalizedCode = code != null ? String(code).toUpperCase() : code;

  // ═══════════════════════════════════════════════════════════════════════════
  // BARCODE-ONLY MODE (no brandId)
  // ═══════════════════════════════════════════════════════════════════════════

  if (!brandId && normalizedCode) {
    return {
      enhancedProductData: null,
      barcodeResults: generateVariations(normalizedCode),
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FULL ENHANCEMENT
  // ═══════════════════════════════════════════════════════════════════════════

  const barcodeTypes = getBarcodeTypes(normalizedCode) ?? [];

  let enhancedProductData = null;

  try {
    enhancedProductData = await productDataEnhancer(
      brandId,
      barcodeTypes,
      initialName,
      productUrl
    );
  } catch (err) {
    console.error(
      `[${requestId}/${brandId}/${normalizedCode}] Enhancement failed:`,
      err.message
    );
  }

  const barcodeResults =
    enhancedProductData && enhancedProductData.ean13Code
      ? generateVariations(enhancedProductData.ean13Code)
      : [];

  // ═══════════════════════════════════════════════════════════════════════════
  // GLOBALPRODUCT ASSOCIATION
  // ═══════════════════════════════════════════════════════════════════════════

  if (brandId && globalProductId && enhancedProductData) {
    const hasValidPrice =
      enhancedProductData.url &&
      enhancedProductData.enhancedData.price &&
      enhancedProductData.enhancedData.price !== 0;

    if (hasValidPrice) {
      const ymd = formatAsYYYYMMDD(getStartOfTodayTimestamp(Timestamp));
      const globalProductRef = db
        .collection("globalProducts")
        .doc(globalProductId);

      try {
        const shouldContinue = await db.runTransaction(async (transaction) => {
          const vendorBrandRef = globalProductRef
            .collection("vendorBrands")
            .doc(brandId);
          const vendorPriceRef = globalProductRef
            .collection("vendorPrices")
            .doc(generateDocIdSync(`${brandId}_${ymd}`));

          const [globalProductSnap, vendorBrandSnap, vendorPriceSnap] =
            await Promise.all([
              transaction.get(globalProductRef),
              transaction.get(vendorBrandRef),
              transaction.get(vendorPriceRef),
            ]);

          if (!globalProductSnap.exists) {
            console.warn(
              `[${requestId}] GlobalProduct ${globalProductId} not found`
            );
            return false;
          }

          const globalProductData = globalProductSnap.data();

          // Create/update vendorBrand
          if (!vendorBrandSnap.exists) {
            transaction.set(
              vendorBrandRef,
              {
                active: true,
                brandRef: db.collection("vendorBrands").doc(brandId),
                url: enhancedProductData.url,
                skuCode: enhancedProductData.skuCode || null,
                lastFetchDate: FieldValue.serverTimestamp(),
                lastPrice: enhancedProductData.enhancedData.price,
                _createdBy: ENHANCEMENT_CONTEXT,
                _createdAt: FieldValue.serverTimestamp(),
              },
              { merge: true }
            );

            // Increment active vendor count
            transaction.update(globalProductRef, {
              activeVendorBrands: FieldValue.increment(1),
            });
          } else {
            // Update existing vendorBrand
            transaction.set(
              vendorBrandRef,
              {
                lastFetchDate: FieldValue.serverTimestamp(),
                lastPrice: enhancedProductData.enhancedData.price,
                url: enhancedProductData.url, // Update URL in case it changed
                _updatedBy: ENHANCEMENT_CONTEXT,
                _updatedAt: FieldValue.serverTimestamp(),
              },
              { merge: true }
            );
          }

          // Create today's price record if not exists
          if (!vendorPriceSnap.exists) {
            transaction.set(
              vendorPriceRef,
              {
                active: true,
                brandRef: db.collection("vendorBrands").doc(brandId),
                price: enhancedProductData.enhancedData.price,
                fetchDate: FieldValue.serverTimestamp(),
              },
              { merge: true }
            );
          }

          // Return whether we should trigger AI processing
          // Only trigger if still temporary AND not already being processed
          return (
            globalProductData.temporary === true &&
            globalProductData.processed !== true &&
            !globalProductData._processingClaimed
          );
        });

        // Trigger AI processing if needed (outside transaction)
        if (shouldContinue) {
          console.log(
            `[${requestId}] Triggering AI processing for ${globalProductId}`
          );

          // Fire and forget, but with proper error handling
          continueGlobalProductProcessing(
            globalProductId,
            enhancedProductData
          ).catch((err) => {
            console.error(
              `[${requestId}] Global Product Processor Error for ${globalProductId}:`,
              err.message
            );
          });
        }
      } catch (err) {
        console.error(
          `[${requestId}] Transaction error for ${globalProductId}:`,
          err.message
        );
        // Don't throw - enhancement succeeded, just association failed
      }
    }
  }

  return { enhancedProductData, barcodeResults };
}
