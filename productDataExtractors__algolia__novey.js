import * as cheerio from "cheerio";
import { algolia } from "../methods.js";
import { ProductResponse } from "../../services/productEnhancer.js";
import { safeGet } from "../../shared/httpClient.js";
import {
  safeGet as safeDataGet,
  parsePrice,
} from "../../shared/dataValidator.js";
import { withErrorHandling } from "../../shared/errorHandler.js";

export async function getProductData(website, barcode, productUrl) {
  const context = { brandId: "novey", barcode, method: "getProductData" };

  return withErrorHandling(async () => {
    if (productUrl) {
      const earlyResponse = new ProductResponse();
      const result = await safeGet(productUrl, {}, context);

      if (!result.success) return null;

      const $ = cheerio.load(result.data);
      earlyResponse.url = productUrl;

      const scriptWithDl4 = $("script")
        .map((i, el) => $(el).html())
        .get()
        .find((s) => s && s.includes("var dl4Objects"));

      if (scriptWithDl4) {
        const match = scriptWithDl4.match(
          /var dl4Objects\s*=\s*(\[\{[\s\S]*?\}\]);/
        );
        if (match) {
          try {
            const dl4Objects = JSON.parse(match[1]);
            const firstEcom = safeDataGet(dl4Objects, "0.ecommerce");
            const firstItem = safeDataGet(firstEcom, "items.0");

            const rawPrice =
              firstItem?.price != null ? firstItem.price : firstEcom?.value;

            earlyResponse.enhancedData.price = parsePrice(rawPrice);

            if (firstItem) {
              earlyResponse.enhancedData.name = firstItem.item_name;
              earlyResponse.enhancedData.categories = firstItem.item_category
                ? [firstItem.item_category]
                : [];
            }
          } catch (parseErr) {
            console.warn(
              `[${context.brandId}/${barcode}] Failed to parse dl4Objects:`,
              parseErr.message
            );
            earlyResponse.enhancedData.price = 0;
          }
        }
      } else {
        earlyResponse.enhancedData.price = 0;
      }

      return earlyResponse;
    }

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

    response.enhancedData.name = enhancedData.name;
    response.enhancedData.brand = enhancedData.band_name;
    response.enhancedData.categories = enhancedData.categories_without_path;
    response.enhancedData.price = safeDataGet(
      enhancedData,
      "price.USD.default",
      0
    );

    return response;
  }, context);
}
