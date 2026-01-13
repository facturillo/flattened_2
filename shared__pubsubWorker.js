// product-management/shared/pubsubWorker.js

import { PubSub, Duration } from "@google-cloud/pubsub";

const pubsub = new PubSub();

const WORKER_ROLE = process.env.WORKER_ROLE || "primary";

// Batch: tuned for ~76 req/sec aggregate across 7 domains
// 200 concurrent products × 7 brands = 1400 in-flight requests max
// With rate limiting, this keeps queue depths manageable
const BATCH_CONCURRENCY = parseInt(process.env.BATCH_CONCURRENCY || "1000");

// Realtime: low latency for synchronous requests
const REALTIME_CONCURRENCY = parseInt(process.env.REALTIME_CONCURRENCY || "16");

function getSubscriptionConfig(subscriptionName) {
  return (
    {
      "product-processor-sub": {
        maxMessages: Math.ceil(REALTIME_CONCURRENCY / 2),
      },
      "global-product-processor-sub": {
        maxMessages: Math.ceil(REALTIME_CONCURRENCY / 2),
      },
      "vendor-prices-processor-sub": {
        maxMessages: BATCH_CONCURRENCY,
      },
    }[subscriptionName] || { maxMessages: 5 }
  );
}

export function startPubSubWorkers(handlers) {
  console.log(
    `[PubSub] Role: ${WORKER_ROLE}, Batch: ${BATCH_CONCURRENCY}, Realtime: ${REALTIME_CONCURRENCY}`
  );

  for (const [subscriptionName, handler] of Object.entries(handlers)) {
    const config = getSubscriptionConfig(subscriptionName);

    const subscription = pubsub.subscription(subscriptionName, {
      maxExtensionMinutes: 240,
      minAckDeadline: Duration.from({ seconds: 600 }),
      maxAckDeadline: Duration.from({ seconds: 600 }),
      flowControl: {
        maxMessages: config.maxMessages,
        allowExcessMessages: false,
      },
    });

    subscription.on("message", async (message) => {
      const messageId = message.id;
      const deliveryAttempt = message.deliveryAttempt || 1;

      console.log(
        `[${subscriptionName}] ${messageId} (attempt #${deliveryAttempt})`
      );

      try {
        const data = JSON.parse(message.data.toString());
        const result = await handler(data);

        if (result?.shouldNack === true) {
          console.log(
            `[${subscriptionName}] NACK ${messageId}: ${result.message}`
          );
          message.nack();
        } else {
          message.ack();
        }
      } catch (error) {
        console.error(
          `[${subscriptionName}] Error ${messageId}:`,
          error.message
        );
        message.nack();
      }
    });

    subscription.on("error", (error) => {
      console.error(`[${subscriptionName}] Error:`, error.message);
    });

    console.log(
      `[${subscriptionName}] Started (maxMessages: ${config.maxMessages})`
    );
  }
}
