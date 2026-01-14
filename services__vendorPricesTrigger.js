// product-management/services/vendorPricesTrigger.js

import { PubSub } from "@google-cloud/pubsub";
import admin, { db, Timestamp } from "../shared/firebase.js";
import {
  formatAsYYYYMMDD,
  getStartOfTodayTimestamp,
} from "../shared/config.js";

const pubsub = new PubSub();

// Set to 0 or null to disable limit (process all documents)
const MAX_DOC_LIMIT = 1000;

/**
 * Trigger vendor price processing for all globalProducts
 * Called via Cloud Scheduler (e.g., daily at 6am)
 */
export async function triggerVendorPrices() {
  const requestId = `vpt-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const dateKey = formatAsYYYYMMDD(getStartOfTodayTimestamp(Timestamp));
  const pageSize = 500;
  let lastDoc = null;
  let totalScheduled = 0;

  console.log(
    `[${requestId}] Starting batch for dateKey: ${dateKey}${
      MAX_DOC_LIMIT ? ` (limit: ${MAX_DOC_LIMIT})` : ""
    }`
  );

  try {
    while (true) {
      // Check if we've hit the limit
      if (MAX_DOC_LIMIT && totalScheduled >= MAX_DOC_LIMIT) {
        console.log(
          `[${requestId}] Reached limit of ${MAX_DOC_LIMIT} documents, stopping`
        );
        break;
      }

      // Calculate how many more docs we can process
      const remainingAllowed = MAX_DOC_LIMIT
        ? MAX_DOC_LIMIT - totalScheduled
        : pageSize;
      const currentPageSize = Math.min(pageSize, remainingAllowed);

      let query = db
        .collection("globalProducts")
        .orderBy(admin.firestore.FieldPath.documentId())
        .limit(currentPageSize);

      if (lastDoc) {
        query = query.startAfter(lastDoc);
      }

      const snapshot = await query.get();
      if (snapshot.empty) break;

      const topic = pubsub.topic("vendor-prices-processor");
      const publishPromises = snapshot.docs.map((doc) => {
        const payload = { globalProductId: doc.id, dateKey };
        return topic.publishMessage({
          data: Buffer.from(JSON.stringify(payload)),
        });
      });

      const messageIds = await Promise.all(publishPromises);
      totalScheduled += messageIds.length;

      console.log(
        `[${requestId}] Published ${messageIds.length} messages (total: ${totalScheduled})`
      );

      lastDoc = snapshot.docs[snapshot.docs.length - 1];
      if (snapshot.size < currentPageSize) break;
    }

    console.log(`[${requestId}] Complete. Total published: ${totalScheduled}`);
    return {
      status: 200,
      totalScheduled,
      dateKey,
      limitApplied: MAX_DOC_LIMIT || null,
    };
  } catch (error) {
    console.error(`[${requestId}] Error:`, error);
    return {
      status: 500,
      totalScheduled,
      dateKey,
      error: error.message,
    };
  }
}
