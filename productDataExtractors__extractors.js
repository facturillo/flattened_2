import { getProductData as super99GetProductData } from "./graphQl/super99.js";
import { getProductData as reyGetProductData } from "./graphQl/rey.js";
import { getProductData as ribaSmithGetProductData } from "./other/ribaSmith.js";
import { getProductData as superXtraGetProductData } from "./other/superXtra.js";
import { getProductData as arrochaGetProductData } from "./other/arrocha.js";
import { getProductData as blackDogGetProductData } from "./other/blackDog.js";
import { getProductData as americanPetsGetProductData } from "./webPixels/americanPets.js";
import { getProductData as meloGetProductData } from "./webPixels/melo.js";
import { getProductData as superBaruGetProductData } from "./webPixels/superBaru.js";
import { getProductData as machetazoGetProductData } from "./other/machetazo.js";
import { getProductData as panafotoGetProductData } from "./algolia/panafoto.js";
import { getProductData as felixGetProductData } from "./searchserverapi/felix.js";
import { getProductData as titanGetProductData } from "./searchserverapi/titan.js";
import { getProductData as doItCenterGetProductData } from "./algolia/doItCenter.js";
import { getProductData as felipeMottaGetProductData } from "./algolia/felipeMotta.js";
import { getProductData as noveyGetProductData } from "./algolia/novey.js";
import { getProductData as conwayProductData } from "./graphQl/conway.js";
import { getProductData as stevensProductData } from "./graphQl/stevens.js";
import { getProductData as superCarnesProductData } from "./graphQl/superCarnes.js";

/**
 * Process a single barcode for a given brand
 */
async function processBarcode(brandId, code, description, productUrl) {
  switch (brandId) {
    case "super99":
      return await super99GetProductData(code, productUrl);

    case "elmachetazo":
      if (productUrl) {
        return await machetazoGetProductData(code, productUrl);
      } else {
        const variants = code.startsWith("0") ? [code, code.slice(1)] : [code];
        for (const v of variants) {
          const result = await machetazoGetProductData(v, productUrl);
          if (result) return result;
        }
        return null;
      }

    case "ribasmith":
      return await ribaSmithGetProductData(code, productUrl);

    case "superxtra":
      return await superXtraGetProductData(code, productUrl);

    case "supermercadorey":
      return await reyGetProductData(
        "https://www.smrey.com/",
        code,
        productUrl
      );

    case "superbaru":
      return await superBaruGetProductData(
        "https://superbaru.com/",
        code,
        productUrl
      );

    case "supercarnes":
      return await superCarnesProductData(
        "https://supercarnes.com/",
        code,
        productUrl
      );

    case "arrocha":
      return await arrochaGetProductData(
        "https://arrocha.com/",
        code,
        productUrl
      );

    case "americanpets":
      if (productUrl) {
        return await americanPetsGetProductData(
          "https://www.americanpetspanama.com/",
          code,
          productUrl
        );
      } else {
        const variants = code.includes(" ")
          ? [code, code.replace(/ /g, "-")]
          : [code];
        for (const v of variants) {
          const result = await americanPetsGetProductData(
            "https://www.americanpetspanama.com/",
            v,
            productUrl
          );
          if (result) return result;
        }
        return null;
      }

    case "melopetgarden":
      return await meloGetProductData(
        "https://melopetandgarden.com/",
        code,
        productUrl
      );

    case "novey":
      return await noveyGetProductData(
        "https://www.novey.com.pa/",
        code,
        productUrl
      );

    case "doitcenter":
      return await doItCenterGetProductData(
        "https://www.doitcenter.com.pa/",
        code,
        productUrl
      );

    case "felipemotta":
      return await felipeMottaGetProductData(
        "https://felipemotta.store/",
        code,
        productUrl
      );

    case "felix":
      return await felixGetProductData(
        "https://felix.com.pa/",
        code,
        productUrl
      );

    case "titan":
      return await titanGetProductData(
        "https://titan.com.pa/",
        code,
        productUrl
      );

    case "conway":
      return await conwayProductData(
        "https://conwayclick.com/",
        code,
        productUrl
      );

    case "stevens":
      return await stevensProductData(
        "https://stevens.com.pa/",
        code,
        productUrl
      );

    case "panafoto":
      return await panafotoGetProductData(
        "https://www.panafoto.com/",
        code,
        description,
        productUrl
      );

    case "blackdog":
      return await blackDogGetProductData(
        "https://www.blackdogpanama.com/",
        code,
        description,
        productUrl
      );

    default:
      return null;
  }
}

/**
 * Enhance product data by looking up barcode(s) against a vendor's catalog
 */
export async function productDataEnhancer(
  brandId,
  barcodes,
  description,
  productUrl
) {
  if (!brandId || !Array.isArray(barcodes) || barcodes.length === 0) {
    return null;
  }

  for (const { barcode } of barcodes) {
    if (!barcode) continue;

    try {
      const result = await processBarcode(
        brandId,
        barcode,
        description,
        productUrl
      );
      if (result) {
        return result;
      }
    } catch (error) {
      console.warn(
        `[${brandId}/${barcode}] Error processing barcode:`,
        error.message
      );
    }
  }

  return null;
}
