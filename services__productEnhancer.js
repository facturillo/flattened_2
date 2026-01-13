import crypto from "crypto";
import admin, { db, FieldValue, Timestamp } from "../shared/firebase.js";
import { productDataEnhancer } from "../productDataExtractors/extractors.js";
import {
  getBarcodeTypes,
  generateVariations,
} from "../shared/barcodeValidator.js";

// Helper function to generate a deterministic document ID
function generateDocId(input) {
  return crypto.createHash("sha256").update(input).digest("base64url");
}

function getStartOfTodayTimestamp() {
  const now = Timestamp.now().toDate();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Timestamp.fromDate(start);
}

function formatAsYYYYMMDD(ts) {
  const d = ts.toDate ? ts.toDate() : ts;
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

export class ProductResponse {
  constructor() {
    this.url = null;
    this.skuCode = null;
    this.enhancedData = {
      name: null,
      description: null,
      categories: null,
      brand: null,
      price: 0,
      packSize: null,
    };
    this.ean13Code = null;
  }
}

// Direct function call instead of HTTP - used internally
async function continueGlobalProductProcessing(
  globalProductId,
  enhancedDataInput
) {
  // Import here to avoid circular dependency
  const { processGlobalProduct } = await import("./globalProductProcessor.js");
  return processGlobalProduct({
    globalProductId,
    enhancedDataInput,
  });
}

export async function enhanceProduct({
  brandId,
  code,
  initialName,
  productUrl,
  globalProductId,
}) {
  const normalizedCode = code != null ? String(code).toUpperCase() : code;

  if (!brandId && normalizedCode) {
    return {
      enhancedProductData: null,
      barcodeResults: generateVariations(normalizedCode),
    };
  }

  const enhancedProductData = await productDataEnhancer(
    brandId,
    getBarcodeTypes(normalizedCode) ?? [],
    initialName,
    productUrl
  );

  const barcodeResults =
    enhancedProductData && enhancedProductData.ean13Code
      ? generateVariations(enhancedProductData.ean13Code)
      : [];

  if (brandId && globalProductId) {
    if (
      enhancedProductData &&
      enhancedProductData.url &&
      enhancedProductData.enhancedData.price &&
      enhancedProductData.enhancedData.price !== 0
    ) {
      const ymd = formatAsYYYYMMDD(getStartOfTodayTimestamp());
      const globalProductRef = db
        .collection("globalProducts")
        .doc(globalProductId);
      const shouldContinue = await db.runTransaction(async (transaction) => {
        const vendorBrandRef = globalProductRef
          .collection("vendorBrands")
          .doc(brandId);
        const vendorPriceRef = globalProductRef
          .collection("vendorPrices")
          .doc(generateDocId(`${brandId}_${ymd}`));
        const checks = [
          transaction.get(globalProductRef),
          transaction.get(vendorBrandRef),
          transaction.get(vendorPriceRef),
        ];
        const [globalProductSnap, vendorBrandSnap, vendorPriceSnap] =
          await Promise.all(checks);
        const globalProductData = globalProductSnap.exists
          ? globalProductSnap.data()
          : {};
        if (!vendorBrandSnap.exists) {
          transaction.set(
            vendorBrandRef,
            {
              active: true,
              brandRef: db.collection("vendorBrands").doc(brandId),
              url: enhancedProductData.url,
              skuCode: enhancedProductData.skuCode
                ? enhancedProductData.skuCode
                : null,
              lastFetchDate: FieldValue.serverTimestamp(),
              lastPrice: enhancedProductData.enhancedData.price || 0,
            },
            { merge: true }
          );
        }
        if (!vendorPriceSnap.exists) {
          transaction.set(
            vendorPriceRef,
            {
              active: true,
              brandRef: db.collection("vendorBrands").doc(brandId),
              price: enhancedProductData.enhancedData.price || 0,
              fetchDate: FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
        }
        return globalProductData.temporary;
      });
      if (shouldContinue) {
        // Direct function call instead of HTTP
        continueGlobalProductProcessing(
          globalProductRef.id,
          enhancedProductData
        ).catch((err) => console.error("Global Product Processor Error:", err));
      }
    }
  }

  return { enhancedProductData, barcodeResults };
}
