import { extractLdJsonPrice } from "../methods.js";
import { getBarcodeTypes } from "../../shared/barcodeValidator.js";
import { ProductResponse } from "../../services/productEnhancer.js";
import { safePost } from "../../shared/httpClient.js";
import {
  safeGet as safeDataGet,
  parsePrice,
  safeArray,
} from "../../shared/dataValidator.js";
import { withErrorHandling } from "../../shared/errorHandler.js";

const SEARCH_ENDPOINT = "https://arrocha.com/search";

const digitsOnly = (val) =>
  typeof val === "string"
    ? val.replace(/\D/g, "")
    : String(val ?? "").replace(/\D/g, "");

export async function getProductData(website, barcode, productUrl) {
  const context = { brandId: "arrocha", barcode, method: "getProductData" };

  return withErrorHandling(async () => {
    if (productUrl) {
      return await extractLdJsonPrice(productUrl, context);
    }

    const response = new ProductResponse();

    const cleanBarcode = digitsOnly(barcode);

    const body = new URLSearchParams();
    body.append("q", cleanBarcode);
    body.append("type", "product");
    body.append("view", "globo.alsobought");

    const result = await safePost(
      SEARCH_ENDPOINT,
      body.toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
      context
    );

    if (!result.success) return null;

    const data = safeArray(result.data);
    if (data.length === 0) return null;

    const product = data.find(
      (p) =>
        Array.isArray(p.variants) &&
        p.variants.some((v) => digitsOnly(v.sku) === cleanBarcode)
    );
    if (!product) return null;

    const matchedVariant = product.variants.find(
      (v) => digitsOnly(v.sku) === cleanBarcode
    );

    const variantBarcode = digitsOnly(matchedVariant?.barcode);
    const variantBarcodeResults = getBarcodeTypes(variantBarcode);

    const url = `${website.replace(/\/+$/, "")}/products/${product.handle}`;

    const ean13Entry = variantBarcodeResults.find(
      (r) => r.barcodeType === "EAN_13"
    );

    response.url = url;
    response.ean13Code = ean13Entry?.barcode ?? null;
    response.enhancedData.name = matchedVariant.name ?? product.title;
    response.enhancedData.categories = product.type;
    response.enhancedData.brand = product.vendor;
    response.enhancedData.price =
      parsePrice(matchedVariant.price ?? product.price) / 100;

    return response;
  }, context);
}
