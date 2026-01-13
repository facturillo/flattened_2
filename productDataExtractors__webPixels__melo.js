import * as cheerio from "cheerio";
import { getBarcodeTypes } from "../../shared/barcodeValidator.js";
import { webPixels, extractLdJsonPrice } from "../methods.js";
import {
  safeGet as safeDataGet,
  parsePrice,
} from "../../shared/dataValidator.js";
import { withErrorHandling } from "../../shared/errorHandler.js";

export async function getProductData(website, barcode, productUrl) {
  const context = {
    brandId: "melopetgarden",
    barcode,
    method: "getProductData",
  };

  return withErrorHandling(async () => {
    if (productUrl) {
      return await extractLdJsonPrice(productUrl, context);
    }

    const webPixelsResult = await webPixels(website, barcode, context);
    if (webPixelsResult === null) {
      return null;
    }

    const { productHtml, response } = webPixelsResult;

    const $prod = cheerio.load(productHtml);

    let enhancedData = null;
    let firstProduct = null;

    $prod('script[type="application/ld+json"]').each((_, el) => {
      try {
        const json = JSON.parse($prod(el).html());
        const items = Array.isArray(json) ? json : [json];

        for (const item of items) {
          if (item["@type"] && item["@type"].toLowerCase() === "product") {
            const { "@context": _, "@type": __, ...rest } = item;

            if (!firstProduct) firstProduct = rest;

            if (rest.gtin13 || safeDataGet(rest, "offers.gtin13")) {
              enhancedData = rest;
              break;
            }
          }
        }

        if (enhancedData) return false;
      } catch {
        // ignore parse errors
      }
    });

    if (!enhancedData) {
      enhancedData = firstProduct;
    }

    if (!enhancedData) {
      return response;
    }

    enhancedData.selectedOffer = Array.isArray(enhancedData.offers)
      ? enhancedData.offers[0]
      : enhancedData.offers;

    const variantBarcodeResults = getBarcodeTypes(
      safeDataGet(enhancedData, "selectedOffer.gtin13")
    );
    const ean13Entry = variantBarcodeResults.find(
      (r) => r.barcodeType === "EAN_13"
    );

    response.ean13Code = ean13Entry?.barcode ?? null;
    response.enhancedData.name = enhancedData.name;
    response.enhancedData.description = enhancedData.description;
    response.enhancedData.brand = safeDataGet(enhancedData, "brand.name");
    response.enhancedData.price = parsePrice(
      safeDataGet(enhancedData, "selectedOffer.price")
    );

    return response;
  }, context);
}
