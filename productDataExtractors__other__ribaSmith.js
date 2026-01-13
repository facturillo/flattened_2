import * as cheerio from "cheerio";
import { extractLdJsonPrice } from "../methods.js";
import { getBarcodeTypes } from "../../shared/barcodeValidator.js";
import { ProductResponse } from "../../services/productEnhancer.js";
import { safeGet } from "../../shared/httpClient.js";
import {
  safeGet as safeDataGet,
  parsePrice,
  safeTrim,
  safeArray,
} from "../../shared/dataValidator.js";
import { withErrorHandling } from "../../shared/errorHandler.js";

export async function getProductData(barcode, productUrl) {
  const context = { brandId: "ribasmith", barcode, method: "getProductData" };

  return withErrorHandling(async () => {
    if (productUrl) {
      return await extractLdJsonPrice(productUrl, context);
    }

    const response = new ProductResponse();

    let searchCode,
      eanAvailable = false;
    if (barcode.length >= 8) {
      searchCode = barcode.slice(0, -1);
      searchCode = searchCode.replace(/^0+/, "");
      eanAvailable = true;
    } else {
      searchCode = barcode.padEnd(11, "0");
    }

    const searchUrl = "https://api.fastsimon.com/full_text_search";
    const params = {
      src: "v1",
      UUID: "19f6f39a-57d5-470f-8795-84369d66b79e",
      q: searchCode,
    };

    const searchResult = await safeGet(searchUrl, { params }, context);
    if (!searchResult.success) {
      return null;
    }

    const items = safeArray(safeDataGet(searchResult.data, "items"));
    const match = items.find((item) => item.sku === searchCode);
    if (!match) return null;

    const url = match.u;

    const pageResult = await safeGet(url, {}, context);
    if (!pageResult.success) return null;

    const $ = cheerio.load(pageResult.data);

    let dlObjectsJson = null;
    $("script").each((_, el) => {
      const scriptContent = $(el).html();
      if (!scriptContent) return;
      const match = scriptContent.match(
        /var\s+dlObjects\s*=\s*(\[\s*\{[\s\S]*?\}\s*\]);/
      );
      if (match && match[1]) {
        dlObjectsJson = match[1];
        return false;
      }
    });

    if (!dlObjectsJson) {
      console.warn(`[${context.brandId}/${barcode}] No dlObjects block found`);
      return null;
    }

    let dlObjects;
    try {
      dlObjects = JSON.parse(dlObjectsJson);
    } catch (err) {
      console.error(
        `[${context.brandId}/${barcode}] Failed to parse dlObjects:`,
        err.message
      );
      return null;
    }

    const ecommerceEntry = dlObjects.find((obj) =>
      safeDataGet(obj, "ecommerce.detail.products")
    );
    if (!ecommerceEntry) {
      console.warn(
        `[${context.brandId}/${barcode}] No ecommerce.detail.products found`
      );
      return null;
    }

    const products = safeArray(
      safeDataGet(ecommerceEntry, "ecommerce.detail.products")
    );
    if (products.length === 0) {
      console.warn(`[${context.brandId}/${barcode}] Products array empty`);
      return null;
    }

    const productEntry = products[0];

    const variantBarcodeResults = getBarcodeTypes(
      eanAvailable ? barcode : null
    );
    const ean13Entry = variantBarcodeResults.find(
      (r) => r.barcodeType === "EAN_13"
    );

    response.url = url;
    response.ean13Code = ean13Entry?.barcode ?? null;
    response.enhancedData.name = safeTrim(productEntry.name);
    response.enhancedData.brand = safeTrim(productEntry.brand);
    response.enhancedData.categories = (productEntry.category || "")
      .split("/")
      .filter(Boolean);
    response.enhancedData.price = parsePrice(productEntry.price);

    return response;
  }, context);
}
