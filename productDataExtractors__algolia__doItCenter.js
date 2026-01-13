import { algolia, extractLdJsonPrice } from "../methods.js";
import { getBarcodeTypes } from "../../shared/barcodeValidator.js";
import { withErrorHandling } from "../../shared/errorHandler.js";
import { safeGet as safeDataGet } from "../../shared/dataValidator.js";

export async function getProductData(website, barcode, productUrl) {
  const context = { brandId: "doitcenter", barcode, method: "getProductData" };

  return withErrorHandling(async () => {
    if (productUrl) {
      return await extractLdJsonPrice(productUrl, context);
    }

    const algoliaResult = await algolia(
      website,
      barcode,
      "PO2AFBSP04",
      "f854ca1d1e7470a67e7eeb7b5bbe7259",
      "prod_default",
      context
    );

    if (algoliaResult === null) {
      return null;
    }

    const { response, enhancedData } = algoliaResult;

    const barcodes = (
      safeDataGet(enhancedData, "codigos_de_barra", "") || ""
    ).split(",", 2);
    const otherBarcode = barcodes.find((code) => code !== barcode) ?? null;

    const variantBarcodeResults = getBarcodeTypes(otherBarcode);
    const ean13Entry = variantBarcodeResults.find(
      (r) => r.barcodeType === "EAN_13"
    );

    const u = new URL(response.url);
    if (!u.pathname.startsWith("/productos/")) {
      const parts = u.pathname.replace(/^\/+/, "").split("/");
      u.pathname = `/productos/${parts.join("/")}`;
    }

    response.url = u.toString();
    response.ean13Code = ean13Entry?.barcode ?? null;
    response.enhancedData.name = enhancedData.name;
    response.enhancedData.brand = enhancedData.marca;
    response.enhancedData.categories = enhancedData.categories_without_path;
    response.enhancedData.price = safeDataGet(
      enhancedData,
      "price.USD.default",
      0
    );

    return response;
  }, context);
}
