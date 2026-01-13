import * as cheerio from "cheerio";
import { runInNewContext } from "vm";
import { ProductResponse } from "../services/productEnhancer.js";
import { safeGet, safePost } from "../shared/httpClient.js";
import {
  safeGet as safeDataGet,
  parsePrice,
  safeArray,
} from "../shared/dataValidator.js";
import { withErrorHandling } from "../shared/errorHandler.js";

export async function graphQl({ endpoint, query, variables }, context = {}) {
  const result = await safePost(
    endpoint,
    { query, variables },
    { headers: { "Content-Type": "application/json" } },
    context
  );

  return result.success ? result.data : null;
}

export async function webPixels(website, barcode, context = {}) {
  return withErrorHandling(async () => {
    const baseDomain = website.replace(/\/+$/, "");
    const searchUrl = `${baseDomain}/search?type=product&q=${encodeURIComponent(
      barcode
    )}`;
    const response = new ProductResponse();

    const searchResult = await safeGet(searchUrl, {}, context);
    if (!searchResult.success) {
      console.debug(`[${context.brandId}/${barcode}] Search page fetch failed`);
      return null;
    }

    const $search = cheerio.load(searchResult.data);

    const pixelsScript = $search("script#web-pixels-manager-setup").html();
    if (!pixelsScript) {
      console.debug(
        `[${context.brandId}/${barcode}] web-pixels-manager-setup script not found`
      );
      return null;
    }

    const payloadMatch = pixelsScript.match(
      /webPixelsManagerAPI\.publish\s*\(\s*['"]search_submitted['"]\s*,\s*(\{[\s\S]+?\})\s*\)/
    );
    if (!payloadMatch) {
      console.debug(
        `[${context.brandId}/${barcode}] search_submitted payload not found`
      );
      return null;
    }

    let payload;
    try {
      payload = JSON.parse(payloadMatch[1]);
    } catch {
      try {
        payload = runInNewContext(`(${payloadMatch[1]})`);
      } catch (err) {
        console.debug(
          `[${context.brandId}/${barcode}] Payload parse failed:`,
          err.message
        );
        return null;
      }
    }

    const variants = safeArray(
      safeDataGet(payload, "searchResult.productVariants")
    );
    const found = variants.find((v) => v.sku === barcode);
    if (!found) {
      console.debug(
        `[${context.brandId}/${barcode}] No variant matching barcode found`
      );
      return null;
    }

    let productUrl = safeDataGet(found, "product.url");
    if (!productUrl) {
      console.debug(
        `[${context.brandId}/${barcode}] No product URL in variant`
      );
      return null;
    }

    if (!productUrl.startsWith("http")) {
      productUrl = baseDomain + productUrl;
    }

    response.url = productUrl;
    response.enhancedData.name = safeDataGet(found, "product.title");
    response.enhancedData.description = safeDataGet(
      found,
      "product.untranslatedTitle"
    );
    response.enhancedData.categories = safeDataGet(found, "product.type");
    response.enhancedData.brand = safeDataGet(found, "product.vendor");

    const productResult = await safeGet(productUrl, {}, context);
    if (!productResult.success) {
      console.debug(
        `[${context.brandId}/${barcode}] Product page fetch failed`
      );
      return null;
    }

    return { productHtml: productResult.data, response };
  }, context);
}

export async function searchserverapi(website, barcode, apiKey, context = {}) {
  return withErrorHandling(async () => {
    const baseDomain = website.replace(/\/+$/, "");
    const response = new ProductResponse();

    const searchEndpoint =
      `https://searchserverapi1.com/getresults` +
      `?api_key=${apiKey}` +
      `&maxResults=1` +
      `&q=${encodeURIComponent(barcode)}`;

    const searchResult = await safeGet(searchEndpoint, {}, context);
    if (!searchResult.success) {
      return null;
    }

    const items = safeArray(safeDataGet(searchResult.data, "items"));
    if (!items.length) return null;

    const shopifyVariants = safeArray(items[0].shopify_variants);
    const match_sku = shopifyVariants.find((v) => v.sku === barcode);
    const match_barcode = shopifyVariants.find((v) => v.barcode === barcode);
    const match = match_sku ?? match_barcode;
    if (!match) return null;

    const originalBarcode = match.barcode;

    let productUrl = match.link;
    if (!productUrl) return null;

    if (!productUrl.startsWith("http")) {
      productUrl = baseDomain + productUrl;
    }
    response.url = productUrl;

    const productResult = await safeGet(productUrl, {}, context);
    if (!productResult.success) {
      return null;
    }

    const $prod = cheerio.load(productResult.data);

    let enhancedData = null;
    $prod('script[type="application/ld+json"]').each((_, el) => {
      try {
        const json = JSON.parse($prod(el).html());
        const entries = Array.isArray(json) ? json : [json];
        for (const item of entries) {
          if (item["@type"] && item["@type"].toLowerCase() === "product") {
            const { ["@context"]: _, ["@type"]: __, ...rest } = item;
            enhancedData = rest;
            break;
          }
        }
        if (enhancedData) return false;
      } catch {
        // ignore parse errors
      }
    });

    if (!enhancedData) {
      return {
        enhancedData: {
          ...match,
          name: items[0].title,
          description: items[0].description,
          brand: { name: items[0].vendor },
          categories: items[0].tags,
        },
        response,
      };
    }

    enhancedData.selectedOffer = Array.isArray(enhancedData.offers)
      ? enhancedData.offers[0]
      : enhancedData.offers;

    return {
      enhancedData: { ...enhancedData, categories: items[0].tags },
      originalBarcode,
      response,
    };
  }, context);
}

export async function algolia(
  website,
  barcode,
  defaultAppId,
  defaultApiKey,
  defaultIndex,
  context = {}
) {
  return withErrorHandling(async () => {
    const response = new ProductResponse();
    const { protocol, host } = new URL(website);
    const baseDomain = `${protocol}//${host}`;

    async function queryAlgolia(endpoint, headers, indexName, queryParam) {
      const body = {
        requests: [
          {
            indexName: `${indexName}_products`,
            params: `query=${encodeURIComponent(queryParam)}`,
          },
        ],
      };

      headers = {
        ...headers,
        "Content-Type": "application/x-www-form-urlencoded",
      };

      const result = await safePost(
        endpoint,
        JSON.stringify(body),
        { headers },
        context
      );
      if (!result.success) return null;

      const hits = safeArray(safeDataGet(result.data, "results.0.hits"));
      const code = String(barcode).toLowerCase();
      return (
        hits.find((hit) => String(hit.sku).toLowerCase() === code) ??
        hits.find((hit) => String(hit.reference).toLowerCase() === code) ??
        null
      );
    }

    let APP_ID = defaultAppId ? defaultAppId : null,
      API_KEY = defaultApiKey ? defaultApiKey : null,
      INDEX = defaultIndex ? defaultIndex : null;

    if (!APP_ID || !API_KEY || !INDEX) {
      const searchPageUrl = `${baseDomain}/catalogsearch/result/?q=${encodeURIComponent(
        barcode
      )}`;
      const searchResult = await safeGet(searchPageUrl, {}, context);
      if (!searchResult.success) return null;

      const $ = cheerio.load(searchResult.data);

      const scriptText = $("script")
        .toArray()
        .map((el) => $(el).html())
        .find((txt) => txt && txt.includes("window.algoliaConfig"));

      if (!scriptText) return null;

      const match = scriptText.match(
        /window\.algoliaConfig\s*=\s*(\{[\s\S]+?\});/
      );
      if (!match) return null;

      try {
        const cfg = JSON.parse(match[1]);
        const { applicationId, apiKey, indexName } = cfg;
        APP_ID = applicationId ? applicationId : null;
        API_KEY = apiKey ? apiKey : null;
        INDEX = indexName ? indexName : null;
      } catch (err) {
        console.warn(
          `[${context.brandId}/${barcode}] Failed to parse algoliaConfig:`,
          err.message
        );
        return null;
      }
    }

    const endpoint = `https://${APP_ID.toLowerCase()}-dsn.algolia.net/1/indexes/*/queries?x-algolia-application-id=${APP_ID}&x-algolia-api-key=${API_KEY}`;
    const headers = {
      "X-Algolia-Application-Id": APP_ID,
      "X-Algolia-API-Key": API_KEY,
    };

    const hit = await queryAlgolia(endpoint, headers, INDEX, barcode);
    if (!hit) return null;

    response.url = hit.url;
    return { response, enhancedData: hit };
  }, context);
}

export async function extractLdJsonPrice(url, context = {}) {
  return withErrorHandling(async () => {
    const response = new ProductResponse();
    const result = await safeGet(url, {}, context);

    if (!result.success) return null;

    const $ = cheerio.load(result.data);

    const script = $('script[type="application/ld+json"]')
      .filter((_, el) => /"@type"\s*:\s*"Product"/.test($(el).html() || ""))
      .first();

    if (!script.length) return null;

    let productData;
    try {
      productData = JSON.parse(script.html());
    } catch (err) {
      console.warn(
        `[${context.brandId}/${context.barcode}] Failed to parse LD+JSON:`,
        err.message
      );
      return null;
    }

    const offers = productData.offers || {};
    let price = 0;

    if (
      Array.isArray(offers.offers) &&
      offers.offers.length &&
      offers.offers[0].price != null
    ) {
      price = parseFloat(offers.offers[0].price);
    } else if (
      Array.isArray(offers) &&
      offers.length &&
      offers[0].price != null
    ) {
      price = parseFloat(offers[0].price);
    } else if (offers.price != null) {
      price = parseFloat(offers.price);
    } else if (offers.lowPrice != null) {
      price = parseFloat(offers.lowPrice);
    } else if (offers.highPrice != null) {
      price = parseFloat(offers.highPrice);
    }

    response.url = url;
    response.enhancedData.price = isNaN(price) ? 0 : price;
    return response;
  }, context);
}
