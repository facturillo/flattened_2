// product-management/services/vendorPricesTrigger.js

import { PubSub } from "@google-cloud/pubsub";
import admin, { db, Timestamp } from "../shared/firebase.js";
import {
  formatAsYYYYMMDD,
  getStartOfTodayTimestamp,
} from "../shared/config.js";

const pubsub = new PubSub();

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

  console.log(`[${requestId}] Starting batch for dateKey: ${dateKey}`);

  try {
    while (true) {
      let query = db
        .collection("globalProducts")
        .orderBy(admin.firestore.FieldPath.documentId())
        .limit(pageSize);

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
      if (snapshot.size < pageSize) break;
    }

    console.log(`[${requestId}] Complete. Total published: ${totalScheduled}`);
    return { status: 200, totalScheduled, dateKey };
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
