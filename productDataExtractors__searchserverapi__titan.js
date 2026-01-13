import { searchserverapi, extractLdJsonPrice } from "../methods.js";
import { getBarcodeTypes } from "../../shared/barcodeValidator.js";
import {
  safeGet as safeDataGet,
  parsePrice,
} from "../../shared/dataValidator.js";
import { withErrorHandling } from "../../shared/errorHandler.js";

export async function getProductData(website, barcode, productUrl) {
  const context = { brandId: "titan", barcode, method: "getProductData" };

  return withErrorHandling(async () => {
    if (productUrl) {
      return await extractLdJsonPrice(productUrl, context);
    }

    const searchserverapiResult = await searchserverapi(
      website,
      barcode,
      "7w0A4y4e8D",
      context
    );
    if (searchserverapiResult === null) {
      return null;
    }

    const { enhancedData, originalBarcode, response } = searchserverapiResult;

    const variantBarcodeResults = getBarcodeTypes(
      safeDataGet(enhancedData, "selectedOffer.gtin13") ?? originalBarcode
    );
    const ean13Entry = variantBarcodeResults.find(
      (r) => r.barcodeType === "EAN_13"
    );

    response.ean13Code = ean13Entry?.barcode ?? null;
    response.enhancedData.name = enhancedData.name;
    response.enhancedData.description = enhancedData.description;
    response.enhancedData.brand = safeDataGet(enhancedData, "brand.name");
    response.enhancedData.categories = enhancedData.categories;
    response.enhancedData.price = parsePrice(
      safeDataGet(enhancedData, "selectedOffer.price") ?? enhancedData.price
    );

    return response;
  }, context);
}
