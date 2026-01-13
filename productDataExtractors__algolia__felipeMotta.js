import { algolia } from "../methods.js";
import { withErrorHandling } from "../../shared/errorHandler.js";
import { safeGet as safeDataGet } from "../../shared/dataValidator.js";

export async function getProductData(website, barcode, productUrl) {
  const context = { brandId: "felipemotta", barcode, method: "getProductData" };

  return withErrorHandling(async () => {
    const algoliaResult = await algolia(
      website,
      barcode,
      null,
      null,
      null,
      context
    );
    if (algoliaResult === null) {
      return null;
    }

    const { response, enhancedData } = algoliaResult;

    response.skuCode = barcode;
    response.enhancedData.name = enhancedData.name;
    response.enhancedData.categories = enhancedData.categories_without_path;
    response.enhancedData.price = safeDataGet(
      enhancedData,
      "price.USD.default",
      0
    );

    return response;
  }, context);
}
