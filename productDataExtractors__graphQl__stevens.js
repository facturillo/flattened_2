import * as cheerio from "cheerio";
import { extractLdJsonPrice } from "../methods.js";
import { getBarcodeTypes } from "../../shared/barcodeValidator.js";
import { ProductResponse } from "../../services/productEnhancer.js";
import { graphQl } from "../methods.js";
import { safeGet } from "../../shared/httpClient.js";
import {
  safeGet as safeDataGet,
  safeArray,
} from "../../shared/dataValidator.js";
import { withErrorHandling } from "../../shared/errorHandler.js";

export async function getProductData(website, barcode, productUrl) {
  const context = { brandId: "stevens", barcode, method: "getProductData" };

  return withErrorHandling(async () => {
    if (productUrl) {
      return await extractLdJsonPrice(productUrl, context);
    }

    const response = new ProductResponse();

    const data = await graphQl(
      {
        endpoint: `${website}graphql`,
        query: `
        query AllProductDataForSKU {
          products(search: "${barcode}") {
            items {
              url_key
              url_suffix
              categories { ... on CategoryInterface { uid name } }
              description { ... on ComplexTextValue { html } }
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

    const products = safeArray(safeDataGet(data, "data.products.items"));
    if (products.length === 0) return null;

    const product = products.find((p) => p.sku === barcode);
    if (!product) return null;

    const url =
      website.replace(/\/+$/, "") + "/" + product.url_key + product.url_suffix;

    const result = await safeGet(url, {}, context);
    if (!result.success) return null;

    const $ = cheerio.load(result.data);

    const detailsText = $("#product-details").text() || "";
    const codeMatch = detailsText.match(/C[oó]digo de Barra:\s*(\d+)/i);
    const rawCode = codeMatch ? codeMatch[1] : null;

    const variantBarcodeResults = getBarcodeTypes(rawCode);
    const ean13Entry = variantBarcodeResults.find(
      (r) => r.barcodeType === "EAN_13"
    );

    response.url = url;
    response.ean13Code = ean13Entry?.barcode ?? null;
    response.enhancedData.name = product.name.trim();
    response.enhancedData.description = safeDataGet(
      product,
      "description.html",
      ""
    );
    response.enhancedData.categories = safeArray(product.categories).map(
      (c) => c.name
    );

    const maxP = safeDataGet(product, "price_range.maximum_price.final_price");
    const minP = safeDataGet(product, "price_range.minimum_price.final_price");
    response.enhancedData.price = maxP?.value ?? minP?.value ?? 0;

    return response;
  }, context);
}
