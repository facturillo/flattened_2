// product-management/shared/lockManager.js
/**
 * Distributed locking for long-running operations
 *
 * Uses a subcollection under globalProducts to avoid triggering
 * document listeners on the main globalProducts collection.
 *
 * Structure: globalProducts/{id}/locks/{lockType}
 */

import { db, FieldValue } from "./firebase.js";

// Lock TTL - should be longer than max expected processing time
const LOCK_TTL_MS = parseInt(process.env.LOCK_TTL_MS || "1200000"); // 20 minutes

/**
 * Get the lock document reference for a globalProduct
 *
 * @param {string} globalProductId - The globalProduct document ID
 * @param {string} lockType - Type of lock (e.g., 'vendorPrices', 'processing')
 * @returns {FirebaseFirestore.DocumentReference}
 */
function getLockRef(globalProductId, lockType = "vendorPrices") {
  return db
    .collection("globalProducts")
    .doc(globalProductId)
    .collection("locks")
    .doc(lockType);
}

/**
 * Try to acquire a processing lock on a globalProduct
 *
 * @param {string} globalProductId - The globalProduct document ID
 * @param {string} requestId - Unique request identifier for this processing attempt
 * @param {string} lockType - Type of lock to acquire
 * @returns {Promise<{acquired: boolean, reason?: string, ...}>}
 */
export async function tryAcquireLock(
  globalProductId,
  requestId,
  lockType = "vendorPrices"
) {
  const lockRef = getLockRef(globalProductId, lockType);
  const globalProductRef = db.collection("globalProducts").doc(globalProductId);

  try {
    const result = await db.runTransaction(async (transaction) => {
      // First verify the parent document exists
      const parentDoc = await transaction.get(globalProductRef);
      if (!parentDoc.exists) {
        return { acquired: false, reason: "document_not_found" };
      }

      // Check lock status
      const lockDoc = await transaction.get(lockRef);

      if (lockDoc.exists) {
        const lock = lockDoc.data();

        if (lock && lock.lockedAt) {
          const lockTimestamp = lock.lockedAt.toMillis
            ? lock.lockedAt.toMillis()
            : new Date(lock.lockedAt).getTime();
          const lockAge = Date.now() - lockTimestamp;

          if (lockAge < LOCK_TTL_MS) {
            return {
              acquired: false,
              reason: "already_locked",
              lockedBy: lock.lockedBy,
              lockAge: Math.floor(lockAge / 1000),
              remainingMs: LOCK_TTL_MS - lockAge,
            };
          }

          // Stale lock - override it
          console.log(
            `[${requestId}] Overriding stale lock from ${lock.lockedBy} ` +
              `(age: ${Math.floor(lockAge / 1000)}s, TTL: ${
                LOCK_TTL_MS / 1000
              }s)`
          );
        }
      }

      // Acquire the lock
      transaction.set(lockRef, {
        lockedAt: FieldValue.serverTimestamp(),
        lockedBy: requestId,
        lockType,
        globalProductId,
        startedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + LOCK_TTL_MS).toISOString(),
        extensionCount: 0,
      });

      return { acquired: true };
    });

    if (result.acquired) {
      console.log(
        `[${requestId}] Lock acquired on globalProduct/${globalProductId}/locks/${lockType}`
      );
    } else if (result.reason === "already_locked") {
      console.log(
        `[${requestId}] Lock held by ${result.lockedBy} ` +
          `(age: ${result.lockAge}s, remaining: ${Math.floor(
            result.remainingMs / 1000
          )}s)`
      );
    }

    return result;
  } catch (error) {
    console.error(`[${requestId}] Lock acquisition error: ${error.message}`);
    return {
      acquired: false,
      reason: "lock_error",
      error: error.message,
    };
  }
}

/**
 * Release a processing lock
 *
 * Only releases if the lock is held by the same requestId
 *
 * @param {string} globalProductId - The globalProduct document ID
 * @param {string} requestId - The request that holds the lock
 * @param {string} lockType - Type of lock to release
 */
export async function releaseLock(
  globalProductId,
  requestId,
  lockType = "vendorPrices"
) {
  const lockRef = getLockRef(globalProductId, lockType);

  try {
    await db.runTransaction(async (transaction) => {
      const lockDoc = await transaction.get(lockRef);

      if (!lockDoc.exists) {
        console.log(
          `[${requestId}] No lock to release on globalProduct/${globalProductId}`
        );
        return;
      }

      const lock = lockDoc.data();

      if (lock && lock.lockedBy === requestId) {
        transaction.delete(lockRef);
        console.log(
          `[${requestId}] Lock released on globalProduct/${globalProductId}/locks/${lockType}`
        );
      } else if (lock) {
        console.warn(
          `[${requestId}] Cannot release lock held by ${lock.lockedBy}`
        );
      }
    });
  } catch (error) {
    console.error(`[${requestId}] Lock release error: ${error.message}`);
  }
}

/**
 * Extend lock TTL for long-running operations
 *
 * Call periodically (e.g., every 4-5 minutes) to prevent lock expiration
 *
 * @param {string} globalProductId - The globalProduct document ID
 * @param {string} requestId - The request that holds the lock
 * @param {string} lockType - Type of lock to extend
 */
export async function extendLock(
  globalProductId,
  requestId,
  lockType = "vendorPrices"
) {
  const lockRef = getLockRef(globalProductId, lockType);

  try {
    await db.runTransaction(async (transaction) => {
      const lockDoc = await transaction.get(lockRef);

      if (!lockDoc.exists) return;

      const lock = lockDoc.data();

      if (lock && lock.lockedBy === requestId) {
        transaction.update(lockRef, {
          lockedAt: FieldValue.serverTimestamp(),
          expiresAt: new Date(Date.now() + LOCK_TTL_MS).toISOString(),
          extendedAt: new Date().toISOString(),
          extensionCount: (lock.extensionCount || 0) + 1,
        });
        console.log(
          `[${requestId}] Lock extended on globalProduct/${globalProductId}/locks/${lockType}`
        );
      }
    });
  } catch (error) {
    console.error(`[${requestId}] Lock extension error: ${error.message}`);
  }
}

/**
 * Check if a document is currently locked
 *
 * @param {string} globalProductId - The globalProduct document ID
 * @param {string} lockType - Type of lock to check
 * @returns {Promise<{locked: boolean, lockedBy?: string, lockAge?: number}>}
 */
export async function checkLockStatus(
  globalProductId,
  lockType = "vendorPrices"
) {
  const lockRef = getLockRef(globalProductId, lockType);

  try {
    const lockDoc = await lockRef.get();

    if (!lockDoc.exists) {
      return { locked: false };
    }

    const lock = lockDoc.data();

    if (!lock || !lock.lockedAt) {
      return { locked: false };
    }

    const lockTimestamp = lock.lockedAt.toMillis
      ? lock.lockedAt.toMillis()
      : new Date(lock.lockedAt).getTime();
    const lockAge = Date.now() - lockTimestamp;

    if (lockAge >= LOCK_TTL_MS) {
      return { locked: false, reason: "lock_expired" };
    }

    return {
      locked: true,
      lockedBy: lock.lockedBy,
      lockAge: Math.floor(lockAge / 1000),
      remainingMs: LOCK_TTL_MS - lockAge,
    };
  } catch (error) {
    return { locked: false, error: error.message };
  }
}

/**
 * Clean up expired locks (maintenance function)
 * Can be called periodically via Cloud Scheduler
 *
 * @param {number} batchSize - Number of locks to check per call
 * @returns {Promise<{cleaned: number, errors: number}>}
 */
export async function cleanupExpiredLocks(batchSize = 500) {
  const cutoffTime = new Date(Date.now() - LOCK_TTL_MS);
  let cleaned = 0;
  let errors = 0;

  try {
    // Query all lock subcollections using collection group
    const expiredLocks = await db
      .collectionGroup("locks")
      .where("expiresAt", "<", cutoffTime.toISOString())
      .limit(batchSize)
      .get();

    const batch = db.batch();

    expiredLocks.docs.forEach((doc) => {
      batch.delete(doc.ref);
      cleaned++;
    });

    if (cleaned > 0) {
      await batch.commit();
      console.log(`[LockCleanup] Cleaned ${cleaned} expired locks`);
    }
  } catch (error) {
    console.error(`[LockCleanup] Error: ${error.message}`);
    errors++;
  }

  return { cleaned, errors };
}

export { LOCK_TTL_MS, getLockRef };
