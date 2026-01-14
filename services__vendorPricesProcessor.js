// product-management/services/vendorPricesProcessor.js

import admin, { db, FieldValue, Timestamp } from "../shared/firebase.js";
import { enhanceProduct } from "./productEnhancer.js";
import {
  tryAcquireLock,
  releaseLock,
  extendLock,
} from "../shared/lockManager.js";
import {
  ALL_BRANDS,
  BATCH_CONTEXT,
  generateDocIdSync,
} from "../shared/config.js";

/**
 * Generate unique request ID for tracking
 */
function generateRequestId() {
  return `vp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Direct function call for product enhancement
 */
async function getEnhancedData(brandId, code, productUrl, initialName = null) {
  try {
    const result = await enhanceProduct({
      brandId,
      code,
      initialName,
      productUrl,
    });
    return result?.enhancedProductData ? result : null;
  } catch (error) {
    console.error(`Enhancer error for ${brandId}:`, error.message);
    return null;
  }
}

// Lock extension interval (extend every 5 minutes to stay within 20-minute TTL)
const LOCK_EXTENSION_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Process vendor prices for a globalProduct
 * Fetches current prices from all vendors and updates records
 */
export async function processVendorPrices({ globalProductId, dateKey }) {
  const requestId = generateRequestId();
  const globalProductRef = db.collection("globalProducts").doc(globalProductId);

  console.log(
    `[${requestId}] Starting vendor prices processing for ${globalProductId}`
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // LOCK ACQUISITION
  // ═══════════════════════════════════════════════════════════════════════════

  const lockResult = await tryAcquireLock(globalProductId, requestId);

  if (!lockResult.acquired) {
    if (lockResult.reason === "already_locked") {
      console.log(
        `[${requestId}] Skipping - already being processed by ${lockResult.lockedBy}`
      );
      return {
        status: 429,
        shouldNack: true,
        message: "Already locked by another worker",
        lockedBy: lockResult.lockedBy,
        remainingMs: lockResult.remainingMs,
      };
    }

    if (lockResult.reason === "document_not_found") {
      console.error(
        `[${requestId}] Global product not found: ${globalProductId}`
      );
      return {
        status: 404,
        shouldNack: false,
        message: "Global product not found",
      };
    }

    console.error(`[${requestId}] Lock error: ${lockResult.error}`);
    return {
      status: 500,
      shouldNack: true,
      message: `Lock error: ${lockResult.error}`,
    };
  }

  // Set up lock extension for long-running operations
  const lockExtensionInterval = setInterval(() => {
    extendLock(globalProductId, requestId);
  }, LOCK_EXTENSION_INTERVAL_MS);

  try {
    // ═══════════════════════════════════════════════════════════════════════════
    // PHASE 1: INITIAL READS (outside transaction - for external API calls)
    // These reads inform which external APIs to call, not transaction writes
    // ═══════════════════════════════════════════════════════════════════════════

    const masterSnap = await globalProductRef.get();
    if (!masterSnap.exists) {
      console.error(`[${requestId}] Global product not found after lock`);
      return {
        status: 404,
        shouldNack: false,
        message: "Global product not found",
      };
    }

    const masterData = masterSnap.data() || {};
    const globalName = masterData.name;
    const eanVariants = (masterData.eanCodeVariations || []).map(
      (v) => v.barcode
    );

    // Get initial vendorBrands snapshot for enhancement (may become stale)
    const initialVendorBrandsSnap = await globalProductRef
      .collection("vendorBrands")
      .where("active", "==", true)
      .get();

    // ═══════════════════════════════════════════════════════════════════════════
    // PHASE 2: EXTERNAL API CALLS (must be outside transaction)
    // ═══════════════════════════════════════════════════════════════════════════

    // Enhance each existing vendorBrand (using skuCode + URL)
    const existingBrandsToEnhance = initialVendorBrandsSnap.docs.map((doc) => ({
      brand: doc.id,
      skuCode: doc.data().skuCode,
      url: doc.data().url,
    }));

    const existingEnhancementPromises = existingBrandsToEnhance.map(
      async ({ brand, skuCode, url }) => {
        try {
          const result = await getEnhancedData(brand, skuCode || null, url);
          const enhanced = result?.enhancedProductData;
          const price = enhanced?.enhancedData?.price;
          if (price && price !== 0) {
            return { brand, enhanced };
          }
        } catch (error) {
          console.error(`[${requestId}] Enhancer error for ${brand}:`, error);
        }
        return null;
      }
    );

    const existingHits = (
      await Promise.all(existingEnhancementPromises)
    ).filter(Boolean);

    // Determine which brands returned a price from existing vendorBrands
    const existingBrandsWithPrice = new Set(existingHits.map((h) => h.brand));

    // For brands not in existing vendorBrands OR that failed, try all EAN variants
    const brandsToSearch = ALL_BRANDS.filter(
      (brand) => !existingBrandsWithPrice.has(brand)
    );

    const missingEnhancementPromises = brandsToSearch.map(async (brand) => {
      if (eanVariants.length === 0) return null;

      const attempts = eanVariants.map(async (code) => {
        const result = await getEnhancedData(brand, code, null, globalName);
        const enhanced = result?.enhancedProductData;
        const price = enhanced?.enhancedData?.price;

        if (price && price !== 0 && enhanced?.url) {
          return { brand, enhanced };
        }
        throw new Error("no_match");
      });

      try {
        return await Promise.any(attempts);
      } catch {
        return null;
      }
    });

    const missingHits = (await Promise.all(missingEnhancementPromises)).filter(
      Boolean
    );

    // Combine all successful enhancements
    const allHits = [...existingHits, ...missingHits];
    const allHitsMap = new Map(allHits.map((h) => [h.brand, h]));

    // Find the lowest price hit
    let newLowest = null;
    for (const hit of allHits) {
      const price = hit.enhanced.enhancedData.price;
      if (newLowest === null || price < newLowest.enhanced.enhancedData.price) {
        newLowest = hit;
      }
    }

    // Prepare cutoff for 7-day failures
    const nowTimestamp = Timestamp.now();
    const cutoffDate = new Date(
      nowTimestamp.toDate().getTime() - 7 * 24 * 60 * 60 * 1000
    );

    // ═══════════════════════════════════════════════════════════════════════════
    // PHASE 3: TRANSACTION (atomic reads + writes)
    // Re-read vendorBrands inside transaction for consistency
    // ═══════════════════════════════════════════════════════════════════════════

    const transactionResult = await db.runTransaction(async (transaction) => {
      // Re-read master doc to ensure it still exists
      const freshMasterSnap = await transaction.get(globalProductRef);
      if (!freshMasterSnap.exists) {
        throw new Error("Global product deleted during processing");
      }

      // Re-read ALL vendorBrands (not just active) to get fresh state
      // Note: We read all docs individually since we need transaction consistency
      const vendorBrandsRef = globalProductRef.collection("vendorBrands");

      // Get all vendorBrand doc IDs we might need to read/write
      const allRelevantBrands = new Set([
        ...existingBrandsToEnhance.map((b) => b.brand),
        ...missingHits.map((h) => h.brand),
      ]);

      // Read each vendorBrand document inside transaction
      const freshVendorBrandDocs = new Map();
      for (const brand of allRelevantBrands) {
        const docRef = vendorBrandsRef.doc(brand);
        const docSnap = await transaction.get(docRef);
        freshVendorBrandDocs.set(brand, {
          ref: docRef,
          exists: docSnap.exists,
          data: docSnap.exists ? docSnap.data() : null,
        });
      }

      // Track stats
      let deactivatedCount = 0;
      let updatedCount = 0;
      let createdCount = 0;

      // Process existing vendorBrands
      for (const [brand, docInfo] of freshVendorBrandDocs) {
        if (!docInfo.exists) continue;

        const data = docInfo.data;
        const hit = allHitsMap.get(brand);

        if (hit) {
          // Success - update the vendorBrand and write today's price
          transaction.set(
            docInfo.ref,
            {
              lastFetchDate: FieldValue.serverTimestamp(),
              lastPrice: hit.enhanced.enhancedData.price,
              url: hit.enhanced.url, // Update URL in case it changed
              active: true, // Ensure it's active
              _batchContext: BATCH_CONTEXT,
              _batchRequestId: requestId,
              _batchUpdatedAt: FieldValue.serverTimestamp(),
            },
            { merge: true }
          );

          const vpRef = globalProductRef
            .collection("vendorPrices")
            .doc(generateDocIdSync(`${brand}_${dateKey}`));

          transaction.set(vpRef, {
            brandRef: db.collection("vendorBrands").doc(brand),
            price: hit.enhanced.enhancedData.price,
            fetchDate: FieldValue.serverTimestamp(),
            active: true,
          });

          updatedCount++;
        } else if (data.active === true) {
          // Failed to get price - check if we should deactivate
          const lastFetchDate = data.lastFetchDate;
          if (lastFetchDate && lastFetchDate.toDate() < cutoffDate) {
            // Deactivate after 7 days of failures
            transaction.set(
              docInfo.ref,
              {
                active: false,
                _batchContext: BATCH_CONTEXT,
                _batchRequestId: requestId,
                _batchUpdatedAt: FieldValue.serverTimestamp(),
              },
              { merge: true }
            );
            deactivatedCount++;
          }
        }
      }

      // Create new vendorBrands from missing hits
      for (const hit of missingHits) {
        const docInfo = freshVendorBrandDocs.get(hit.brand);

        // Only create if it doesn't exist (could have been created by another process)
        if (!docInfo || !docInfo.exists) {
          const vbRef = vendorBrandsRef.doc(hit.brand);
          transaction.set(
            vbRef,
            {
              active: true,
              brandRef: db.collection("vendorBrands").doc(hit.brand),
              url: hit.enhanced.url,
              skuCode: hit.enhanced.skuCode || null,
              lastFetchDate: FieldValue.serverTimestamp(),
              lastPrice: hit.enhanced.enhancedData.price,
              _batchContext: BATCH_CONTEXT,
              _batchRequestId: requestId,
              _batchCreatedAt: FieldValue.serverTimestamp(),
            },
            { merge: true }
          );

          const vpRef = globalProductRef
            .collection("vendorPrices")
            .doc(generateDocIdSync(`${hit.brand}_${dateKey}`));

          transaction.set(vpRef, {
            brandRef: db.collection("vendorBrands").doc(hit.brand),
            price: hit.enhanced.enhancedData.price,
            fetchDate: FieldValue.serverTimestamp(),
            active: true,
          });

          createdCount++;
        } else if (docInfo.exists) {
          // Document exists but wasn't in our initial active query
          // (could be inactive) - update it
          transaction.set(
            docInfo.ref,
            {
              active: true,
              url: hit.enhanced.url,
              skuCode: hit.enhanced.skuCode || null,
              lastFetchDate: FieldValue.serverTimestamp(),
              lastPrice: hit.enhanced.enhancedData.price,
              _batchContext: BATCH_CONTEXT,
              _batchRequestId: requestId,
              _batchUpdatedAt: FieldValue.serverTimestamp(),
            },
            { merge: true }
          );

          const vpRef = globalProductRef
            .collection("vendorPrices")
            .doc(generateDocIdSync(`${hit.brand}_${dateKey}`));

          transaction.set(vpRef, {
            brandRef: db.collection("vendorBrands").doc(hit.brand),
            price: hit.enhanced.enhancedData.price,
            fetchDate: FieldValue.serverTimestamp(),
            active: true,
          });

          updatedCount++;
        }
      }

      // Calculate final active count based on fresh data
      let finalActiveCount = 0;
      for (const [brand, docInfo] of freshVendorBrandDocs) {
        const hit = allHitsMap.get(brand);
        const wasActive = docInfo.exists && docInfo.data?.active === true;
        const willBeDeactivated =
          wasActive &&
          !hit &&
          docInfo.data?.lastFetchDate?.toDate() < cutoffDate;

        if (hit || (wasActive && !willBeDeactivated)) {
          finalActiveCount++;
        }
      }

      // Update globalProduct with bestPrice AND activeVendorBrands
      const globalProductUpdate = {
        _batchContext: BATCH_CONTEXT,
        _batchRequestId: requestId,
        _batchUpdatedAt: FieldValue.serverTimestamp(),
        activeVendorBrands: finalActiveCount,
      };

      if (newLowest) {
        globalProductUpdate.bestPrice = {
          brandRef: db.collection("vendorBrands").doc(newLowest.brand),
          price: newLowest.enhanced.enhancedData.price,
          date: FieldValue.serverTimestamp(),
        };
      }

      transaction.set(globalProductRef, globalProductUpdate, { merge: true });

      return {
        updatedCount,
        createdCount,
        deactivatedCount,
        finalActiveCount,
      };
    });

    console.log(
      `[${requestId}] Completed: ${transactionResult.updatedCount} updated, ` +
        `${transactionResult.createdCount} created, ` +
        `${transactionResult.deactivatedCount} deactivated, ` +
        `activeVendorBrands: ${transactionResult.finalActiveCount}`
    );

    return {
      status: 200,
      shouldNack: false,
      message: "Processing succeeded",
      stats: {
        existingHits: existingHits.length,
        missingHits: missingHits.length,
        totalBrands: allHits.length,
        ...transactionResult,
      },
    };
  } catch (error) {
    console.error(`[${requestId}] Error during processing:`, error);
    return {
      status: 500,
      shouldNack: false,
      message: "Internal Server Error",
      error: error.message,
    };
  } finally {
    // ═══════════════════════════════════════════════════════════════════════════
    // ALWAYS RELEASE LOCK
    // ═══════════════════════════════════════════════════════════════════════════
    clearInterval(lockExtensionInterval);
    await releaseLock(globalProductId, requestId);
  }
}
