// product-management/shared/httpClient.js

import axios from "axios";
import { acquireToken, report429 } from "./rateLimiter.js";

const DEFAULT_TIMEOUT = 30000;
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000;
const RETRYABLE_ERRORS = [408, 429, 500, 502, 503, 504];

function isValidUrl(url) {
  if (!url || typeof url !== "string") return false;
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

function getRetryDelay(attempt, is429 = false) {
  const base = is429 ? RETRY_DELAY * 4 : RETRY_DELAY;
  const jitter = Math.random() * 500;
  return base * Math.pow(2, attempt) + jitter;
}

function isRetryableError(error) {
  const msg = (error.message || "").toLowerCase();

  const isUrlError =
    msg.includes("invalid url") ||
    msg.includes("invalid uri") ||
    msg.includes("malformed") ||
    error.code === "ERR_INVALID_URL";

  if (isUrlError) {
    return { retryable: false, reason: "invalid_url" };
  }

  if (!error.response) {
    return { retryable: true, reason: "network" };
  }

  if (RETRYABLE_ERRORS.includes(error.response.status)) {
    return { retryable: true, reason: "server_error" };
  }

  return { retryable: false, reason: "client_error" };
}

export async function safeRequest(config, context = {}) {
  const { brandId, barcode, method = "request" } = context;
  const contextStr = `${brandId || "unknown"}/${barcode || "unknown"}`;

  if (!isValidUrl(config.url)) {
    console.error(
      `[${contextStr}] ${method} invalid URL:`,
      JSON.stringify({ value: config.url, type: typeof config.url })
    );
    return {
      success: false,
      error: new Error(`Invalid URL: ${config.url}`),
      isInvalidUrl: true,
    };
  }

  const finalConfig = {
    timeout: DEFAULT_TIMEOUT,
    ...config,
  };

  let lastError;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      // Rate limiter gates the request
      await acquireToken(config.url);

      const response = await axios(finalConfig);
      return { success: true, data: response.data, response };
    } catch (error) {
      lastError = error;
      const status = error.response?.status;
      const errorMsg = error.message || "Unknown error";

      console.error(
        `[${contextStr}] ${method} attempt ${
          attempt + 1
        }/${MAX_RETRIES} failed:`,
        `Status: ${status || "N/A"}, Error: ${errorMsg}`
      );

      // Report 429 to rate limiter for adaptive throttling
      if (status === 429) {
        report429(config.url);
      }

      if (status && status >= 400 && status < 500 && status !== 429) {
        console.log(
          `[${contextStr}] Non-retryable client error ${status}, aborting`
        );
        break;
      }

      const { retryable, reason } = isRetryableError(error);
      if (!retryable) {
        console.log(
          `[${contextStr}] Non-retryable error (${reason}), aborting. URL: ${config.url}`
        );
        break;
      }

      if (attempt < MAX_RETRIES - 1) {
        const delay = getRetryDelay(attempt, status === 429);
        console.log(`[${contextStr}] Retrying after ${Math.round(delay)}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  const status = lastError?.response?.status;
  console.error(
    `[${contextStr}] ${method} failed. Final status: ${status || "N/A"}, URL: ${
      config.url
    }`
  );

  return {
    success: false,
    error: lastError,
    status,
    isNotFound: status === 404,
    isServerError: status >= 500,
  };
}

export async function safeGet(url, options = {}, context = {}) {
  return safeRequest(
    { method: "GET", url, ...options },
    { ...context, method: "GET" }
  );
}

export async function safePost(url, data, options = {}, context = {}) {
  return safeRequest(
    { method: "POST", url, data, ...options },
    { ...context, method: "POST" }
  );
}
