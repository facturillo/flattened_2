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
export default admin;
