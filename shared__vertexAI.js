import { GoogleGenAI } from "@google/genai";
import { db } from "./firebase.js";

// Based on 200 requests per minute, the minimum delay between requests is ~300ms.
const MIN_DELAY = Math.ceil(60000 / 200); // 300ms

// Timeout for Vertex AI calls (2 minutes)
const VERTEX_AI_TIMEOUT_MS = 45000;

// Helper: snip out the first `{…}` block from a string and parse it,
// or return an empty object on failure.
function extractJsonObject(text) {
  const trimmedText = text.trim();
  const start = trimmedText.indexOf("{");
  const end = trimmedText.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    const candidate = trimmedText.slice(start, end + 1);
    try {
      return JSON.parse(candidate);
    } catch (err) {
      console.error("Failed to parse snipped JSON, defaulting to {}:", err);
    }
  }
  return {};
}

/**
 * Helper: Create a timeout promise that rejects after specified ms
 */
function createTimeoutPromise(ms, operation = "Vertex AI call") {
  return new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error(`${operation} timed out after ${ms}ms`));
    }, ms);
  });
}

/**
 * Helper function: vertexAICall
 * Wraps a Vertex AI model.generateContent call with exponential backoff on 429 errors
 * and timeout protection.
 */
async function vertexAICall(
  modelName,
  systemInstruction,
  inputString,
  responseSchema
) {
  const maxRetries = 5;
  let attempt = 0;
  let delay = MIN_DELAY;
  const ai = new GoogleGenAI({
    vertexai: true,
    project: "panabudget",
    location: "us-central1",
  });
  const config = {
    candidateCount: 1,
    temperature: 0.2,
    topP: 1,
    systemInstruction,
    // only add tools when you *don't* have a schema
    ...(!responseSchema && { tools: [{ googleSearch: {} }] }),
  };

  if (responseSchema) {
    // only add these when you *do* have a schema
    config.responseMimeType = "application/json";
    config.responseSchema = responseSchema();
  }

  const modelInput = {
    model: modelName,
    contents: inputString,
    config,
  };

  while (attempt < maxRetries) {
    try {
      // FIX: Add timeout protection to prevent hanging forever
      const result = await Promise.race([
        ai.models.generateContent(modelInput),
        createTimeoutPromise(
          VERTEX_AI_TIMEOUT_MS,
          `Vertex AI generateContent (attempt ${attempt + 1})`
        ),
      ]);
      return { result, modelConfig: config };
    } catch (err) {
      const errorCode =
        err.code ||
        (err.response &&
          err.response.data &&
          err.response.data.error &&
          err.response.data.error.code);

      // Check if it's a timeout error
      const isTimeout = err.message && err.message.includes("timed out");

      if (errorCode === 429 || isTimeout) {
        attempt++;
        const reason = isTimeout ? "timeout" : "429";
        console.log(
          `Vertex AI call returned ${reason}. Retrying attempt ${attempt} after ${delay}ms...`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 2; // exponential backoff
        continue;
      } else {
        throw err;
      }
    }
  }
  throw new Error("Max retries exceeded for Vertex AI call");
}

/**
 * Function: vertexAIExtraction
 * Configures the Vertex AI model and processes the extraction response.
 */
async function vertexAIExtraction(
  inputString,
  systemInstruction,
  responseSchema,
  processName
) {
  let success = true;
  let groundingUsed = false;
  try {
    const modelName = "gemini-2.5-flash";
    const { result, modelConfig: rawModel } = await vertexAICall(
      modelName,
      systemInstruction,
      inputString,
      responseSchema
    );

    console.log(JSON.stringify(result));

    let output = null;
    if (
      result &&
      Array.isArray(result.candidates) &&
      result.candidates.length > 0 &&
      result.candidates[0].content &&
      Array.isArray(result.candidates[0].content.parts) &&
      result.candidates[0].content.parts.length > 0 &&
      result.candidates[0].content.parts[0].text
    ) {
      if (result.candidates[0].groundingMetadata) {
        groundingUsed = true;
      }
      const fullText = result.candidates[0].content.parts
        .map((p) => p.text)
        .join("");
      try {
        if (responseSchema) {
          try {
            output = JSON.parse(fullText);
          } catch (err) {
            console.warn(
              "Direct JSON.parse failed, falling back to snip:",
              err
            );
            output = extractJsonObject(fullText);
          }
        } else {
          output = extractJsonObject(fullText);
        }
      } catch (parseErr) {
        console.error("Error parsing Vertex AI response:", parseErr);
        output = extractJsonObject(fullText);
      }
      console.log("Vertex AI Response:", output);
    } else {
      console.log("No candidates returned from Vertex AI for extraction.");
      output = {};
      success = false;
    }

    await db
      .collection("vertexAIRuns")
      .doc()
      .set({
        process: processName,
        modelName: modelName,
        systemInstructions: systemInstruction,
        responseSchema: JSON.stringify(responseSchema ? responseSchema() : {}),
        groundingRequested: !responseSchema,
        groundingUsed,
        rawModel: JSON.stringify(rawModel),
        rawResult: JSON.stringify(result),
        output: JSON.stringify(output),
        success,
      });
    return output;
  } catch (err) {
    console.error("Error calling Vertex AI for extraction:", err);
    return null;
  }
}

export { vertexAIExtraction };
