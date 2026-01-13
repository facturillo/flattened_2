import crypto from "crypto";
import admin, { db, FieldValue, Timestamp } from "../shared/firebase.js";
import {
  systemInstruction,
  responseSchema,
} from "../systemInstructions/productInstructions.js";
import { vertexAIExtraction } from "../shared/vertexAI.js";
import { enhanceProduct, ProductResponse } from "./productEnhancer.js";

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

// Direct function call instead of HTTP
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

    if (status >= 500) {
      console.error("Full error details:", err.response?.data);
    }

    return null;
  }
}

export async function processProduct({ firestoreReceived }) {
  try {
    const oldValue = firestoreReceived.oldValue;
    const newValue = firestoreReceived.value;

    if (!newValue || Object.keys(newValue).length === 0) {
      console.log("Deleted Document, do nothing and return");
      return { status: 200, message: "Document deleted" };
    }

    const fullDocPath = newValue.name;
    const parts = fullDocPath.split("/");
    const vendorId = parts[parts.indexOf("vendors") + 1];
    const productId = parts[parts.indexOf("products") + 1];
    const vendorDocRef = db.collection("vendors").doc(vendorId);
    const productDocRef = vendorDocRef.collection("products").doc(productId);

    const newFields = (newValue && newValue.fields) || {};
    if (!oldValue || Object.keys(oldValue).length === 0) {
      console.log("Create Event, start processing.");

      const category = newFields.category.stringValue ?? null;
      const code = newFields.code?.stringValue ?? null;
      const initialName = newFields.initialName.stringValue ?? null;

      const vendorDoc = await vendorDocRef.get();
      if (!vendorDoc.exists) {
        console.error("Vendor document does not exist.");
        return { status: 400, message: "Vendor not found" };
      }

      const vendorData = vendorDoc.data();
      const taxId = vendorData.taxId;

      const vendorProductLinkRef = db
        .collection("vendorsProductLink")
        .doc(generateDocId(taxId));
      const vendorProductLinkQuery = await vendorProductLinkRef.get();
      const defaultEnhancedProductData = {
        enhancedProductData: new ProductResponse(),
        barcodeResults: [],
      };
      const vendorProductLinkData = vendorProductLinkQuery.exists
        ? vendorProductLinkQuery.data()
        : {};

      let { enhancedProductData, barcodeResults } = defaultEnhancedProductData;

      if (vendorProductLinkQuery.exists) {
        const enhancedResult = await getEnhancedData(
          vendorProductLinkData.brandRef.id,
          code,
          initialName
        );

        if (enhancedResult) {
          ({ enhancedProductData, barcodeResults } = enhancedResult);
        }

        if (!enhancedProductData) {
          ({ enhancedProductData, barcodeResults } =
            defaultEnhancedProductData);
        }
      }

      const ean13Code = enhancedProductData.ean13Code ?? null;

      let productInputString = `Code: ${ean13Code ?? code}
        Description: ${initialName}
        Enhanced Product Data: ${JSON.stringify(
          enhancedProductData.enhancedData
        )}`;
      let globalName = initialName,
        brandRef = null,
        packSize = null,
        productCategory = "other",
        globalProductRef = null,
        productBrandName = null;

      if (ean13Code) {
        const startTs = getStartOfTodayTimestamp();
        const ymd = formatAsYYYYMMDD(startTs);

        const globalProductDocId = generateDocId(ean13Code);
        globalProductRef = db
          .collection("globalProducts")
          .doc(globalProductDocId);
        const globalProductBrandRef = globalProductRef
          .collection("vendorBrands")
          .doc(vendorProductLinkData.brandRef.id);
        const globalProductPriceDocId = generateDocId(
          `${vendorProductLinkData.brandRef.id}_${ymd}`
        );
        const globalProductPriceRef = globalProductRef
          .collection("vendorPrices")
          .doc(globalProductPriceDocId);

        await db.runTransaction(async (transaction) => {
          const globalProductDoc = await transaction.get(globalProductRef);
          const globalProductBrandDoc = await transaction.get(
            globalProductBrandRef
          );
          const globalProductPriceDoc = await transaction.get(
            globalProductPriceRef
          );

          if (!globalProductDoc.exists) {
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
                activeVendorBrands: 0,
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
            transaction.set(
              globalProductRef,
              {
                temporary: false,
              },
              { merge: true }
            );
            const globalProductData = globalProductDoc.data();
            globalName = globalProductData.name ?? initialName;
            packSize = globalProductData.packSize;
            productCategory = globalProductData.category ?? "other";
            brandRef = globalProductData.brandRef;
            productBrandName = globalProductData.brandName;
          }

          if (!globalProductBrandDoc.exists) {
            transaction.set(
              globalProductBrandRef,
              {
                brandRef: vendorProductLinkData.brandRef,
                url: enhancedProductData.url,
                skuCode: enhancedProductData.skuCode
                  ? enhancedProductData.skuCode
                  : null,
                active: true,
                lastFetchDate: FieldValue.serverTimestamp(),
                lastPrice: enhancedProductData.enhancedData.price ?? 0,
              },
              { merge: true }
            );
          }

          if (!globalProductPriceDoc.exists) {
            transaction.set(
              globalProductPriceRef,
              {
                brandRef: vendorProductLinkData.brandRef,
                fetchDate: FieldValue.serverTimestamp(),
                price: enhancedProductData.enhancedData.price ?? 0,
                active: true,
              },
              { merge: true }
            );
          }
        });
      } else {
        const {
          globalName: globalNameOutput,
          packSize: packSizeOutput,
          category: categoryOutput,
        } = await vertexAIExtraction(
          productInputString,
          systemInstruction,
          responseSchema,
          "productCategory"
        );
        globalName = globalNameOutput ?? initialName;
        packSize = packSizeOutput;
        productCategory = categoryOutput ?? "other";
      }

      await productDocRef.set(
        {
          category: productCategory ?? category,
          description: globalName ?? initialName,
          productBrandRef: brandRef,
          productBrandName: productBrandName,
          globalProductRef: globalProductRef,
          packSize: packSize === "null" ? null : packSize,
          extractedProductData: {
            enhancedData: enhancedProductData.enhancedData,
            url: enhancedProductData.url,
          },
          processed: true,
          processedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    } else {
      console.log("Update Event, skip processing.");
    }

    console.log("Processing completed successfully.");
    return { status: 200, message: "Processing succeeded" };
  } catch (error) {
    console.error("Error during processing:", error);
    return { status: 500, message: "Internal Server Error" };
  }
}
