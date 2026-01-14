// product-management/services/globalProductProcessor.js

import { PubSub } from "@google-cloud/pubsub";
import { db, FieldValue } from "../shared/firebase.js";
import {
  systemInstruction as categoryInstruction,
  responseSchema as categoryResponseSchema,
} from "../systemInstructions/category.js";
import {
  systemInstruction as brandInstruction,
  responseSchema as brandResponseSchema,
} from "../systemInstructions/brand.js";
import { vertexAIExtraction } from "../shared/vertexAI.js";
import { enhanceProduct } from "./productEnhancer.js";
import {
  ALL_BRANDS,
  TEMPORARY_PRODUCT_DELAY_SECONDS,
  TEMPORARY_PRODUCT_TTL_HOURS,
  generateDocIdSync,
} from "../shared/config.js";

const pubsub = new PubSub();

/**
 * Enhancement result tracker
 * Prevents duplicate Vertex AI calls when multiple enhancers succeed
 */
const processingTracker = new Map();
const TRACKER_TTL_MS = 5 * 60 * 1000;

function getTrackerKey(globalProductId) {
  return `gp_${globalProductId}`;
}

function isAlreadyProcessing(globalProductId) {
  const key = getTrackerKey(globalProductId);
  const entry = processingTracker.get(key);

  if (!entry) return false;

  if (Date.now() - entry.startedAt > TRACKER_TTL_MS) {
    processingTracker.delete(key);
    return false;
  }

  return true;
}

function markProcessingStarted(globalProductId, requestId) {
  const key = getTrackerKey(globalProductId);
  processingTracker.set(key, {
    startedAt: Date.now(),
    requestId,
  });
}

function markProcessingComplete(globalProductId) {
  const key = getTrackerKey(globalProductId);
  processingTracker.delete(key);
}

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of processingTracker) {
    if (now - entry.startedAt > TRACKER_TTL_MS) {
      processingTracker.delete(key);
    }
  }
}, 60000);

/**
 * Direct function call instead of HTTP - used for internal enhancement
 * Uses skipBarcodeExpansion since codes come from eanCodeVariations (already expanded)
 */
async function getEnhancedData(brandId, code, initialName, globalProductId) {
  try {
    const result = await enhanceProduct({
      brandId,
      code,
      initialName,
      globalProductId,
      skipBarcodeExpansion: true,
    });
    return result;
  } catch (err) {
    console.error(`[${brandId}/${code}] Enhancer error:`, err.message);
    return null;
  }
}

/**
 * Track enhancement results for a globalProduct
 */
async function trackEnhancementResults(globalProductRef, results) {
  const succeeded = results.filter(
    (r) => r.status === "fulfilled" && r.value && r.value.result
  );
  const failed = results.filter(
    (r) => r.status === "rejected" || !r.value || !r.value.result
  );

  try {
    await globalProductRef.collection("_metadata").doc("enhancement").set(
      {
        lastEnhancementAt: FieldValue.serverTimestamp(),
        successCount: succeeded.length,
        failureCount: failed.length,
        totalAttempts: results.length,
      },
      { merge: true }
    );
  } catch (err) {
    console.warn(`Failed to track enhancement results: ${err.message}`);
  }

  return { succeeded: succeeded.length, failed: failed.length };
}

/**
 * Main processor for globalProduct creation/update events
 */
export async function processGlobalProduct({
  firestoreReceived,
  globalProductId,
  enhancedDataInput,
  processAfter,
  _idempotencyKey,
}) {
  const requestId = `gpp-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;

  try {
    let shouldComplete = false;
    let globalProductRef;
    let productInputString = null;

    // ═══════════════════════════════════════════════════════════════════════
    // DELAYED MESSAGE HANDLING
    // ═══════════════════════════════════════════════════════════════════════

    if (processAfter && Date.now() < processAfter) {
      const waitMs = processAfter - Date.now();
      console.log(
        `[${requestId}] Waiting ${Math.round(
          waitMs / 1000
        )}s before processing...`
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    // ═══════════════════════════════════════════════════════════════════════
    // PATH 1: FIRESTORE TRIGGER (new globalProduct created)
    // ═══════════════════════════════════════════════════════════════════════

    if (firestoreReceived) {
      const newValue = firestoreReceived.value;
      const fullDocPath = newValue.name;
      const globalProductDocPath = fullDocPath.split("/documents/")[1];
      globalProductRef = db.doc(globalProductDocPath);

      const newFields = (newValue && newValue.fields) || {};
      const temporary = newFields.temporary?.booleanValue ?? false;
      const initialName = newFields.globalName?.stringValue ?? null;
      productInputString = newFields.productInputString?.stringValue ?? null;

      const eanVariants = (
        newFields.eanCodeVariations?.arrayValue?.values || []
      ).map((v) => {
        const f = v.mapValue.fields;
        return f.barcode.stringValue;
      });

      console.log(
        `[${requestId}] Processing globalProduct ${globalProductRef.id}, temporary: ${temporary}, variants: ${eanVariants.length}`
      );

      // ═══════════════════════════════════════════════════════════════════
      // FIRE ENHANCEMENT REQUESTS (with result tracking)
      // ═══════════════════════════════════════════════════════════════════

      const enhancementPromises = [];
      for (const brand of ALL_BRANDS) {
        for (const code of eanVariants) {
          enhancementPromises.push(
            getEnhancedData(brand, code, initialName, globalProductRef.id)
              .then((result) => ({ brand, code, result }))
              .catch((err) => ({
                brand,
                code,
                error: err.message,
                result: null,
              }))
          );
        }
      }

      Promise.allSettled(enhancementPromises)
        .then((results) => trackEnhancementResults(globalProductRef, results))
        .catch((err) =>
          console.error(
            `[${requestId}] trackEnhancementResults failed:`,
            err.message
          )
        );

      // ═══════════════════════════════════════════════════════════════════
      // TEMPORARY PRODUCT HANDLING
      // ═══════════════════════════════════════════════════════════════════

      if (temporary) {
        console.log(
          `[${requestId}] Temporary flow - scheduling delayed reprocessing`
        );

        const idempotencyKey = `${globalProductRef.id}_${Date.now()}`;
        const payload = {
          globalProductId: globalProductRef.id,
          processAfter: Date.now() + TEMPORARY_PRODUCT_DELAY_SECONDS * 1000,
          _idempotencyKey: idempotencyKey,
        };
        const dataBuffer = Buffer.from(JSON.stringify(payload));

        const messageId = await pubsub
          .topic("global-product-processor")
          .publishMessage({ data: dataBuffer });

        console.log(
          `[${requestId}] Published delayed message ${messageId} for ${globalProductRef.id}`
        );

        return {
          status: 200,
          message: "Temporary globalProduct scheduled for delayed processing",
          messageId,
        };
      } else {
        shouldComplete = true;
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // PATH 2: DELAYED REPROCESSING OR ENHANCEMENT CALLBACK
    // ═══════════════════════════════════════════════════════════════════════
    else if (globalProductId) {
      globalProductRef = db.collection("globalProducts").doc(globalProductId);

      if (enhancedDataInput) {
        console.log(
          `[${requestId}] Enhancement callback for ${globalProductId}`
        );

        const claimResult = await db.runTransaction(async (transaction) => {
          const doc = await transaction.get(globalProductRef);

          if (!doc.exists) {
            return { won: false, reason: "not_found" };
          }

          const data = doc.data();

          if (data.processed === true) {
            return { won: false, reason: "already_processed" };
          }

          if (data._processingClaimed) {
            const claimTime = data._processingClaimedAt?.toMillis?.() || 0;
            const claimAge = Date.now() - claimTime;

            if (claimAge < 5 * 60 * 1000) {
              return {
                won: false,
                reason: "claimed_by_other",
                claimedBy: data._processingClaimed,
                claimAge: Math.round(claimAge / 1000),
              };
            }
            console.log(
              `[${requestId}] Overriding stale claim from ${data._processingClaimed}`
            );
          }

          transaction.update(globalProductRef, {
            _processingClaimed: requestId,
            _processingClaimedAt: FieldValue.serverTimestamp(),
          });

          return { won: true };
        });

        if (!claimResult.won) {
          console.log(
            `[${requestId}] Claim failed: ${claimResult.reason}` +
              (claimResult.claimedBy
                ? ` (held by ${claimResult.claimedBy})`
                : "")
          );
          return { status: 200, message: claimResult.reason };
        }

        if (isAlreadyProcessing(globalProductId)) {
          console.log(`[${requestId}] Already processing in-memory, skipping`);
          return { status: 200, message: "Already processing in memory" };
        }

        markProcessingStarted(globalProductId, requestId);

        const eanCode = enhancedDataInput.ean13Code;
        productInputString = `Code: ${eanCode}
    Description: ${
      enhancedDataInput.enhancedData?.description ??
      enhancedDataInput.enhancedData?.name
    }
    Enhanced Product Data: ${JSON.stringify(enhancedDataInput.enhancedData)}`;
        shouldComplete = true;
      } else {
        console.log(
          `[${requestId}] Delayed reprocessing check for ${globalProductId}`
        );

        const cleanupResult = await db.runTransaction(async (transaction) => {
          const globalProductDoc = await transaction.get(globalProductRef);

          if (!globalProductDoc.exists) {
            return { action: "not_found" };
          }

          const globalProductData = globalProductDoc.data();

          if (globalProductData.processed === true) {
            return { action: "already_processed" };
          }

          if (globalProductData.temporary === false) {
            return { action: "no_longer_temporary" };
          }

          console.log(`[${requestId}] Cleaning up stale temporary product`);

          const historyQuery = db
            .collectionGroup("productSearchHistory")
            .where("globalProductRef", "==", globalProductRef);
          const historySnap = await transaction.get(historyQuery);

          historySnap.docs.forEach((historyDoc) =>
            transaction.delete(historyDoc.ref)
          );
          transaction.delete(globalProductRef);

          return { action: "cleaned_up", deletedHistoryDocs: historySnap.size };
        });

        console.log(`[${requestId}] Cleanup result: ${cleanupResult.action}`);
        return { status: 200, message: cleanupResult.action, ...cleanupResult };
      }
    } else {
      console.error(
        `[${requestId}] Invalid inputs - no firestoreReceived or globalProductId`
      );
      return { status: 400, message: "Invalid inputs" };
    }

    // ═══════════════════════════════════════════════════════════════════════
    // COMPLETE PROCESSING (Vertex AI calls)
    // ═══════════════════════════════════════════════════════════════════════

    if (shouldComplete && productInputString) {
      console.log(
        `[${requestId}] Running Vertex AI extraction for ${globalProductRef.id}`
      );

      try {
        const categoryPromise = vertexAIExtraction(
          productInputString,
          categoryInstruction,
          categoryResponseSchema,
          "globalProductCategory"
        );
        const brandPromise = vertexAIExtraction(
          productInputString,
          brandInstruction,
          brandResponseSchema,
          "globalProductBrand"
        );

        const [categoryResult, brandResult] = await Promise.all([
          categoryPromise,
          brandPromise,
        ]);

        const {
          globalName,
          packSize,
          category: productCategory,
        } = categoryResult || {};
        const { brandName, brandUrl } = brandResult || {};

        await db.runTransaction(async (transaction) => {
          const globalProductSnap = await transaction.get(globalProductRef);

          if (!globalProductSnap.exists) {
            console.warn(
              `[${requestId}] GlobalProduct disappeared during processing`
            );
            return;
          }

          const currentData = globalProductSnap.data();
          if (currentData.processed === true) {
            console.log(
              `[${requestId}] Already processed by another worker, skipping update`
            );
            return;
          }

          let brandRef = null;
          if (brandUrl && brandName) {
            const brandId = generateDocIdSync(brandUrl);
            brandRef = db.collection("productBrands").doc(brandId);
            const brandDoc = await transaction.get(brandRef);

            if (!brandDoc.exists) {
              transaction.set(
                brandRef,
                {
                  name: brandName,
                  url: brandUrl,
                  createDate: FieldValue.serverTimestamp(),
                },
                { merge: true }
              );
            }
          }

          transaction.set(
            globalProductRef,
            {
              processed: true,
              processedAt: FieldValue.serverTimestamp(),
              name: globalName || currentData.name,
              brandRef: brandRef,
              brandName: brandRef ? brandName : null,
              packSize: packSize === "null" ? null : packSize,
              category: productCategory || "other",
              productInputString: FieldValue.delete(),
              temporary: false,
              _processingClaimed: FieldValue.delete(),
              _processedBy: requestId,
            },
            { merge: true }
          );
        });

        console.log(`[${requestId}] Processing completed successfully`);
      } finally {
        markProcessingComplete(globalProductRef.id);
      }
    }

    return { status: 200, message: "Processing succeeded" };
  } catch (error) {
    console.error(`[${requestId}] Error during processing:`, error);

    if (globalProductId) {
      markProcessingComplete(globalProductId);
    }

    return {
      status: 500,
      message: "Internal Server Error",
      error: error.message,
    };
  }
}

/**
 * Cleanup job for stale temporary globalProducts
 */
export async function cleanupStaleTemporaryProducts(batchSize = 500) {
  const requestId = `cleanup-${Date.now()}`;
  console.log(`[${requestId}] Starting stale temporary product cleanup`);

  const cutoffTime = new Date(
    Date.now() - TEMPORARY_PRODUCT_TTL_HOURS * 60 * 60 * 1000
  );
  let cleaned = 0;
  let errors = 0;

  try {
    const staleQuery = db
      .collection("globalProducts")
      .where("temporary", "==", true)
      .where("createDate", "<", cutoffTime)
      .limit(batchSize);

    const snapshot = await staleQuery.get();

    if (snapshot.empty) {
      console.log(`[${requestId}] No stale temporary products found`);
      return { cleaned: 0, errors: 0 };
    }

    console.log(
      `[${requestId}] Found ${snapshot.size} stale temporary products`
    );

    for (const doc of snapshot.docs) {
      try {
        await db.runTransaction(async (transaction) => {
          const freshDoc = await transaction.get(doc.ref);

          if (!freshDoc.exists) return;

          const data = freshDoc.data();

          if (data.temporary !== true) return;
          if (data.createDate?.toDate() >= cutoffTime) return;

          const historyQuery = db
            .collectionGroup("productSearchHistory")
            .where("globalProductRef", "==", doc.ref);
          const historySnap = await transaction.get(historyQuery);

          historySnap.docs.forEach((historyDoc) =>
            transaction.delete(historyDoc.ref)
          );

          transaction.delete(doc.ref);
        });

        cleaned++;
      } catch (err) {
        console.error(`[${requestId}] Error cleaning ${doc.id}:`, err.message);
        errors++;
      }
    }

    console.log(
      `[${requestId}] Cleanup complete: ${cleaned} cleaned, ${errors} errors`
    );
    return { cleaned, errors };
  } catch (error) {
    console.error(`[${requestId}] Cleanup job error:`, error);
    return { cleaned, errors: errors + 1, fatalError: error.message };
  }
}
