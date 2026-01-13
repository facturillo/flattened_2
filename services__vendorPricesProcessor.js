// product-management/services/vendorPricesProcessor.js

import crypto from "crypto";
import admin, { db, FieldValue, Timestamp } from "../shared/firebase.js";
import { enhanceProduct } from "./productEnhancer.js";
import {
  tryAcquireLock,
  releaseLock,
  extendLock,
} from "../shared/lockManager.js";

function generateDocId(input) {
  return crypto.createHash("sha256").update(input).digest("base64url");
}

function generateRequestId() {
  return `vp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Direct function call instead of HTTP
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

const ALL_BRANDS = [
  "super99",
  "elmachetazo",
  "ribasmith",
  "superxtra",
  "supermercadorey",
  "superbaru",
  "supercarnes",
];

// Lock extension interval (extend every 5 minutes to stay within 20-minute TTL)
const LOCK_EXTENSION_INTERVAL_MS = 5 * 60 * 1000;

// Batch context identifier - used by listeners to skip processing
const BATCH_CONTEXT = "vendor-prices-batch";

export async function processVendorPrices({ globalProductId, dateKey }) {
  const requestId = generateRequestId();
  const globalProductRef = db.collection("globalProducts").doc(globalProductId);

  console.log(
    `[${requestId}] Starting vendor prices processing for ${globalProductId}`
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // LOCK ACQUISITION (now uses subcollection - won't trigger listeners)
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
    // MAIN PROCESSING LOGIC
    // ═══════════════════════════════════════════════════════════════════════════

    // 1) Load master doc to get all EAN variants
    const masterSnap = await globalProductRef.get();
    const masterData = masterSnap.data() || {};
    const globalName = masterData.name;
    const eanVariants = (masterData.eanCodeVariations || []).map(
      (v) => v.barcode
    );

    // 2) Fetch all currently active vendorBrands
    const vendorBrandsSnap = await globalProductRef
      .collection("vendorBrands")
      .where("active", "==", true)
      .get();

    // 3) In parallel, enhance each existing vendorBrand (using skuCode + URL)
    const existingEnhancementPromises = vendorBrandsSnap.docs.map(
      async (doc) => {
        const brand = doc.id;
        const { skuCode, url } = doc.data();
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

    // 4) Determine which brands never returned a price
    const processedBrands = new Set(existingHits.map((h) => h.brand));
    const missingBrands = ALL_BRANDS.filter(
      (brand) => !processedBrands.has(brand)
    );

    // 5) For missing brands, fire ALL EAN variants in parallel per brand
    const missingEnhancementPromises = missingBrands.map(async (brand) => {
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

    // Compute combined hits
    const allHits = [...existingHits, ...missingHits];

    // Find the new lowest price hit
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

    // Prepare info on existing docs that never succeeded
    const failureInfos = vendorBrandsSnap.docs
      .filter((doc) => !processedBrands.has(doc.id))
      .map((doc) => ({
        brand: doc.id,
        lastFetchDate: doc.data().lastFetchDate,
      }));

    // Calculate new activeVendorBrands count
    const currentActiveBrands = new Set(vendorBrandsSnap.docs.map((d) => d.id));
    const brandsToDeactivate = new Set(
      failureInfos
        .filter((f) => f.lastFetchDate && f.lastFetchDate.toDate() < cutoffDate)
        .map((f) => f.brand)
    );
    const newActiveBrands = new Set(missingHits.map((h) => h.brand));

    // Final active count: current - deactivated + newly added
    const finalActiveCount =
      currentActiveBrands.size -
      brandsToDeactivate.size +
      [...newActiveBrands].filter((b) => !currentActiveBrands.has(b)).length;

    // 6) Commit all updates and creates in a single transaction
    await db.runTransaction(async (transaction) => {
      // Deactivate repeated failures older than 7 days
      for (const { brand, lastFetchDate } of failureInfos) {
        if (lastFetchDate && lastFetchDate.toDate() < cutoffDate) {
          const vbRef = globalProductRef.collection("vendorBrands").doc(brand);
          // Add batch context so listener skips this
          transaction.set(
            vbRef,
            {
              active: false,
              _batchContext: BATCH_CONTEXT,
              _batchRequestId: requestId,
              _batchUpdatedAt: FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
        }
      }

      // Update existing vendorBrands and write today's price
      for (const { brand, enhanced } of existingHits) {
        const vbRef = globalProductRef.collection("vendorBrands").doc(brand);
        const vpRef = globalProductRef
          .collection("vendorPrices")
          .doc(generateDocId(`${brand}_${dateKey}`));

        transaction.set(
          vbRef,
          {
            lastFetchDate: FieldValue.serverTimestamp(),
            lastPrice: enhanced.enhancedData.price,
            // Batch context markers
            _batchContext: BATCH_CONTEXT,
            _batchRequestId: requestId,
            _batchUpdatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        transaction.set(vpRef, {
          brandRef: db.collection("vendorBrands").doc(brand),
          price: enhanced.enhancedData.price,
          fetchDate: FieldValue.serverTimestamp(),
          active: true,
        });
      }

      // Create any missing vendorBrands + their first price entry
      for (const { brand, enhanced } of missingHits) {
        const vbRef = globalProductRef.collection("vendorBrands").doc(brand);
        const vpRef = globalProductRef
          .collection("vendorPrices")
          .doc(generateDocId(`${brand}_${dateKey}`));

        transaction.set(
          vbRef,
          {
            active: true,
            brandRef: db.collection("vendorBrands").doc(brand),
            url: enhanced.url,
            skuCode: enhanced.skuCode || null,
            lastFetchDate: FieldValue.serverTimestamp(),
            lastPrice: enhanced.enhancedData.price,
            // Batch context markers
            _batchContext: BATCH_CONTEXT,
            _batchRequestId: requestId,
            _batchUpdatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        transaction.set(vpRef, {
          brandRef: db.collection("vendorBrands").doc(brand),
          price: enhanced.enhancedData.price,
          fetchDate: FieldValue.serverTimestamp(),
          active: true,
        });
      }

      // Update globalProduct with bestPrice AND activeVendorBrands
      // This consolidates what the listener was doing
      const globalProductUpdate = {
        // Batch context so listener skips
        _batchContext: BATCH_CONTEXT,
        _batchRequestId: requestId,
        _batchUpdatedAt: FieldValue.serverTimestamp(),
      };

      // Always update activeVendorBrands (calculated above)
      globalProductUpdate.activeVendorBrands = finalActiveCount;

      // Update best price if we found a new lowest
      if (newLowest) {
        globalProductUpdate.bestPrice = {
          brandRef: db.collection("vendorBrands").doc(newLowest.brand),
          price: newLowest.enhanced.enhancedData.price,
          date: FieldValue.serverTimestamp(),
        };
      }

      transaction.set(globalProductRef, globalProductUpdate, { merge: true });
    });

    console.log(
      `[${requestId}] Completed: ${existingHits.length} existing, ` +
        `${missingHits.length} new, ${failureInfos.length} failures tracked, ` +
        `activeVendorBrands: ${finalActiveCount}`
    );

    return {
      status: 200,
      shouldNack: false,
      message: "Processing succeeded",
      stats: {
        existingHits: existingHits.length,
        missingHits: missingHits.length,
        totalBrands: allHits.length,
        activeVendorBrands: finalActiveCount,
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
