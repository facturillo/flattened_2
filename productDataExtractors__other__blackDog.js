import * as cheerio from "cheerio";
import { getBarcodeTypes } from "../../shared/barcodeValidator.js";
import { ProductResponse } from "../../services/productEnhancer.js";
import { safeGet, safePost } from "../../shared/httpClient.js";
import {
  safeGet as safeDataGet,
  parsePrice,
  safeArray,
} from "../../shared/dataValidator.js";
import { withErrorHandling } from "../../shared/errorHandler.js";

// FIX: Limit the number of templates to check to prevent unbounded loops
const MAX_TEMPLATES_TO_CHECK = 100;

export async function getProductData(
  website,
  barcode,
  productDescription,
  productUrl
) {
  const context = { brandId: "blackdog", barcode, method: "getProductData" };

  return withErrorHandling(async () => {
    const response = new ProductResponse();
    const base = website.replace(/\/+$/, "");
    const postUrl = `${base}/sale/get_combination_info_website`;

    if (productUrl) {
      const result = await safePost(
        postUrl,
        {
          jsonrpc: "2.0",
          method: "call",
          params: {
            product_template_id: barcode,
            product_id: false,
            combination: [],
            add_qty: 0,
            pricelist_id: false,
          },
          id: 1,
        },
        {},
        context
      );

      if (!result.success) return null;

      const pti = safeDataGet(result.data, "result.product_tracking_info");
      if (pti) {
        response.url = productUrl;
        response.enhancedData.price = parsePrice(
          pti.price ?? safeDataGet(result.data, "result.price")
        );
        return response;
      }
      return null;
    }

    const searchUrl = `${base}/shop`;
    const params = { search: productDescription };

    const searchResult = await safeGet(searchUrl, { params }, context);
    if (!searchResult.success) return null;

    const $ = cheerio.load(searchResult.data);
    const templateIds = new Set();
    $("button[data-product-template-id]").each((_, el) => {
      const id = parseInt($(el).attr("data-product-template-id"), 10);
      if (!isNaN(id)) templateIds.add(id);
    });

    if (templateIds.size === 0) return null;

    // FIX: Limit the number of templates to check
    let checked = 0;
    for (const product_template_id of templateIds) {
      if (checked >= MAX_TEMPLATES_TO_CHECK) {
        console.warn(
          `[${context.brandId}/${barcode}] Hit template limit (${MAX_TEMPLATES_TO_CHECK}), stopping search`
        );
        break;
      }
      checked++;

      const result = await safePost(
        postUrl,
        {
          jsonrpc: "2.0",
          method: "call",
          params: {
            product_template_id,
            product_id: false,
            combination: [],
            add_qty: 0,
            pricelist_id: false,
          },
          id: 1,
        },
        {},
        context
      );

      if (!result.success) continue;

      const pti = safeDataGet(result.data, "result.product_tracking_info");
      if (pti) {
        const { item_id, item_name } = pti;
        const nameContains =
          typeof item_name === "string" && item_name.includes(barcode);
        if (item_id === barcode || nameContains) {
          const url = `${base}/shop/${product_template_id}`;
          const variantBarcodeResults = getBarcodeTypes(item_id);
          const ean13Entry = variantBarcodeResults.find(
            (r) => r.barcodeType === "EAN_13"
          );

          response.url = url;
          response.skuCode = String(product_template_id);
          response.ean13Code = ean13Entry?.barcode ?? null;
          response.enhancedData.name = item_name ?? pti.display_name;
          response.enhancedData.categories =
            pti.item_category ??
            safeDataGet(result.data, "result.product_type");
          response.enhancedData.packSize = safeDataGet(
            result.data,
            "result.uom_name"
          );
          response.enhancedData.price = parsePrice(
            pti.price ?? safeDataGet(result.data, "result.price")
          );

          return response;
        }
      }
    }

    return null;
  }, context);
}
