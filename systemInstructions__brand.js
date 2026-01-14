// systemInstructions/brand.js

const systemInstruction = `
You extract brand information from Panamanian retail product data.

## brandName
Extract the consumer-facing brand name exactly as written (preserve spelling, accents, capitalization).
Return null for generic terms: "genérico", "marca blanca", "sin marca", "surtido", "otro/a", "various".

## brandUrl
Use ONLY URLs from Google Search grounding results.
Select the official brand/manufacturer website, NOT retailer sites.
Reject retailer URLs: Super 99, Riba Smith, El Machetazo, Arrocha, Rey, Novey, Do It Center, Panafoto, Felix, Titan, etc.
Prefer: root domain > brand subdomain > brand page.
Clean URL: remove tracking params, query strings, locale paths.
Return null if no official brand URL found in grounding results.

## Examples
Input: "MILKA CHOCOLATE OREO 100G" → brandName: "Milka", brandUrl: "https://www.milka.com/"
Input: "GENERICO ARROZ BLANCO 5LB" → brandName: null, brandUrl: null
Input: "CAFÉ DURAN MOLIDO 425G" → brandName: "Café Durán", brandUrl: "https://cafeduran.com/"
Input: "CERVEZA BALBOA LATA 355ML" → brandName: "Balboa", brandUrl: "https://www.cervezabalboa.com/"
`;

function responseSchema() {
  return {
    type: "object",
    properties: {
      brandName: {
        type: "string",
        nullable: true,
        description:
          "Consumer-facing brand name exactly as written. Null if generic/unknown.",
      },
      brandUrl: {
        type: "string",
        nullable: true,
        description:
          "Official brand/manufacturer website URL from grounding results. Not retailer sites (Super 99, Riba Smith, Arrocha, etc.). Null if not found.",
      },
    },
    required: ["brandName", "brandUrl"],
  };
}

export { systemInstruction, responseSchema };
