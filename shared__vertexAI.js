// product-management/shared/vertexAI.js

import { GoogleGenAI } from "@google/genai";
import { db } from "./firebase.js";

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

// Rate limiting: 200 requests/min → minimum 300ms between requests
const MIN_DELAY = Math.ceil(60000 / 200);

// Timeout for Vertex AI calls
const VERTEX_AI_TIMEOUT_MS = 45000;

// Gemini 3 Flash Preview - optimized for speed and cost
const GEMINI_MODEL = "gemini-3-flash-preview";

// Fixed seed for reproducible outputs
const GENERATION_SEED = 42;

const GEMINI_THINKING_LEVEL = "MINIMAL";

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Extract first JSON object from text string
 * Fallback parser when direct JSON.parse fails
 */
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
 * Create a timeout promise that rejects after specified milliseconds
 */
function createTimeoutPromise(ms, operation = "Vertex AI call") {
  return new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error(`${operation} timed out after ${ms}ms`));
    }, ms);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// VERTEX AI CALL
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Execute Vertex AI generateContent call with retry logic
 *
 * Gemini 3 Flash configuration:
 * - thinkingLevel: MINIMAL (lowest latency, Gemini 3 Flash only)
 * - temperature: 1.0 (recommended for Gemini 3 to avoid looping)
 * - seed: fixed for reproducible outputs
 * - Google Search grounding can now be combined with structured output (Gemini 3 feature)
 *
 * @param {string} modelName - Model identifier
 * @param {string} systemInstruction - System instruction for the model
 * @param {string} inputString - User input content
 * @param {Function|null} responseSchema - Schema function or null for free-form
 * @param {boolean} useGrounding - Whether to enable Google Search grounding
 * @returns {Promise<{result: Object, modelConfig: Object}>}
 */
async function vertexAICall(
  modelName,
  systemInstruction,
  inputString,
  responseSchema,
  useGrounding = false
) {
  const maxRetries = 5;
  let attempt = 0;
  let delay = MIN_DELAY;

  const ai = new GoogleGenAI({
    vertexai: true,
    project: "panabudget",
    location: "global", // Gemini 3 is available globally
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // BUILD GENERATION CONFIG
  // ═══════════════════════════════════════════════════════════════════════════

  const config = {
    candidateCount: 1,
    // Gemini 3: temperature 1.0 recommended to avoid looping issues
    temperature: 1.0,
    topP: 1,
    // Fixed seed for reproducible outputs
    seed: GENERATION_SEED,
    systemInstruction,
    // Gemini 3 Flash: MINIMAL thinking level for lowest latency
    // Options for Flash: MINIMAL, LOW, MEDIUM, HIGH
    thinkingConfig: {
      thinkingLevel: GEMINI_THINKING_LEVEL,
    },
  };

  // Gemini 3 NEW FEATURE: Can combine Google Search grounding WITH structured output!
  // Previously these were mutually exclusive
  if (useGrounding) {
    config.tools = [{ googleSearch: {} }];
  }

  // Add structured output schema if provided
  if (responseSchema) {
    config.responseMimeType = "application/json";
    config.responseSchema = responseSchema();
  }

  const modelInput = {
    model: modelName,
    contents: inputString,
    config,
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // RETRY LOOP
  // ═══════════════════════════════════════════════════════════════════════════

  while (attempt < maxRetries) {
    try {
      const result = await Promise.race([
        ai.models.generateContent(modelInput),
        createTimeoutPromise(
          VERTEX_AI_TIMEOUT_MS,
          `Vertex AI generateContent (attempt ${attempt + 1})`
        ),
      ]);
      return { result, modelConfig: config };
    } catch (err) {
      const errorCode = err.code || err.response?.data?.error?.code;

      const isTimeout = err.message?.includes("timed out");

      if (errorCode === 429 || isTimeout) {
        attempt++;
        const reason = isTimeout ? "timeout" : "429";
        console.log(
          `Vertex AI call returned ${reason}. Retrying attempt ${attempt} after ${delay}ms...`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 2; // Exponential backoff
        continue;
      } else {
        throw err;
      }
    }
  }

  throw new Error("Max retries exceeded for Vertex AI call");
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN EXTRACTION FUNCTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Extract structured data using Vertex AI Gemini 3 Flash
 *
 * Use cases:
 * - Category extraction: responseSchema provided, no grounding needed
 * - Brand detection: no responseSchema, uses Google Search grounding
 *
 * @param {string} inputString - Input text to process
 * @param {string} systemInstruction - System instruction for the model
 * @param {Function|null} responseSchema - Schema function (null for free-form with grounding)
 * @param {string} processName - Name for logging/tracking
 * @returns {Promise<Object|null>} Extracted data or null on error
 */
async function vertexAIExtraction(
  inputString,
  systemInstruction,
  responseSchema,
  processName
) {
  let success = true;
  let groundingUsed = false;

  // Use grounding for brand detection (when no schema is provided)
  // Brand detection needs Google Search to find official brand URLs
  const useGrounding = !responseSchema;

  try {
    const { result, modelConfig: rawModel } = await vertexAICall(
      GEMINI_MODEL,
      systemInstruction,
      inputString,
      responseSchema,
      useGrounding
    );

    console.log(JSON.stringify(result));

    let output = null;

    // ═══════════════════════════════════════════════════════════════════════════
    // PARSE RESPONSE
    // ═══════════════════════════════════════════════════════════════════════════

    if (result?.candidates?.[0]?.content?.parts?.length > 0) {
      // Check if grounding was actually used
      if (result.candidates[0].groundingMetadata) {
        groundingUsed = true;
      }

      // Filter out thinking parts (Gemini 3 includes thought signatures)
      const textParts = result.candidates[0].content.parts.filter(
        (p) => p.text && !p.thought
      );

      if (textParts.length > 0) {
        const fullText = textParts.map((p) => p.text).join("");

        try {
          if (responseSchema) {
            // Structured output mode - expect valid JSON
            try {
              output = JSON.parse(fullText);
            } catch (err) {
              console.warn(
                "Direct JSON.parse failed, falling back to extraction:",
                err
              );
              output = extractJsonObject(fullText);
            }
          } else {
            // Free-form mode (brand detection) - extract JSON from response
            output = extractJsonObject(fullText);
          }
        } catch (parseErr) {
          console.error("Error parsing Vertex AI response:", parseErr);
          output = extractJsonObject(fullText);
        }

        console.log("Vertex AI Response:", output);
      } else {
        console.log("No text parts returned from Vertex AI for extraction.");
        output = {};
        success = false;
      }
    } else {
      console.log("No candidates returned from Vertex AI for extraction.");
      output = {};
      success = false;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // LOG TOKEN USAGE
    // ═══════════════════════════════════════════════════════════════════════════

    if (result?.usageMetadata) {
      console.log("Token usage:", {
        promptTokens: result.usageMetadata.promptTokenCount || 0,
        candidatesTokens: result.usageMetadata.candidatesTokenCount || 0,
        thinkingTokens: result.usageMetadata.thoughtsTokenCount || 0,
        totalTokens: result.usageMetadata.totalTokenCount || 0,
      });
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // SAVE RUN LOG
    // ═══════════════════════════════════════════════════════════════════════════

    await db
      .collection("vertexAIRuns")
      .doc()
      .set({
        process: processName,
        modelName: GEMINI_MODEL,
        systemInstructions: systemInstruction,
        responseSchema: JSON.stringify(responseSchema ? responseSchema() : {}),
        groundingRequested: useGrounding,
        groundingUsed,
        rawModel: JSON.stringify(rawModel),
        rawResult: JSON.stringify(result),
        output: JSON.stringify(output),
        success,
        // Gemini 3 specific metadata
        thinkingLevel: GEMINI_THINKING_LEVEL,
        seed: GENERATION_SEED,
        temperature: 1.0,
      });

    return output;
  } catch (err) {
    console.error("Error calling Vertex AI for extraction:", err);
    return null;
  }
}

export { vertexAIExtraction };
