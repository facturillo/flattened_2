import { algolia, extractLdJsonPrice } from "../methods.js";
import { getBarcodeTypes } from "../../shared/barcodeValidator.js";
import { withErrorHandling } from "../../shared/errorHandler.js";
import { safeGet as safeDataGet } from "../../shared/dataValidator.js";

export async function getProductData(
  website,
  barcode,
  description,
  productUrl
) {
  const context = { brandId: "panafoto", barcode, method: "getProductData" };

  return withErrorHandling(async () => {
    if (productUrl) {
      return await extractLdJsonPrice(productUrl, context);
    }

    let searchQuery;
    if (barcode) {
      const parts = barcode.split("-");
      searchQuery = parts.length > 1 ? parts[1] : barcode;
    } else if (description) {
      const firstWord = description.trim().split(/\s+/)[0];
      const parts = firstWord.split("-");
      searchQuery = parts.length > 1 ? parts[1] : firstWord;
    } else {
      console.error(
        `[${context.brandId}/${barcode}] Need either barcode or description`
      );
      return null;
    }

    const algoliaResult = await algolia(
      website,
      searchQuery,
      null,
      null,
      null,
      context
    );
    if (algoliaResult === null) {
      return null;
    }

    const { response, enhancedData } = algoliaResult;

    const variantBarcodeResults = getBarcodeTypes(enhancedData.barcode);
    const ean13Entry = variantBarcodeResults.find(
      (r) => r.barcodeType === "EAN_13"
    );

    response.ean13Code = ean13Entry?.barcode ?? null;
    response.enhancedData.name = enhancedData.name;
    response.enhancedData.brand = enhancedData.manufacturer;
    response.enhancedData.categories = enhancedData.categories_without_path;
    response.enhancedData.price = safeDataGet(
      enhancedData,
      "price.USD.default",
      0
    );

    return response;
  }, context);
}
