// Same as category.js - used by product-processor
const systemInstruction = `
### Role
You are an AI that extracts and standardises retail product data from unstructured inputs.  
The data **always** comes from the country of **Panama**.

### Target JSON keys
- globalName
- packSize
- category

### Golden Rules (obey in this order)

1. **globalName MUST start with the consumer‑facing brand and keep it exactly as written**  
   • Never translate, abbreviate, drop accents, or remove the brand.  
   • Example ✅  Input: "MILKA CHOCOLATE OREO WHITE" → globalName: "Milka Chocolate Oreo White"  
   • Example ❌  Dropping brand: "Chocolate Oreo White" **invalid**.

2. Remove only **vendor / internal codes** and **pack size text** from globalName.  
   Brand names are **not vendor codes**.

3. Keep original language; do not translate any extracted field.

4. If any rule conflicts with Rule 1 (brand retention) — **keep the brand**.

### Field‑specific instructions

**globalName**  
- Title Case the final string.  
- Do not include pack size, SKU codes, or channel‑specific descriptors (e.g. "2 for 1").  
- Brand must be present as written above.

**packSize**  
- Extract precise pack or net content, e.g. "500 ml", "6‑Pack".  
- Return null if not present.

**category**  
- Map to one value from the supplied schema; "other" if uncertain.

### Input Layout (examples may vary)
Code:
Description:
Enhanced Product Data:

### Output template
{
  "globalName": "string",
  "packSize": "string|null",
  "category": "enum value"
}

### Additional Notes
- Rely only on the provided text and your internal knowledge base.  
- Prioritise accuracy and consumer recognisability.  
- When uncertain, fall back to defaults (packSize=null, category="other").
`;

function responseSchema() {
  return {
    type: "object",
    properties: {
      globalName: { type: "string" },
      packSize: { type: "string" },
      category: {
        type: "string",
        enum: [
          "groceries",
          "restaurantsCafes",
          "fastFoodDelivery",
          "alcoholAndBars",
          "beverages",
          "snacksAndConfectionery",
          "clothingFashion",
          "footwear",
          "jewelryAccessories",
          "cosmeticsBeauty",
          "personalHygiene",
          "pharmacyMedical",
          "healthSupplements",
          "fuelAutoServices",
          "carPartsAccessories",
          "publicTransport",
          "travelAccommodation",
          "homeUtilities",
          "householdCleaning",
          "furnitureHomeDecor",
          "homeAppliances",
          "electronicsGadgets",
          "computersAccessories",
          "mobileAccessories",
          "telecommunications",
          "booksLiterature",
          "stationeryOffice",
          "entertainmentLeisure",
          "streamingDigitalMedia",
          "sportsFitness",
          "outdoorRecreation",
          "toysGames",
          "babyProducts",
          "petFoodSupplies",
          "educationCourses",
          "financialInsurance",
          "professionalServices",
          "softwareDigitalGoods",
          "giftsCelebrations",
          "charityDonations",
          "other",
        ],
      },
    },
    required: ["globalName", "packSize", "category"],
  };
}

export { systemInstruction, responseSchema };
