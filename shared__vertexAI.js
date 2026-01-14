// product-management/shared/vertexAI.js

import { GoogleGenAI } from "@google/genai";
import { db } from "./firebase.js";

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const MIN_DELAY = Math.ceil(60000 / 200);
const VERTEX_AI_TIMEOUT_MS = 45000;
const GEMINI_MODEL = "gemini-3-flash-preview";
const GENERATION_SEED = 42;
const GEMINI_THINKING_LEVEL = "LOW";

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

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
    location: "global",
  });

  const config = {
    candidateCount: 1,
    temperature: 1.0,
    topP: 1,
    seed: GENERATION_SEED,
    systemInstruction,
    thinkingConfig: {
      thinkingLevel: GEMINI_THINKING_LEVEL,
    },
    responseMimeType: "application/json",
    responseSchema: responseSchema(),
    tools: [{ googleSearch: {} }],
  };

  const modelInput = {
    model: modelName,
    contents: inputString,
    config,
  };

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
        delay *= 2;
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

export async function vertexAIExtraction(
  inputString,
  systemInstruction,
  responseSchema,
  processName
) {
  if (!responseSchema || typeof responseSchema !== "function") {
    console.error(
      `[${processName}] FATAL: responseSchema is required for structured output.`
    );
    throw new Error(`responseSchema is required for ${processName}.`);
  }

  let success = true;
  let groundingUsed = false;

  try {
    const { result, modelConfig: rawModel } = await vertexAICall(
      GEMINI_MODEL,
      systemInstruction,
      inputString,
      responseSchema
    );

    console.log(JSON.stringify(result));

    let output = null;

    if (result?.candidates?.[0]?.content?.parts?.length > 0) {
      if (result.candidates[0].groundingMetadata) {
        groundingUsed = true;
        console.log(
          `[${processName}] Grounding metadata:`,
          JSON.stringify(result.candidates[0].groundingMetadata)
        );
      }

      const textParts = result.candidates[0].content.parts.filter(
        (p) => p.text && !p.thought
      );

      if (textParts.length > 0) {
        const fullText = textParts.map((p) => p.text).join("");

        try {
          output = JSON.parse(fullText);
        } catch (parseErr) {
          console.error(
            `[${processName}] JSON parse failed:`,
            parseErr.message,
            `Raw: ${fullText.substring(0, 200)}`
          );
          success = false;
          output = null;
        }

        console.log(`[${processName}] Response:`, output);
      } else {
        console.log(`[${processName}] No text parts returned.`);
        success = false;
      }
    } else {
      console.log(`[${processName}] No candidates returned.`);
      success = false;
    }

    if (result?.usageMetadata) {
      console.log(`[${processName}] Tokens:`, {
        prompt: result.usageMetadata.promptTokenCount || 0,
        candidates: result.usageMetadata.candidatesTokenCount || 0,
        thinking: result.usageMetadata.thoughtsTokenCount || 0,
        total: result.usageMetadata.totalTokenCount || 0,
      });
    }

    await db
      .collection("vertexAIRuns")
      .doc()
      .set({
        process: processName,
        modelName: GEMINI_MODEL,
        systemInstructions: systemInstruction,
        responseSchema: JSON.stringify(responseSchema()),
        groundingUsed,
        rawModel: JSON.stringify(rawModel),
        rawResult: JSON.stringify(result),
        output: JSON.stringify(output),
        success,
        thinkingLevel: GEMINI_THINKING_LEVEL,
        seed: GENERATION_SEED,
        temperature: 1.0,
      });

    return output;
  } catch (err) {
    console.error(`[${processName}] Error:`, err);
    return null;
  }
}
