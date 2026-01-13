import { getBarcodeTypes } from "../../shared/barcodeValidator.js";
import { ProductResponse } from "../../services/productEnhancer.js";
import { graphQl } from "../methods.js";
import { withErrorHandling } from "../../shared/errorHandler.js";
import {
  safeGet as safeDataGet,
  parsePrice,
  safeArray,
} from "../../shared/dataValidator.js";

export async function getProductData(website, barcode, productUrl) {
  const context = {
    brandId: "supermercadorey",
    barcode,
    method: "getProductData",
  };

  return withErrorHandling(async () => {
    const lookupSku = barcode.replace(/^0+/, "");
    const response = new ProductResponse();

    const data = await graphQl(
      {
        endpoint: "https://nextgentheadless.instaleap.io/api/v3",
        query: `
  query GetProductsBySKU($getProductsBySKUInput: GetProductsBySKUInput!) {
    getProductsBySKU(getProductsBySKUInput: $getProductsBySKUInput) {
      name
      price
      slug
      photosUrl
      unit
      subUnit
      subQty
      description
      sku
      ean
      brand
      promotion {
        type
        isActive
        conditions {
          quantity
          price
        }
      }
      categoriesData {
        active
        boost
        level
        name
      }
    }
  }
  `,
        variables: {
          getProductsBySKUInput: {
            clientId: "GRUPO_REY",
            skus: [lookupSku],
            storeReference: "1038",
          },
        },
      },
      context
    );

    const products = safeArray(safeDataGet(data, "data.getProductsBySKU"));
    if (products.length === 0) {
      return null;
    }

    const product = products.find((p) => p.sku === lookupSku);
    if (!product) {
      return null;
    }

    const url = `${website.replace(/\/+$/, "")}/p/${product.slug}`;

    const variantBarcodeResults = getBarcodeTypes(
      Array.isArray(product.ean) ? product.ean[0] : null
    );
    const ean13Entry = variantBarcodeResults.find(
      (r) => r.barcodeType === "EAN_13"
    );

    let formattedPrice;

    if (
      product.promotion &&
      product.promotion.isActive === true &&
      Array.isArray(product.promotion.conditions) &&
      product.promotion.conditions.length > 0
    ) {
      const lowestCondition = product.promotion.conditions.reduce(
        (prev, curr) => (curr.quantity < prev.quantity ? curr : prev),
        product.promotion.conditions[0]
      );
      formattedPrice = lowestCondition.price;
    } else {
      formattedPrice = parsePrice(product.price);
    }

    const categories = safeArray(product.categoriesData)
      .filter((cat) => cat.active)
      .sort((a, b) => {
        if (a.level !== b.level) {
          return b.level - a.level;
        }
        return b.boost - a.boost;
      })
      .map((cat) => cat.name);

    response.url = url;
    response.skuCode = String(lookupSku);
    response.ean13Code = ean13Entry?.barcode ?? null;
    response.enhancedData.name = product.name;
    response.enhancedData.description = product.description;
    response.enhancedData.categories = categories;
    response.enhancedData.packSize = product.unit;
    response.enhancedData.brand = product.brand;
    response.enhancedData.price = formattedPrice;

    return response;
  }, context);
}
