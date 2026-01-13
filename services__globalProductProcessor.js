// product-management/services/globalProductProcessor.js

import crypto from "crypto";
import { PubSub } from "@google-cloud/pubsub";
import admin, { db, FieldValue } from "../shared/firebase.js";
import {
  systemInstruction as categoryInstruction,
  responseSchema as categoryResponseSchema,
} from "../systemInstructions/category.js";
import { systemInstruction as brandInstruction } from "../systemInstructions/brand.js";
import { vertexAIExtraction } from "../shared/vertexAI.js";
import { enhanceProduct } from "./productEnhancer.js";

const ALL_BRANDS = [
  "super99",
  "elmachetazo",
  "ribasmith",
  "superxtra",
  "supermercadorey",
  "superbaru",
  "supercarnes",
];

const pubsub = new PubSub();
const DELAY_SECONDS = 60;

function generateDocId(input) {
  return crypto.createHash("sha256").update(input).digest("base64url");
}

// Direct function call instead of HTTP
async function getEnhancedData(brandId, code, initialName, globalProductId) {
  try {
    const result = await enhanceProduct({
      brandId,
      code,
      initialName,
      globalProductId,
    });
    return result;
  } catch (err) {
    console.error("Enhancer error:", err);
    return null;
  }
}

export async function processGlobalProduct({
  firestoreReceived,
  globalProductId,
  enhancedDataInput,
  processAfter, // NEW: timestamp for delayed processing
}) {
  try {
    let shouldComplete = false;
    let globalProductRef,
      productInputString = null;

    // Check if this is a delayed message that's not ready yet
    if (processAfter && Date.now() < processAfter) {
      const waitMs = processAfter - Date.now();

      // Just wait inline - VM can handle many concurrent sleeps
      console.log(`Waiting ${Math.round(waitMs / 1000)}s before processing...`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    if (firestoreReceived) {
      const newValue = firestoreReceived.value;
      const fullDocPath = newValue.name;
      const globalProductDocPath = fullDocPath.split("/documents/")[1];
      globalProductRef = db.doc(globalProductDocPath);
      const newFields = (newValue && newValue.fields) || {};
      const temporary = newFields.temporary?.booleanValue ?? false;
      const initialName = newFields.globalName?.stringValue ?? null;
      productInputString = newFields.productInputString?.stringValue ?? null;
      const eanVariants = (
        newFields.eanCodeVariations?.arrayValue?.values || []
      ).map((v) => {
        const f = v.mapValue.fields;
        return f.barcode.stringValue;
      });

      // Fire off enhancement requests for all brands/codes (fire and forget)
      for (const brand of ALL_BRANDS) {
        for (const code of eanVariants) {
          getEnhancedData(brand, code, initialName, globalProductRef.id).catch(
            (err) => console.error("Enhancer error:", err)
          );
        }
      }

      if (temporary) {
        console.log(
          "temporary flow - scheduling delayed reprocessing via Pub/Sub"
        );

        // Schedule delayed processing (60 seconds from now)
        const payload = {
          globalProductId: globalProductRef.id,
          processAfter: Date.now() + DELAY_SECONDS * 1000,
        };
        const dataBuffer = Buffer.from(JSON.stringify(payload));

        const messageId = await pubsub
          .topic("global-product-processor")
          .publishMessage({ data: dataBuffer });

        console.log(
          `Published delayed message ${messageId} (processAfter: ${DELAY_SECONDS}s)`
        );

        return {
          status: 200,
          message: "Temporary Global Product listener scheduled via Pub/Sub",
        };
      } else {
        shouldComplete = true;
      }
    } else if (globalProductId) {
      globalProductRef = db.collection("globalProducts").doc(globalProductId);
      if (enhancedDataInput) {
        const eanCode = enhancedDataInput.ean13Code;
        productInputString = `Code: ${eanCode}
        Description: ${
          enhancedDataInput.enhancedData?.description ??
          enhancedDataInput.enhancedData?.name
        }
        Enhanced Product Data: ${JSON.stringify(
          enhancedDataInput.enhancedData
        )}`;
        shouldComplete = true;
      } else {
        await db.runTransaction(async (transaction) => {
          const globalProductDoc = await transaction.get(globalProductRef);
          if (globalProductDoc.exists) {
            const globalProductData = globalProductDoc.data();
            if (globalProductData.temporary) {
              const historyQuery = db
                .collectionGroup("productSearchHistory")
                .where("globalProductRef", "==", globalProductRef);
              const historySnap = await transaction.get(historyQuery);
              historySnap.docs.forEach((historyDoc) =>
                transaction.delete(historyDoc.ref)
              );
              transaction.delete(globalProductRef);
            }
          }
          return;
        });
        return { status: 200, message: "Temporary Global Product updated" };
      }
    } else {
      return { status: 500, message: "Incorrect Inputs" };
    }

    if (shouldComplete && productInputString) {
      const categoryPromise = vertexAIExtraction(
        productInputString,
        categoryInstruction,
        categoryResponseSchema,
        "globalProductCategory"
      );
      const brandPromise = vertexAIExtraction(
        productInputString,
        brandInstruction,
        null,
        "globalProductBrand"
      );

      const [
        { globalName, packSize, category: productCategory },
        { brandName, brandUrl },
      ] = await Promise.all([categoryPromise, brandPromise]);

      await db.runTransaction(async (transaction) => {
        const globalProductSnap = await transaction.get(globalProductRef);
        if (globalProductSnap.exists) {
          let brandRef = null;
          if (brandUrl && brandName) {
            const brandId = generateDocId(brandUrl);
            brandRef = db.collection("productBrands").doc(brandId);
            const brandDoc = await transaction.get(brandRef);
            if (!brandDoc.exists) {
              transaction.set(
                brandRef,
                {
                  name: brandName,
                  url: brandUrl,
                  createDate: FieldValue.serverTimestamp(),
                },
                { merge: true }
              );
            }
          }
          transaction.set(
            globalProductRef,
            {
              processed: true,
              processedAt: FieldValue.serverTimestamp(),
              name: globalName,
              brandRef: brandRef,
              brandName: brandRef ? brandName : null,
              packSize: packSize === "null" ? null : packSize,
              category: productCategory,
              productInputString: FieldValue.delete(),
              temporary: false,
            },
            { merge: true }
          );
        }
      });
    }

    console.log("Processing completed successfully.");
    return { status: 200, message: "Processing succeeded" };
  } catch (error) {
    console.error("Error during processing:", error);
    return { status: 500, message: "Internal Server Error" };
  }
}
