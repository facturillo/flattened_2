import * as cheerio from "cheerio";
import { runInNewContext } from "vm";
import { getBarcodeTypes } from "../../shared/barcodeValidator.js";
import { webPixels } from "../methods.js";
import { ProductResponse } from "../../services/productEnhancer.js";
import { safeGet } from "../../shared/httpClient.js";
import {
  safeGet as safeDataGet,
  parsePrice,
  safeArray,
} from "../../shared/dataValidator.js";
import { withErrorHandling } from "../../shared/errorHandler.js";

export async function getProductData(website, barcode, productUrl) {
  const context = {
    brandId: "americanpets",
    barcode,
    method: "getProductData",
  };

  return withErrorHandling(async () => {
    if (productUrl) {
      const earlyResponse = new ProductResponse();
      const result = await safeGet(productUrl, {}, context);
      if (!result.success) return null;

      const $ = cheerio.load(result.data);
      let literal = null;

      $("script").each((_, el) => {
        const js = $(el).html() || "";
        const m = js.match(
          /new Shopify\.OptionSelectors\s*\(\s*['"]productSelect['"]\s*,\s*\{\s*product:\s*(\{[\s\S]*?\})\s*,\s*onVariantSelected/
        );
        if (m) {
          literal = m[1];
          return false;
        }
      });

      if (!literal) return null;

      literal = literal.replace(/\\u([0-9A-Fa-f]{4})/g, (_, hex) =>
        String.fromCharCode(parseInt(hex, 16))
      );

      let productData;
      try {
        productData = JSON.parse(literal);
      } catch {
        try {
          productData = runInNewContext(`(${literal})`);
        } catch (err) {
          console.debug(
            `[${context.brandId}/${barcode}] Product literal parse failed:`,
            err.message
          );
          return null;
        }
      }

      const variants = safeArray(productData.variants);
      productData.selectedVariant =
        variants.length === 1
          ? variants[0]
          : variants.find((v) => v.sku === barcode) || {};

      earlyResponse.url = productUrl;
      earlyResponse.enhancedData.price =
        parsePrice(productData.selectedVariant.price ?? productData.price) /
        100;

      return earlyResponse;
    }

    const webPixelsResult = await webPixels(website, barcode, context);
    if (webPixelsResult === null) {
      return null;
    }

    const { productHtml, response } = webPixelsResult;
    const $prod = cheerio.load(productHtml);

    let literal = null;
    $prod("script").each((_, el) => {
      const js = $prod(el).html() || "";
      const m = js.match(
        /new Shopify\.OptionSelectors\s*\(\s*['"]productSelect['"]\s*,\s*\{\s*product:\s*(\{[\s\S]*?\})\s*,\s*onVariantSelected/
      );
      if (m) {
        literal = m[1];
        return false;
      }
    });

    if (!literal) {
      return response;
    }

    literal = literal.replace(/\\u([0-9A-Fa-f]{4})/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    );

    let productData;
    try {
      productData = JSON.parse(literal);
    } catch {
      try {
        productData = runInNewContext(`(${literal})`);
      } catch (err) {
        console.debug(
          `[${context.brandId}/${barcode}] Product literal parse failed:`,
          err.message
        );
        return response;
      }
    }

    const variants = safeArray(productData.variants);
    productData.selectedVariant =
      variants.length === 1
        ? variants[0]
        : variants.find((v) => v.sku === barcode) || {};

    const variantBarcodeResults = getBarcodeTypes(
      safeDataGet(productData, "selectedVariant.barcode")
    );
    const ean13Entry = variantBarcodeResults.find(
      (r) => r.barcodeType === "EAN_13"
    );

    response.ean13Code = ean13Entry?.barcode ?? null;
    response.enhancedData.name =
      safeDataGet(productData, "selectedVariant.name") ?? productData.title;
    response.enhancedData.description = productData.description;
    response.enhancedData.categories = safeArray(productData.tags);
    response.enhancedData.brand = productData.vendor;
    response.enhancedData.price =
      parsePrice(productData.selectedVariant.price ?? productData.price) / 100;

    return response;
  }, context);
}
