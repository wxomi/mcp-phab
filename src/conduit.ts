import { spawn } from "node:child_process";
import { ArcExecutionError, ArcNotFoundError, ArcTimeoutError, ConduitResponseError } from "./errors.js";
import { JsonObject, normalizeConduitResponse } from "./parsing.js";

const DEFAULT_CONDUIT_URI = process.env.PHAB_CONDUIT_URI ?? "https://phab.instahyre.com/";
const DEFAULT_TIMEOUT_MS = Number.parseInt(process.env.PHAB_ARC_TIMEOUT_MS ?? "30000", 10);
const DEFAULT_API_TOKEN = process.env.PHAB_API_TOKEN;

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

  if (typeof apiToken === "string" && apiToken.trim().length > 0) {
    return callConduitViaApi(method, payload, conduitUri, apiToken.trim(), timeoutMs);
  }

  return callConduitViaArc(method, payload, conduitUri, timeoutMs);
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
  body.set("api.token", apiToken);
  body.set("params", JSON.stringify(payload));

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
      throw new ArcExecutionError(
        `Conduit API request failed with status ${response.status} for method '${method}'. Body: ${preview}`
      );
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new ArcTimeoutError(
        `Conduit API request timed out after ${timeoutMs}ms for method '${method}'.`
      );
    }
    if (error instanceof ArcExecutionError || error instanceof ArcTimeoutError) {
      throw error;
    }
    throw new ArcExecutionError(
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

function callConduitViaArc(
  method: string,
  payload: JsonObject,
  conduitUri: string,
  timeoutMs: number
): Promise<JsonObject> {
  return new Promise((resolve, reject) => {
    const args = ["call-conduit", "--conduit-uri", conduitUri, "--", method];
    const child = spawn("arc", args, {
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      reject(
        new ArcTimeoutError(
          `arc call-conduit timed out after ${timeoutMs}ms for method '${method}'.`
        )
      );
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        reject(
          new ArcNotFoundError(
            "Could not find 'arc' on PATH. Install Arcanist and ensure it is configured and authenticated."
          )
        );
        return;
      }
      reject(new ArcExecutionError(`Failed to execute arc: ${error.message}`));
    });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        return;
      }

      if (code !== 0) {
        const errText = stderr.trim() || stdout.trim() || "No output from arc.";
        reject(new ArcExecutionError(`arc exited with code ${code}: ${errText}`));
        return;
      }

      const rawText = stdout.trim();
      if (!rawText) {
        reject(new ConduitResponseError("arc returned empty stdout; expected JSON."));
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(rawText);
      } catch (error) {
        const preview = rawText.length > 200 ? `${rawText.slice(0, 200)}...` : rawText;
        reject(
          new ConduitResponseError(
            `arc returned invalid JSON for method '${method}': ${(error as Error).message}. Output: ${preview}`
          )
        );
        return;
      }

      try {
        resolve(normalizeConduitResponse(parsed));
      } catch (error) {
        reject(error);
      }
    });

    try {
      child.stdin.write(JSON.stringify(payload));
      child.stdin.end();
    } catch (error) {
      clearTimeout(timer);
      reject(new ArcExecutionError(`Failed writing JSON payload to arc stdin: ${(error as Error).message}`));
    }
  });
}

function buildConduitApiUrl(conduitUri: string, method: string): string {
  const base = conduitUri.replace(/\/+$/, "");
  return `${base}/api/${method}`;
}
