import * as cheerio from "cheerio";
import { ProductResponse } from "../../services/productEnhancer.js";
import { graphQl } from "../methods.js";
import { safeGet } from "../../shared/httpClient.js";
import {
  safeGet as safeDataGet,
  parsePrice,
  safeArray,
} from "../../shared/dataValidator.js";
import { withErrorHandling } from "../../shared/errorHandler.js";

export async function getProductData(website, barcode, productUrl) {
  const context = { brandId: "conway", barcode, method: "getProductData" };

  return withErrorHandling(async () => {
    if (productUrl) {
      const response = new ProductResponse();
      const result = await safeGet(productUrl, {}, context);
      if (!result.success) return null;

      const $ = cheerio.load(result.data);

      let productJson = null;
      $("script").each((_, el) => {
        const js = $(el).html();
        const m = js.match(
          /magentoStorefrontEvents\.context\.setProduct\(\s*(\{[\s\S]*?\})\s*\)/
        );
        if (m) {
          try {
            productJson = JSON.parse(m[1]);
            return false;
          } catch (parseErr) {
            console.warn(
              `[${context.brandId}/${barcode}] Failed to parse product JSON:`,
              parseErr.message
            );
          }
        }
      });

      if (!productJson) return null;

      const priceObj = safeDataGet(productJson, "pricing", {});
      const rawPrice =
        priceObj.specialPrice ??
        priceObj.regularPrice ??
        priceObj.minimalPrice ??
        0;

      response.url = productUrl;
      response.enhancedData.price = parsePrice(rawPrice);
      return response;
    }

    const data = await graphQl(
      {
        endpoint: `${website}graphql`,
        query: `
        query AllProductDataForSKU {
          products(search: "${barcode}") {
            items {
              categories { ... on CategoryInterface { uid name } }
              description { ... on ComplexTextValue { html } }
              url_key
              url_suffix
              name
              price_range {
                minimum_price { final_price { value currency } }
                maximum_price { final_price { value currency } }
              }
              sku
              small_image { ... on ProductImage { url } }
              uid
            }
          }
        }
      `,
        variables: {},
      },
      context
    );

    const items = safeArray(safeDataGet(data, "data.products.items"));
    if (items.length === 0) {
      return null;
    }

    const tasks = items.map((item) =>
      (async () => {
        const url =
          website.replace(/\/+$/, "") + "/" + item.url_key + item.url_suffix;

        const result = await safeGet(url, {}, context);
        if (!result.success) return null;

        const $ = cheerio.load(result.data);

        const hid = $("#cod_bar_hid").attr("value");
        if (hid !== barcode) {
          return null;
        }

        // FIX: Create a new ProductResponse for each task to avoid race condition
        const itemResponse = new ProductResponse();
        itemResponse.url = url;
        itemResponse.enhancedData.name = (item.name || "").trim();
        itemResponse.enhancedData.description = safeDataGet(
          item,
          "description.html",
          ""
        );
        itemResponse.enhancedData.categories = safeArray(item.categories).map(
          (c) => c.name
        );
        itemResponse.enhancedData.price =
          safeDataGet(item, "price_range.maximum_price.final_price.value") ??
          safeDataGet(item, "price_range.minimum_price.final_price.value") ??
          0.0;
        return itemResponse;
      })()
    );

    const results = await Promise.all(tasks);
    return results.find((r) => r) || null;
  }, context);
}
