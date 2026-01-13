// product-management/services/vendorPricesTrigger.js

import { PubSub } from "@google-cloud/pubsub";
import admin, { db } from "../shared/firebase.js";

const pubsub = new PubSub();

function getStartOfTodayTimestamp() {
  const now = admin.firestore.Timestamp.now().toDate();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return admin.firestore.Timestamp.fromDate(start);
}

function formatAsYYYYMMDD(ts) {
  const date = ts.toDate ? ts.toDate() : ts;
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

export async function triggerVendorPrices() {
  const dateKey = formatAsYYYYMMDD(getStartOfTodayTimestamp());
  const pageSize = 500;
  const maxTotal = 50_000_000;
  let lastDoc = null;
  let totalScheduled = 0;

  console.log(`[vendor-prices-trigger] Starting batch for dateKey: ${dateKey}`);

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
      `[vendor-prices-trigger] Published ${messageIds.length} messages (total: ${totalScheduled})`
    );

    if (totalScheduled >= maxTotal) break;

    lastDoc = snapshot.docs[snapshot.docs.length - 1];
    if (snapshot.size < pageSize) break;
  }

  console.log(
    `[vendor-prices-trigger] Complete. Total published: ${totalScheduled}`
  );
  return { status: 200, totalScheduled, dateKey };
}
