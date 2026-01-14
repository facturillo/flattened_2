// systemInstructions/category.js

const systemInstruction = `
You extract and standardize retail product data from Panamanian stores.

## globalName
Start with the brand name (never remove it). Use Title Case.
Remove: SKU codes, pack size text, promotional text.
Keep original language (Spanish/English as-is).

## packSize
Extract quantity/size: "500 ml", "1 kg", "6-Pack", "12 unidades".
Null if not present.

## category
Select the single best matching category from the schema.
Use "other" only when no category fits.

## Examples
Input: "LECHE ESTRELLA AZUL ENTERA 1L" → globalName: "Leche Estrella Azul Entera", packSize: "1 L", category: "groceries"
Input: "CERVEZA ATLAS LATA 355ML 6PK" → globalName: "Cerveza Atlas", packSize: "6-Pack 355 ml", category: "alcoholAndBars"
Input: "JABON PROTEX AVENA 110G" → globalName: "Jabón Protex Avena", packSize: "110 g", category: "personalHygiene"
Input: "PAPEL SCOTT 1000 HOJAS 4 ROLLOS" → globalName: "Papel Scott 1000 Hojas", packSize: "4 rollos", category: "householdCleaning"
Input: "RON ABUELO 7 AÑOS 750ML" → globalName: "Ron Abuelo 7 Años", packSize: "750 ml", category: "alcoholAndBars"
`;

function responseSchema() {
  return {
    type: "object",
    properties: {
      globalName: {
        type: "string",
        description:
          "Standardized product name in Title Case. Must start with brand name.",
      },
      packSize: {
        type: "string",
        nullable: true,
        description:
          "Product quantity/size (e.g., '500 ml', '6-Pack'). Null if not present.",
      },
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
        description: "Product category from the predefined list.",
      },
    },
    required: ["globalName", "packSize", "category"],
  };
}

export { systemInstruction, responseSchema };
