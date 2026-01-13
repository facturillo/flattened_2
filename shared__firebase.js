// product-management/shared/firebase.js

import admin from "firebase-admin";

// Initialize Firebase once and export
if (!admin.apps.length) {
  admin.initializeApp({
    storageBucket: "panabudget.firebasestorage.app",
  });
}

export const db = admin.firestore();
export const storage = admin.storage();
export const FieldValue = admin.firestore.FieldValue;
export const Timestamp = admin.firestore.Timestamp;

// ═══════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Atomically increment a counter field
 *
 * @param {FirebaseFirestore.DocumentReference} docRef
 * @param {string} field - Counter field name
 * @param {number} delta - Amount to increment (can be negative)
 * @returns {Promise<boolean>} - Success status
 */
export async function atomicIncrement(docRef, field, delta = 1) {
  try {
    await docRef.update({ [field]: FieldValue.increment(delta) });
    return true;
  } catch (error) {
    console.error(`atomicIncrement error on ${docRef.path}:`, error.message);
    return false;
  }
}

export default admin;
