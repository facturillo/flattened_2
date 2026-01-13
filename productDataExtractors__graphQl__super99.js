import { getBarcodeTypes } from "../../shared/barcodeValidator.js";
import { ProductResponse } from "../../services/productEnhancer.js";
import { safePost } from "../../shared/httpClient.js";
import {
  safeGet as safeDataGet,
  parsePrice,
  safeTrim,
  safeArray,
} from "../../shared/dataValidator.js";
import { withErrorHandling } from "../../shared/errorHandler.js";

const GRAPHQL_ENDPOINT = "https://catalog-service.adobe.io/graphql";
const HEADERS = {
  "Content-Type": "application/json",
  "X-Api-Key": "da886b56118447a0a59703de747349ad",
  "Magento-Environment-Id": "62e34917-8244-4ca2-869c-5c4958a4ec04",
  "Magento-Store-Code": "super99",
  "Magento-Store-View-Code": "brisas_del_golf",
  "Magento-Website-Code": "super99",
  "Magento-Customer-Group": "b6589fc6ab0dc82cf12099d1c2d40ab994e8410c",
};

const SEARCH_QUERY = `
  query productSearch(
    $phrase: String!
    $pageSize: Int
    $filter: [SearchClauseInput!]
  ) {
    productSearch(
      phrase: $phrase
      page_size: $pageSize
      filter: $filter
    ) {
      total_count
      items {
        product {
          sku
          name
          description { html }
          short_description { html }
          price_range {
            minimum_price {
              final_price { value currency }
            }
          }
        }
        productView {
          sku
          name
          url
          inStock
          attributes { name label value }
          ... on SimpleProductView {
            price {
              final { amount { value currency } }
            }
          }
        }
      }
      facets {
        attribute
        buckets {
          title
          ... on CategoryView { name path }
        }
      }
    }
  }
`;

async function graphQlSearch(phrase, context) {
  const variables = {
    phrase,
    pageSize: 10,
    filter: [{ attribute: "visibility", in: ["Search", "Catalog, Search"] }],
  };

  const result = await safePost(
    GRAPHQL_ENDPOINT,
    { query: SEARCH_QUERY, variables },
    { headers: HEADERS },
    context
  );

  return result.success ? result.data : null;
}

/**
 * Extract SKU from Super99 product URL
 * Format: https://www.super99.com/20051426-product-name-here
 */
function extractSkuFromUrl(productUrl) {
  try {
    const url = new URL(productUrl);
    const path = url.pathname.replace(/^\/+/, "");
    const match = path.match(/^(\d+)-/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function getAttributeValue(attributes, name) {
  const attr = attributes.find((a) => a.name === name);
  return attr?.value ?? null;
}

function findMatchingProduct(items, identifier, matchBy) {
  for (const item of items) {
    if (matchBy === "sku") {
      const sku =
        safeDataGet(item, "product.sku") ||
        safeDataGet(item, "productView.sku");
      if (sku === identifier) return item;
    } else {
      const attributes = safeArray(safeDataGet(item, "productView.attributes"));
      const upc = getAttributeValue(attributes, "upc");
      if (upc === identifier) return item;
    }
  }

  return items.length === 1 ? items[0] : null;
}

function extractCategories(facets) {
  const categoryFacet = facets.find((f) => f.attribute === "categories");
  if (!categoryFacet) return [];

  return safeArray(categoryFacet.buckets)
    .filter((b) => b.name)
    .sort((a, b) => (a.path?.length || 0) - (b.path?.length || 0))
    .map((b) => b.name);
}

export async function getProductData(barcode, productUrl) {
  const context = { brandId: "super99", barcode, method: "getProductData" };

  return withErrorHandling(async () => {
    const response = new ProductResponse();

    // Determine search phrase and match strategy
    let searchPhrase;
    let matchBy;

    if (productUrl) {
      const sku = extractSkuFromUrl(productUrl);
      if (!sku) return null;
      searchPhrase = sku;
      matchBy = "sku";
    } else {
      searchPhrase = barcode;
      matchBy = "upc";
    }

    const data = await graphQlSearch(searchPhrase, context);
    if (!data) return null;

    const items = safeArray(safeDataGet(data, "data.productSearch.items"));
    if (items.length === 0) return null;

    const matchedItem = findMatchingProduct(items, searchPhrase, matchBy);
    if (!matchedItem) return null;

    const product = matchedItem.product || {};
    const productView = matchedItem.productView || {};
    const attributes = safeArray(productView.attributes);
    const facets = safeArray(safeDataGet(data, "data.productSearch.facets"));

    // UPC for EAN-13 generation
    const upc = getAttributeValue(attributes, "upc") || barcode;
    const variantBarcodeResults = getBarcodeTypes(upc);
    const ean13Entry = variantBarcodeResults.find(
      (r) => r.barcodeType === "EAN_13"
    );

    // Categories from facets, fallback to attribute
    let categories = extractCategories(facets);
    if (categories.length === 0) {
      const cat = getAttributeValue(attributes, "categoria");
      if (cat) categories = [cat];
    }

    // Price from productView or product
    const price =
      safeDataGet(productView, "price.final.amount.value") ??
      safeDataGet(product, "price_range.minimum_price.final_price.value") ??
      0;

    response.url = productUrl || productView.url;
    response.skuCode = product.sku || productView.sku;
    response.ean13Code = ean13Entry?.barcode ?? null;
    response.enhancedData.name = safeTrim(productView.name || product.name);
    response.enhancedData.description = safeTrim(
      safeDataGet(product, "short_description.html") ||
        safeDataGet(product, "description.html")
    );
    response.enhancedData.brand = safeTrim(
      getAttributeValue(attributes, "marca")
    );
    response.enhancedData.categories = categories;
    response.enhancedData.packSize = safeTrim(
      getAttributeValue(attributes, "sales_unit_of_measure")
    );
    response.enhancedData.price = parsePrice(price);

    return response;
  }, context);
}
