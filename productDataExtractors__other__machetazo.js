import { ProductResponse } from "../../services/productEnhancer.js";
import { getBarcodeTypes } from "../../shared/barcodeValidator.js";
import { safeGet } from "../../shared/httpClient.js";
import {
  safeGet as safeDataGet,
  safeArray,
} from "../../shared/dataValidator.js";
import { withErrorHandling } from "../../shared/errorHandler.js";

function extractStateJson(html) {
  const marker = "__STATE__";
  const idx = html.indexOf(marker);
  if (idx === -1) return null;

  let start = html.indexOf("{", idx);
  if (start === -1) return null;

  let depth = 0;
  let end = start;
  for (; end < html.length; end++) {
    const ch = html[end];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return html.slice(start, end + 1);
      }
    }
  }
  return null;
}

export async function getProductData(barcode, productUrl) {
  const context = { brandId: "elmachetazo", barcode, method: "getProductData" };

  return withErrorHandling(async () => {
    const response = new ProductResponse();

    if (productUrl) {
      const result = await safeGet(productUrl, {}, context);
      if (!result.success) return null;

      const stateJson = extractStateJson(result.data);
      if (!stateJson) {
        console.error(
          `[${context.brandId}/${barcode}] Couldn't extract __STATE__ JSON`
        );
        return null;
      }

      let state;
      try {
        state = JSON.parse(stateJson);
      } catch (err) {
        console.error(
          `[${context.brandId}/${barcode}] Failed to parse state JSON:`,
          err.message
        );
        return null;
      }

      const productObj = Object.values(state).find(
        (val) => val && val.items && Array.isArray(val.items)
      );
      if (!productObj) return null;

      const skuRef = safeDataGet(productObj, "items.0.id");
      const skuData = state[skuRef];
      if (!skuData) return null;

      const sellerRef = safeArray(skuData.sellers).find((s) => s.id);
      const sellerData = state[sellerRef?.id];
      const offerRef = safeDataGet(sellerData, "commertialOffer.id");
      const offerData = state[offerRef];
      const price = safeDataGet(offerData, "Price", 0);

      response.url = productUrl;
      response.enhancedData.price = price;
      return response;
    }

    const searchUrl = `https://www.elmachetazo.com/${barcode}?_q=${barcode}&map=ft`;

    const searchResult = await safeGet(searchUrl, {}, context);
    if (!searchResult.success) return null;

    const searchStateJson = extractStateJson(searchResult.data);
    if (!searchStateJson) {
      console.error(
        `[${context.brandId}/${barcode}] Couldn't extract search __STATE__ JSON`
      );
      return null;
    }

    let searchState;
    try {
      searchState = JSON.parse(searchStateJson);
    } catch (err) {
      console.error(
        `[${context.brandId}/${barcode}] Failed to parse search state:`,
        err.message
      );
      return null;
    }

    const productKeys = Object.keys(searchState).filter((k) =>
      k.startsWith("Product:")
    );
    let found = null;

    for (const pk of productKeys) {
      const prod = searchState[pk];
      if (!prod) continue;

      const itemsKey = Object.keys(prod).find(
        (k) => k.startsWith("items(") && k.includes("FIRST_AVAILABLE")
      );
      if (!itemsKey) continue;

      const itemsArr = prod[itemsKey];
      const skuRef = safeDataGet(itemsArr, "0.id");
      const skuObj = searchState[skuRef];
      if (skuObj?.ean === barcode) {
        found = { prod, skuObj };
        break;
      }
    }

    if (!found) return null;
    const { prod, skuObj } = found;

    const link = prod.link;
    const url = `https://www.elmachetazo.com${link}`;
    const brand = prod.brand;

    const productResult = await safeGet(url, {}, context);
    if (!productResult.success) return null;

    const stateJson = extractStateJson(productResult.data);
    if (!stateJson) {
      console.error(
        `[${context.brandId}/${barcode}] Couldn't extract product __STATE__ JSON`
      );
      return null;
    }

    let state;
    try {
      state = JSON.parse(stateJson);
    } catch (err) {
      console.error(
        `[${context.brandId}/${barcode}] Failed to parse product state:`,
        err.message
      );
      return null;
    }

    const productObj = Object.values(state).find(
      (val) => val && val.items && Array.isArray(val.items)
    );
    if (!productObj) return null;

    const skuRef = safeDataGet(productObj, "items.0.id");
    const skuData = state[skuRef];
    if (!skuData) return null;

    const variantBarcodeResults = getBarcodeTypes(skuData.ean);
    const ean13Entry = variantBarcodeResults.find(
      (r) => r.barcodeType === "EAN_13"
    );

    const sellerRef = safeArray(skuData.sellers).find((s) => s.id);
    const sellerData = state[sellerRef?.id];
    const offerRef = safeDataGet(sellerData, "commertialOffer.id");
    const offerData = state[offerRef];
    const price = safeDataGet(offerData, "Price", 0);

    const rawCategories = safeDataGet(productObj, "categories.json", []);
    const categories = rawCategories.map((path) =>
      path
        .replace(/^\/|\/$/g, "")
        .split("/")
        .join(" > ")
    );
    const packSize = skuData.measurementUnit;

    response.url = url;
    response.ean13Code = ean13Entry?.barcode ?? null;
    response.enhancedData.name = skuData.name;
    response.enhancedData.brand = brand;
    response.enhancedData.price = price;
    response.enhancedData.categories = categories;
    response.enhancedData.packSize = packSize;

    return response;
  }, context);
}
