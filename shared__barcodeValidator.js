import { gtin, mod11_2 } from "cdigit";

/**
 * Returns a list of possible barcode interpretations.
 * Each entry has the (possibly normalized) barcode and its type.
 *
 * @param {string} barcode
 * @returns {{ barcode: string, barcodeType: string }[]}
 */
const getBarcodeTypes = (barcode) => {
  if (typeof barcode !== "string" || barcode.length === 0) {
    return [{ barcode, barcodeType: "undefined" }];
  }

  const results = [];
  const seen = new Set();
  function add(code, type) {
    if (!seen.has(code)) {
      seen.add(code);
      results.push({ barcode: code, barcodeType: type });
    }
  }

  // ----- EAN‑8 -----
  if (/^\d{7}$/.test(barcode)) {
    add(gtin.generate(barcode), "EAN_8");
  }
  if (/^\d{8}$/.test(barcode) && gtin.validate(barcode)) {
    add(barcode, "EAN_8");
  }

  // ----- ISBN‑10 -----
  if (/^\d{9}$/.test(barcode)) {
    add(mod11_2.generate(barcode), "ISBN_10");
  }
  if (/^[0-9]{9}[0-9X]$/.test(barcode) && mod11_2.validate(barcode)) {
    add(barcode, "ISBN_10");
  }

  // ----- UPC‑A -----
  if (/^\d{10}$/.test(barcode)) {
    add(gtin.generate("0" + barcode), "UPC_A");
  }
  if (/^\d{11}$/.test(barcode)) {
    add(gtin.generate(barcode), "UPC_A");
  }
  if (/^\d{12}$/.test(barcode) && gtin.validate(barcode)) {
    // 1) valid UPC‑A
    add(barcode, "UPC_A");

    // 2) also treat it as a 12‑digit EAN‑13 core and generate the 13th digit
    add(gtin.generate(barcode), "EAN_13");
  }

  // ----- UPC‑A from a "0‑prefixed" 12‑digit code -----
  if (/^\d{12}$/.test(barcode) && barcode.startsWith("0")) {
    const upcCore = barcode.slice(1); // 11 digits
    add(gtin.generate(upcCore), "UPC_A"); // full 12‑digit UPC‑A
  }

  // ----- EAN‑13 fallback for 12 digits -----
  if (/^\d{12}$/.test(barcode) && !gtin.validate(barcode)) {
    add(gtin.generate(barcode), "EAN_13");
  }

  // ----- EAN‑13 vs ISBN‑13 -----
  if (/^\d{13}$/.test(barcode) && gtin.validate(barcode)) {
    const type =
      barcode.startsWith("978") || barcode.startsWith("979")
        ? "ISBN_13"
        : "EAN_13";
    add(barcode, type);
  }

  // If no matches, return original as undefined
  if (results.length === 0) {
    return [{ barcode, barcodeType: "undefined" }];
  }

  // Ensure the original input is present (as "undefined") if it wasn't rewritten
  if (!seen.has(barcode)) {
    results.push({ barcode, barcodeType: "undefined" });
  }

  // Guarantee an EAN_13 (or ISBN_13) whenever we have any other valid code
  const hasNonUndefined = results.some((r) => r.barcodeType !== "undefined");
  const hasAny13 = results.some(
    (r) => r.barcodeType === "EAN_13" || r.barcodeType === "ISBN_13"
  );

  if (hasNonUndefined && !hasAny13) {
    const candidate =
      results.find((r) => r.barcodeType === "ISBN_10") ||
      results.find((r) => r.barcodeType === "UPC_A") ||
      results.find((r) => r.barcodeType === "EAN_8") ||
      results.find((r) => r.barcodeType === "EAN_13") ||
      results.find((r) => r.barcodeType === "ISBN_13");

    if (candidate) {
      let core12;
      switch (candidate.barcodeType) {
        case "ISBN_10":
          core12 = "978" + candidate.barcode.slice(0, 9);
          break;
        case "UPC_A":
          core12 = "0" + candidate.barcode.slice(0, 11);
          break;
        case "EAN_8":
          core12 = "00000" + candidate.barcode.slice(0, 7);
          break;
        case "EAN_13":
        case "ISBN_13":
          core12 = candidate.barcode.slice(0, 12);
          break;
        default:
          core12 = candidate.barcode
            .replace(/\D/g, "")
            .padStart(12, "0")
            .slice(0, 12);
      }

      add(gtin.generate(core12), "EAN_13");
    }
  }

  const ean13Entry = results.find(
    (r) => r.barcodeType === "EAN_13" || r.barcodeType === "ISBN_13"
  );
  if (ean13Entry) {
    const ean = ean13Entry.barcode;

    // 1) UPC-A: drop the leading zero from EAN-13 and re-generate check digit
    if (ean.startsWith("0")) {
      const upcCore = ean.slice(1, 12);
      add(gtin.generate(upcCore), "UPC_A");
    }

    // 2) ISBN-10: for ISBN-13 (978/979) prefixes
    if (ean.startsWith("978") || ean.startsWith("979")) {
      const isbn10Core = ean.slice(3, 12);
      add(mod11_2.generate(isbn10Core), "ISBN_10");
    }

    // 3) EAN-8
    if (ean.startsWith("00000")) {
      const ean8Core = ean.slice(5, 12);
      add(gtin.generate(ean8Core), "EAN_8");
    }
  }

  return results;
};

const generateVariations = (ean13Code) => {
  if (
    typeof ean13Code !== "string" ||
    ean13Code.length !== 13 ||
    !gtin.validate(ean13Code)
  ) {
    return [];
  }

  const results = [
    { barcode: ean13Code, barcodeType: "EAN_13" },
    { barcode: ean13Code.slice(0, 12), barcodeType: "EAN_13_noCD" },
  ];

  // 1) UPC-A
  if (ean13Code.startsWith("0")) {
    const upcCore = ean13Code.slice(1, 12);
    const upcCode = gtin.generate(upcCore);
    results.push({ barcode: upcCode, barcodeType: "UPC_A" });
    results.push({ barcode: upcCore, barcodeType: "UPC_A_noCD" });
  }

  // 2) ISBN-10
  if (ean13Code.startsWith("978") || ean13Code.startsWith("979")) {
    const isbn10Core = ean13Code.slice(3, 12);
    const isbn10Code = mod11_2.generate(isbn10Core);
    results.push({ barcode: isbn10Code, barcodeType: "ISBN_10" });
    results.push({ barcode: isbn10Core, barcodeType: "ISBN_10_noCD" });
  }

  // 3) EAN-8
  if (ean13Code.startsWith("00000")) {
    const ean8Core = ean13Code.slice(5, 12);
    const ean8Code = gtin.generate(ean8Core);
    results.push({ barcode: ean8Code, barcodeType: "EAN_8" });
    results.push({ barcode: ean8Core, barcodeType: "EAN_8_noCD" });
  }

  return results;
};

export { getBarcodeTypes, generateVariations };
