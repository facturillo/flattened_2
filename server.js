// product-management/server.js

function formatLog(level, args) {
  const timestamp = new Date().toISOString();
  const message = args
    .map((arg) => (typeof arg === "object" ? JSON.stringify(arg) : String(arg)))
    .join(" ");
  return `${timestamp} [${level}] ${message}\n`;
}

console.log = (...args) => process.stderr.write(formatLog("INFO", args));
console.info = (...args) => process.stderr.write(formatLog("INFO", args));
console.warn = (...args) => process.stderr.write(formatLog("WARN", args));
console.error = (...args) => process.stderr.write(formatLog("ERROR", args));
console.debug = (...args) => process.stderr.write(formatLog("DEBUG", args));

import express from "express";
import { startPubSubWorkers } from "./shared/pubsubWorker.js";
import { enhanceProduct } from "./services/productEnhancer.js";
import { processProduct } from "./services/productProcessor.js";
import {
  processGlobalProduct,
  cleanupStaleTemporaryProducts,
} from "./services/globalProductProcessor.js";
import { processVendorPrices } from "./services/vendorPricesProcessor.js";
import { triggerVendorPrices } from "./services/vendorPricesTrigger.js";
import { cleanupExpiredLocks } from "./shared/lockManager.js";

const WORKER_ROLE = process.env.WORKER_ROLE || "primary";

console.log(`Starting product-management service (role: ${WORKER_ROLE})`);

const app = express();
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    role: WORKER_ROLE,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

if (WORKER_ROLE === "primary") {
  app.use((req, res, next) => {
    if (req.path === "/health") return next();
    const start = Date.now();
    console.log(`→ ${req.method} ${req.path}`);
    const originalSend = res.send;
    res.send = function (body) {
      console.log(
        `← ${req.method} ${req.path} ${res.statusCode} (${
          Date.now() - start
        }ms)`
      );
      return originalSend.call(this, body);
    };
    next();
  });

  app.post("/product-enhancer", async (req, res) => {
    try {
      const { brandId, code, initialName, productUrl, globalProductId } =
        req.body;
      if (!code)
        return res.status(400).json({ error: "Missing required field: code" });
      const result = await enhanceProduct({
        brandId,
        code,
        initialName,
        productUrl,
        globalProductId,
      });
      res.json(result);
    } catch (error) {
      console.error("[product-enhancer] Error:", error.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/product-processor", async (req, res) => {
    try {
      await processProduct(req.body);
      res.json({ success: true });
    } catch (error) {
      console.error("[product-processor] Error:", error.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/global-product-processor", async (req, res) => {
    try {
      await processGlobalProduct(req.body);
      res.json({ success: true });
    } catch (error) {
      console.error("[global-product-processor] Error:", error.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/vendor-prices-processor", async (req, res) => {
    try {
      await processVendorPrices(req.body);
      res.json({ success: true });
    } catch (error) {
      console.error("[vendor-prices-processor] Error:", error.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // MAINTENANCE ENDPOINTS (for Cloud Scheduler)
  // ═══════════════════════════════════════════════════════════════════════════

  app.post("/cleanup/temporary-products", async (req, res) => {
    try {
      const result = await cleanupStaleTemporaryProducts(req.body.batchSize);
      res.json(result);
    } catch (error) {
      console.error("[cleanup/temporary-products] Error:", error.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/cleanup/expired-locks", async (req, res) => {
    try {
      const result = await cleanupExpiredLocks(req.body.batchSize);
      res.json(result);
    } catch (error) {
      console.error("[cleanup/expired-locks] Error:", error.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });
}

const handlers = {};

if (WORKER_ROLE === "primary") {
  handlers["product-processor-sub"] = processProduct;
  handlers["global-product-processor-sub"] = processGlobalProduct;
  handlers["vendor-prices-processor-sub"] = processVendorPrices;
  handlers["vendor-prices-trigger-sub"] = triggerVendorPrices;
} else if (WORKER_ROLE === "batch") {
  handlers["vendor-prices-processor-sub"] = processVendorPrices;
}

startPubSubWorkers(handlers);

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Listening on port ${PORT} (role: ${WORKER_ROLE})`);
  console.log(`Subscriptions: ${Object.keys(handlers).join(", ")}`);
});
