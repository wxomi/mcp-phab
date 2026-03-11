import { spawn } from "node:child_process";
import { ArcExecutionError, ArcNotFoundError, ArcTimeoutError, ConduitResponseError } from "./errors.js";
import { JsonObject, normalizeConduitResponse } from "./parsing.js";

const DEFAULT_CONDUIT_URI = process.env.PHAB_CONDUIT_URI ?? "https://phab.instahyre.com/";
const DEFAULT_TIMEOUT_MS = Number.parseInt(process.env.PHAB_ARC_TIMEOUT_MS ?? "30000", 10);

export interface ConduitCallOptions {
  conduitUri?: string;
  timeoutMs?: number;
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
