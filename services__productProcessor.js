// product-management/services/productProcessor.js

import crypto from "crypto";
import admin, { db, FieldValue, Timestamp } from "../shared/firebase.js";
import {
  systemInstruction,
  responseSchema,
} from "../systemInstructions/category.js";
import { vertexAIExtraction } from "../shared/vertexAI.js";
import { enhanceProduct, ProductResponse } from "./productEnhancer.js";
import {
  generateDocIdSync,
  formatAsYYYYMMDD,
  getStartOfTodayTimestamp,
} from "../shared/config.js";

/**
 * Safely extract string value from Firestore field
 */
function safeStringField(fields, fieldName, defaultValue = null) {
  const field = fields?.[fieldName];
  if (!field) return defaultValue;
  return field.stringValue ?? defaultValue;
}

/**
 * Safely extract boolean value from Firestore field
 */
function safeBooleanField(fields, fieldName, defaultValue = false) {
  const field = fields?.[fieldName];
  if (!field) return defaultValue;
  return field.booleanValue ?? defaultValue;
}

/**
 * Direct function call for product enhancement
 */
async function getEnhancedData(brandId, code, initialName) {
  try {
    const result = await enhanceProduct({
      brandId,
      code,
      initialName,
    });
    return result;
  } catch (err) {
    const status = err.response?.status;
    console.error(
      `Product enhancer error for ${brandId}/${code}:`,
      `Status: ${status || "N/A"}, Message: ${err.message}`
    );
    return null;
  }
}

/**
 * Process vendor product creation/update events
 */
export async function processProduct({ firestoreReceived }) {
  const requestId = `pp-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;

  try {
    const oldValue = firestoreReceived.oldValue;
    const newValue = firestoreReceived.value;

    // ═══════════════════════════════════════════════════════════════════════
    // HANDLE DELETION
    // ═══════════════════════════════════════════════════════════════════════

    if (!newValue || Object.keys(newValue).length === 0) {
      console.log(`[${requestId}] Deleted document, skipping`);
      return { status: 200, message: "Document deleted" };
    }

    // ═══════════════════════════════════════════════════════════════════════
    // PARSE DOCUMENT PATH
    // ═══════════════════════════════════════════════════════════════════════

    const fullDocPath = newValue.name;
    const parts = fullDocPath.split("/");
    const vendorId = parts[parts.indexOf("vendors") + 1];
    const productId = parts[parts.indexOf("products") + 1];

    if (!vendorId || !productId) {
      console.error(`[${requestId}] Invalid document path: ${fullDocPath}`);
      return { status: 400, message: "Invalid document path" };
    }

    const vendorDocRef = db.collection("vendors").doc(vendorId);
    const productDocRef = vendorDocRef.collection("products").doc(productId);

    const newFields = (newValue && newValue.fields) || {};

    // ═══════════════════════════════════════════════════════════════════════
    // HANDLE UPDATE (skip processing)
    // ═══════════════════════════════════════════════════════════════════════

    if (oldValue && Object.keys(oldValue).length > 0) {
      console.log(`[${requestId}] Update event, skipping processing`);
      return { status: 200, message: "Update event skipped" };
    }

    // ═══════════════════════════════════════════════════════════════════════
    // HANDLE CREATE
    // ═══════════════════════════════════════════════════════════════════════

    console.log(
      `[${requestId}] Create event for vendor/${vendorId}/products/${productId}`
    );

    // Safe field extraction with validation
    const category = safeStringField(newFields, "category");
    const code = safeStringField(newFields, "code");
    const initialName = safeStringField(newFields, "initialName");

    if (!code && !initialName) {
      console.error(
        `[${requestId}] Missing required fields: code or initialName`
      );
      return { status: 400, message: "Missing required fields" };
    }

    // ═══════════════════════════════════════════════════════════════════════
    // GET VENDOR DATA
    // ═══════════════════════════════════════════════════════════════════════

    const vendorDoc = await vendorDocRef.get();
    if (!vendorDoc.exists) {
      console.error(
        `[${requestId}] Vendor document does not exist: ${vendorId}`
      );
      return { status: 400, message: "Vendor not found" };
    }

    const vendorData = vendorDoc.data();
    const taxId = vendorData.taxId;

    if (!taxId) {
      console.error(`[${requestId}] Vendor missing taxId: ${vendorId}`);
      return { status: 400, message: "Vendor missing taxId" };
    }

    // ═══════════════════════════════════════════════════════════════════════
    // GET VENDOR-BRAND LINK
    // ═══════════════════════════════════════════════════════════════════════

    const vendorProductLinkRef = db
      .collection("vendorsProductLink")
      .doc(generateDocIdSync(taxId));
    const vendorProductLinkQuery = await vendorProductLinkRef.get();

    const defaultEnhancedProductData = {
      enhancedProductData: new ProductResponse(),
      barcodeResults: [],
    };

    const vendorProductLinkData = vendorProductLinkQuery.exists
      ? vendorProductLinkQuery.data()
      : {};

    let { enhancedProductData, barcodeResults } = defaultEnhancedProductData;

    // ═══════════════════════════════════════════════════════════════════════
    // ENHANCE PRODUCT DATA
    // ═══════════════════════════════════════════════════════════════════════

    if (vendorProductLinkQuery.exists && vendorProductLinkData.brandRef) {
      const enhancedResult = await getEnhancedData(
        vendorProductLinkData.brandRef.id,
        code,
        initialName
      );

      if (enhancedResult && enhancedResult.enhancedProductData) {
        ({ enhancedProductData, barcodeResults } = enhancedResult);
      }
    }

    const ean13Code = enhancedProductData?.ean13Code ?? null;

    // ═══════════════════════════════════════════════════════════════════════
    // PREPARE PRODUCT DATA
    // ═══════════════════════════════════════════════════════════════════════

    let productInputString = `Code: ${ean13Code ?? code}
      Description: ${initialName}
      Enhanced Product Data: ${JSON.stringify(
        enhancedProductData?.enhancedData || {}
      )}`;

    let globalName = initialName;
    let brandRef = null;
    let packSize = null;
    let productCategory = "other";
    let globalProductRef = null;
    let productBrandName = null;

    // ═══════════════════════════════════════════════════════════════════════════
    // GLOBAL PRODUCT HANDLING (if EAN-13 available AND vendor has brand link)
    // ═══════════════════════════════════════════════════════════════════════════

    if (ean13Code && vendorProductLinkData.brandRef) {
      const startTs = getStartOfTodayTimestamp(Timestamp);
      const ymd = formatAsYYYYMMDD(startTs);
      const brandRefId = vendorProductLinkData.brandRef.id;

      const globalProductDocId = generateDocIdSync(ean13Code);
      globalProductRef = db
        .collection("globalProducts")
        .doc(globalProductDocId);

      const globalProductBrandRef = globalProductRef
        .collection("vendorBrands")
        .doc(brandRefId);
      const globalProductPriceDocId = generateDocIdSync(`${brandRefId}_${ymd}`);
      const globalProductPriceRef = globalProductRef
        .collection("vendorPrices")
        .doc(globalProductPriceDocId);

      await db.runTransaction(async (transaction) => {
        const [globalProductDoc, globalProductBrandDoc, globalProductPriceDoc] =
          await Promise.all([
            transaction.get(globalProductRef),
            transaction.get(globalProductBrandRef),
            transaction.get(globalProductPriceRef),
          ]);

        if (!globalProductDoc.exists) {
          // Create new globalProduct
          transaction.set(
            globalProductRef,
            {
              eanCode: ean13Code,
              eanCodeVariations: barcodeResults,
              name: globalName,
              packSize: packSize,
              brandRef: null,
              brandName: null,
              category: productCategory,
              createDate: FieldValue.serverTimestamp(),
              processed: false,
              productInputString: productInputString,
              activeVendorBrands: 1,
              temporary: false,
              bestPrice: {
                brandRef: null,
                price: null,
                date: null,
              },
            },
            { merge: true }
          );
        } else {
          const existingData = globalProductDoc.data();

          if (existingData.temporary !== true) {
            // Not temporary, safe to keep non-temporary
            transaction.set(
              globalProductRef,
              { temporary: false },
              { merge: true }
            );
          }

          globalName = existingData.name ?? initialName;
          packSize = existingData.packSize;
          productCategory = existingData.category ?? "other";
          brandRef = existingData.brandRef;
          productBrandName = existingData.brandName;
        }

        if (!globalProductBrandDoc.exists) {
          transaction.set(
            globalProductBrandRef,
            {
              brandRef: vendorProductLinkData.brandRef,
              url: enhancedProductData?.url || null,
              skuCode: enhancedProductData?.skuCode || null,
              active: true,
              lastFetchDate: FieldValue.serverTimestamp(),
              lastPrice: enhancedProductData?.enhancedData?.price ?? 0,
            },
            { merge: true }
          );

          if (globalProductDoc.exists) {
            transaction.update(globalProductRef, {
              activeVendorBrands: FieldValue.increment(1),
            });
          }
        }

        if (!globalProductPriceDoc.exists) {
          transaction.set(
            globalProductPriceRef,
            {
              brandRef: vendorProductLinkData.brandRef,
              fetchDate: FieldValue.serverTimestamp(),
              price: enhancedProductData?.enhancedData?.price ?? 0,
              active: true,
            },
            { merge: true }
          );
        }
      });
    } else if (ean13Code) {
      // Has EAN but no vendor brand link - still create/reference globalProduct
      const globalProductDocId = generateDocIdSync(ean13Code);
      globalProductRef = db
        .collection("globalProducts")
        .doc(globalProductDocId);

      const globalProductDoc = await globalProductRef.get();
      if (globalProductDoc.exists) {
        const existingData = globalProductDoc.data();
        globalName = existingData.name ?? initialName;
        packSize = existingData.packSize;
        productCategory = existingData.category ?? "other";
        brandRef = existingData.brandRef;
        productBrandName = existingData.brandName;
      }
      // Don't create vendorBrand/vendorPrice without a brandRef
    } else {
      // ═══════════════════════════════════════════════════════════════════════
      // NO EAN-13: USE VERTEX AI FOR CATEGORIZATION
      // ═══════════════════════════════════════════════════════════════════════

      console.log(`[${requestId}] No EAN-13, running Vertex AI categorization`);

      try {
        const aiResult = await vertexAIExtraction(
          productInputString,
          systemInstruction,
          responseSchema,
          "productCategory"
        );

        if (aiResult) {
          globalName = aiResult.globalName ?? initialName;
          packSize = aiResult.packSize;
          productCategory = aiResult.category ?? "other";
        }
      } catch (err) {
        console.error(`[${requestId}] Vertex AI error:`, err.message);
        // Continue with defaults
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // UPDATE VENDOR PRODUCT
    // ═══════════════════════════════════════════════════════════════════════

    await productDocRef.set(
      {
        category: productCategory ?? category ?? "other",
        description: globalName ?? initialName,
        productBrandRef: brandRef,
        productBrandName: productBrandName,
        globalProductRef: globalProductRef,
        packSize: packSize === "null" ? null : packSize,
        extractedProductData: {
          enhancedData: enhancedProductData?.enhancedData || {},
          url: enhancedProductData?.url || null,
        },
        processed: true,
        processedAt: FieldValue.serverTimestamp(),
        _processedBy: requestId,
      },
      { merge: true }
    );

    console.log(`[${requestId}] Processing completed successfully`);
    return { status: 200, message: "Processing succeeded" };
  } catch (error) {
    console.error(`[${requestId}] Error during processing:`, error);
    return {
      status: 500,
      message: "Internal Server Error",
      error: error.message,
    };
  }
}
