import { ConduitRequestError, ConduitResponseError, ConduitTimeoutError } from "./errors.js";
import { JsonObject, normalizeConduitResponse } from "./parsing.js";

const DEFAULT_CONDUIT_URI = process.env.PHAB_CONDUIT_URI ?? "https://phab.instahyre.com/";
const DEFAULT_TIMEOUT_MS = Number.parseInt(process.env.PHAB_ARC_TIMEOUT_MS ?? "30000", 10);
const DEFAULT_API_TOKEN =
  process.env.PHAB_API_TOKEN ?? process.env.CONDUIT_TOKEN ?? process.env.PHAB_CONDUIT_TOKEN;

export interface ConduitCallOptions {
  conduitUri?: string;
  timeoutMs?: number;
  apiToken?: string;
}

export async function callConduit(
  method: string,
  payload: JsonObject,
  options: ConduitCallOptions = {}
): Promise<JsonObject> {
  if (!method.trim()) {
    throw new ConduitResponseError("Conduit method name is required.");
  }

  const conduitUri = options.conduitUri ?? DEFAULT_CONDUIT_URI;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const apiToken = options.apiToken ?? DEFAULT_API_TOKEN;

  if (typeof apiToken !== "string" || apiToken.trim().length === 0) {
    throw new ConduitRequestError(
      "PHAB_API_TOKEN (or CONDUIT_TOKEN / PHAB_CONDUIT_TOKEN) is required for Conduit API access."
    );
  }

  return callConduitViaApi(method, payload, conduitUri, apiToken.trim(), timeoutMs);
}

async function callConduitViaApi(
  method: string,
  payload: JsonObject,
  conduitUri: string,
  apiToken: string,
  timeoutMs: number
): Promise<JsonObject> {
  const endpoint = buildConduitApiUrl(conduitUri, method);
  const body = new URLSearchParams();
  const paramsWithConduitToken: JsonObject = {
    ...payload,
    __conduit__: {
      token: apiToken
    }
  };
  body.set("api.token", apiToken);
  body.set("params", JSON.stringify(paramsWithConduitToken));

  const abortController = new AbortController();
  const timer = setTimeout(() => {
    abortController.abort();
  }, timeoutMs);

  let responseText = "";
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded"
      },
      body: body.toString(),
      signal: abortController.signal
    });

    responseText = await response.text();
    if (!response.ok) {
      const preview = responseText.length > 200 ? `${responseText.slice(0, 200)}...` : responseText;
      throw new ConduitRequestError(
        `Conduit API request failed with status ${response.status} for method '${method}'. Body: ${preview}`
      );
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new ConduitTimeoutError(
        `Conduit API request timed out after ${timeoutMs}ms for method '${method}'.`
      );
    }
    if (error instanceof ConduitRequestError || error instanceof ConduitTimeoutError) {
      throw error;
    }
    throw new ConduitRequestError(
      `Failed to call Conduit API for method '${method}': ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    clearTimeout(timer);
  }

  if (!responseText.trim()) {
    throw new ConduitResponseError("Conduit API returned empty response; expected JSON.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch (error) {
    const preview = responseText.length > 200 ? `${responseText.slice(0, 200)}...` : responseText;
    throw new ConduitResponseError(
      `Conduit API returned invalid JSON for method '${method}': ${(error as Error).message}. Output: ${preview}`
    );
  }

  return normalizeConduitResponse(parsed);
}

function buildConduitApiUrl(conduitUri: string, method: string): string {
  const base = conduitUri.replace(/\/+$/, "");
  return `${base}/api/${method}`;
}
