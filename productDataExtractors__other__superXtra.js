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

const SEARCH_ENDPOINT =
  "https://www.superxtra.com/api/catalog_system/pub/products/search";

export async function getProductData(barcode, productUrl) {
  const context = { brandId: "superxtra", barcode, method: "getProductData" };

  return withErrorHandling(async () => {
    if (productUrl) {
      return await extractLdJsonPrice(productUrl, context);
    }

    const response = new ProductResponse();

    const requestUrl = `${SEARCH_ENDPOINT}?map=ft&ft=${encodeURIComponent(
      barcode
    )}`;

    const result = await safeGet(
      requestUrl,
      { headers: { Accept: "application/json" } },
      context
    );

    if (!result.success) return null;

    const data = safeArray(result.data);
    if (data.length === 0) {
      return null;
    }

    const product = data.find(
      (p) =>
        Array.isArray(p.items) && p.items.some((item) => item.ean === barcode)
    );

    if (!product) {
      return null;
    }

    const items = safeArray(product.items);
    product.selectedVariant =
      items.length === 1
        ? items[0]
        : items.find((v) => v.ean === barcode) || {};

    const variantBarcodeResults = getBarcodeTypes(product.selectedVariant.ean);
    const ean13Entry = variantBarcodeResults.find(
      (r) => r.barcodeType === "EAN_13"
    );

    const sellers = safeArray(product.selectedVariant.sellers);
    const defaultSeller = sellers.find((s) => s.sellerDefault) ?? sellers[0];
    const rawPrice = safeDataGet(defaultSeller, "commertialOffer.Price", 0);

    response.url = product.link;
    response.ean13Code = ean13Entry?.barcode ?? null;
    response.enhancedData.name = safeTrim(product.selectedVariant.name);
    response.enhancedData.description = safeTrim(
      product.selectedVariant.nameComplete
    );
    response.enhancedData.brand = safeTrim(product.brand);
    response.enhancedData.categories = safeArray(product.categories);
    response.enhancedData.packSize = safeTrim(
      product.selectedVariant.measurementUnit
    );
    response.enhancedData.price = parsePrice(rawPrice);

    return response;
  }, context);
}
