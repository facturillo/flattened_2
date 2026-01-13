import { getBarcodeTypes } from "../../shared/barcodeValidator.js";
import { ProductResponse } from "../../services/productEnhancer.js";
import { graphQl } from "../methods.js";
import { withErrorHandling } from "../../shared/errorHandler.js";
import {
  safeGet as safeDataGet,
  safeArray,
} from "../../shared/dataValidator.js";

export async function getProductData(website, barcode, productUrl) {
  const context = { brandId: "supercarnes", barcode, method: "getProductData" };

  return withErrorHandling(async () => {
    const response = new ProductResponse();

    const data = await graphQl(
      {
        endpoint: `${website}graphql`,
        query: `
  query getProductDetailForProductPage {
  products(search: "${barcode}") {
    items {
      name
      sku
      url_key
      url_suffix
      categories {
        level
        name
      }
      price {
        regularPrice {
          amount {
            value
            currency
          }
        }
      }
      special_price
      short_description {
        html
      }
      small_image {
        url
      }
      custom_attributes {
        selected_attribute_options {
          attribute_option {
            uid
            label
            is_default
          }
        }
        attribute_metadata {
          uid
          code
          label
          attribute_labels {
            store_code
            label
          }
          data_type
          is_system
          entity_type
        }
      }
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

    const variantBarcodeResults = getBarcodeTypes(barcode);
    const ean13Entry = variantBarcodeResults.find(
      (r) => r.barcodeType === "EAN_13"
    );

    const brandAttributes = safeArray(product.custom_attributes).find(
      (a) => safeDataGet(a, "attribute_metadata.code") === "marca_1001"
    );

    let brandLabel = null;
    if (brandAttributes) {
      const brandLabelList = safeArray(
        safeDataGet(
          brandAttributes,
          "selected_attribute_options.attribute_option"
        )
      );
      if (brandLabelList.length > 0) {
        const defaultBrand = brandLabelList.find((a) => a.is_default);
        if (defaultBrand) {
          brandLabel = defaultBrand.label;
        } else {
          brandLabel = brandLabelList[0].label;
        }
      }
    }

    response.url = url;
    response.skuCode = barcode;
    response.ean13Code = ean13Entry?.barcode ?? null;
    response.enhancedData.name = product.name.trim();
    response.enhancedData.brand = brandLabel;
    response.enhancedData.description = safeDataGet(
      product,
      "short_description.html",
      ""
    );
    response.enhancedData.categories = safeArray(product.categories).map(
      (c) => c.name
    );
    response.enhancedData.price =
      product.special_price ??
      safeDataGet(product, "price.regularPrice.amount.value", 0);

    return response;
  }, context);
}
