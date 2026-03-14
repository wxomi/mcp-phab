import { ConduitApiError, ConduitResponseError, InputValidationError } from "./errors.js";

export type JsonObject = Record<string, unknown>;

export interface RevisionStatus {
  value: string | null;
  name: string | null;
  [key: string]: unknown;
}

export interface RevisionSummary {
  id: number | null;
  title: string | null;
  uri: string | null;
  status: RevisionStatus;
  dateModified: number | null;
}

export interface TaskSummary {
  id: number | null;
  phid: string | null;
  title: string | null;
  description: string | null;
  status: unknown;
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeConduitResponse(raw: unknown): JsonObject {
  if (!isJsonObject(raw)) {
    throw new ConduitResponseError("Conduit response must be a JSON object.");
  }

  if (raw.error !== null && raw.error !== undefined) {
    throw new ConduitApiError(`Conduit error: ${stringifyForError(raw.error)}`);
  }

  if (raw.error_code !== null && raw.error_code !== undefined) {
    const info = raw.error_info === undefined ? "" : ` (${stringifyForError(raw.error_info)})`;
    throw new ConduitApiError(`Conduit error_code: ${stringifyForError(raw.error_code)}${info}`);
  }

  if (raw.response !== undefined && !isJsonObject(raw.response)) {
    return { response: raw.response };
  }
  if (raw.result !== undefined && !isJsonObject(raw.result)) {
    return { result: raw.result };
  }

  const payload = isJsonObject(raw.response)
    ? raw.response
    : isJsonObject(raw.result)
      ? raw.result
      : raw;

  if (isJsonObject(payload)) {
    return payload;
  }

  throw new ConduitResponseError("Conduit result payload is not an object.");
}

export function parseRevisionId(revisionId: string | number): number {
  if (typeof revisionId === "number") {
    if (Number.isInteger(revisionId) && revisionId > 0) {
      return revisionId;
    }
    throw new InputValidationError("revision_id must be a positive integer.");
  }

  const trimmed = revisionId.trim();
  const match = /^D?(\d+)$/i.exec(trimmed);
  if (!match) {
    throw new InputValidationError("revision_id must be like 123 or D123.");
  }
  const digits = match[1];
  if (!digits) {
    throw new InputValidationError("revision_id must be like 123 or D123.");
  }
  return Number.parseInt(digits, 10);
}

export function parseTaskId(taskId: string): number {
  const trimmed = taskId.trim();
  const match = /^T?(\d+)$/i.exec(trimmed);
  if (!match) {
    throw new InputValidationError("task_id must be like T123 or 123.");
  }
  const digits = match[1];
  if (!digits) {
    throw new InputValidationError("task_id must be like T123 or 123.");
  }
  return Number.parseInt(digits, 10);
}

export function extractSearchData(response: JsonObject): JsonObject[] {
  const data = response.data;
  if (!Array.isArray(data)) {
    return [];
  }
  return data.filter(isJsonObject);
}

export function extractRevisionSummary(item: JsonObject): RevisionSummary {
  const fields = isJsonObject(item.fields) ? item.fields : {};
  const statusInput = fields.status;

  const status: RevisionStatus = {
    value: null,
    name: null
  };
  if (isJsonObject(statusInput)) {
    status.value = typeof statusInput.value === "string" ? statusInput.value : null;
    status.name = typeof statusInput.name === "string" ? statusInput.name : null;
    Object.assign(status, statusInput);
  } else if (typeof statusInput === "string") {
    status.value = statusInput;
    status.name = statusInput;
  }

  return {
    id: toNullableNumber(item.id),
    title: toNullableString(fields.title),
    uri: toNullableString(fields.uri),
    status,
    dateModified: toNullableNumber(fields.dateModified)
  };
}

export function extractTaskSummary(item: JsonObject): TaskSummary {
  const fields = isJsonObject(item.fields) ? item.fields : {};

  return {
    id: toNullableNumber(item.id),
    phid: toNullableString(item.phid),
    title: toNullableString(fields.name),
    description: extractTextValue(fields.description),
    status: fields.status ?? null,
  };
}

export function extractTextValue(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (!isJsonObject(value)) {
    return null;
  }

  const preferredKeys = ["raw", "text", "content"];
  for (const key of preferredKeys) {
    const candidate = value[key];
    if (typeof candidate === "string") {
      return candidate;
    }
  }
  return null;
}

export function extractTaskIdsFromText(...texts: Array<string | null | undefined>): string[] {
  const ids: string[] = [];
  const seen = new Set<number>();

  for (const text of texts) {
    if (!text) {
      continue;
    }
    const regex = /\bT(\d+)\b/gi;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const digits = match[1];
      if (!digits) {
        continue;
      }
      const numeric = Number.parseInt(digits, 10);
      if (!Number.isInteger(numeric) || numeric <= 0 || seen.has(numeric)) {
        continue;
      }
      seen.add(numeric);
      ids.push(`T${numeric}`);
    }
  }

  return ids;
}

export function extractChangedFilesFromRawDiff(rawDiff: string): string[] {
  const files: string[] = [];
  const seen = new Set<string>();
  const lines = rawDiff.split(/\r?\n/);

  for (const line of lines) {
    let path: string | null = null;

    const gitMatch = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (gitMatch) {
      path = gitMatch[2] ?? gitMatch[1] ?? null;
    }

    if (!path) {
      const indexMatch = /^Index:\s+(.+)$/.exec(line);
      if (indexMatch) {
        path = indexMatch[1] ?? null;
      }
    }

    if (!path) {
      const plusMatch = /^\+\+\+\s+b\/(.+)$/.exec(line);
      if (plusMatch) {
        path = plusMatch[1] ?? null;
      }
    }

    if (!path || path === "/dev/null") {
      continue;
    }

    if (!seen.has(path)) {
      seen.add(path);
      files.push(path);
    }
  }

  return files;
}

export interface RawDiffNewFileLine {
  lineNumber: number;
  content: string;
  kind: "context" | "add";
}

export function extractNewFileLinesFromRawDiff(rawDiff: string, filePath: string): RawDiffNewFileLine[] {
  const targetPath = normalizeDiffFilePath(filePath);
  const lines = rawDiff.split(/\r?\n/);
  const results: RawDiffNewFileLine[] = [];
  let inTargetFile = false;
  let inHunk = false;
  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    const diffMatch = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (diffMatch) {
      const currentPath = normalizeDiffFilePath(diffMatch[2] ?? diffMatch[1] ?? "");
      inTargetFile = currentPath === targetPath;
      inHunk = false;
      oldLine = 0;
      newLine = 0;
      continue;
    }

    if (!inTargetFile) {
      continue;
    }

    const hunkMatch = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunkMatch) {
      oldLine = Number.parseInt(hunkMatch[1] ?? "0", 10);
      newLine = Number.parseInt(hunkMatch[2] ?? "0", 10);
      inHunk = true;
      continue;
    }

    if (!inHunk || line === "\\ No newline at end of file") {
      continue;
    }

    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      continue;
    }

    const prefix = line[0];
    const content = line.slice(1);

    if (prefix === " ") {
      results.push({
        lineNumber: newLine,
        content,
        kind: "context"
      });
      oldLine += 1;
      newLine += 1;
      continue;
    }

    if (prefix === "+") {
      results.push({
        lineNumber: newLine,
        content,
        kind: "add"
      });
      newLine += 1;
      continue;
    }

    if (prefix === "-") {
      oldLine += 1;
    }
  }

  return results;
}

export function resolveLineRangeFromRawDiff(
  rawDiff: string,
  filePath: string,
  snippetText: string,
  hintStart?: number
): { start: number; end: number } | null {
  const snippetLines = snippetText.replace(/\r/g, "").split("\n");
  if (snippetLines.length === 0 || snippetLines.every((line) => line.length === 0)) {
    return null;
  }

  const fileLines = extractNewFileLinesFromRawDiff(rawDiff, filePath);
  if (fileLines.length === 0) {
    return null;
  }

  const matches: Array<{ start: number; end: number }> = [];
  for (let index = 0; index <= fileLines.length - snippetLines.length; index += 1) {
    let matched = true;
    for (let offset = 0; offset < snippetLines.length; offset += 1) {
      const fileLine = fileLines[index + offset];
      const snippetLine = snippetLines[offset];
      if (!fileLine || fileLine.content !== snippetLine) {
        matched = false;
        break;
      }
    }
    if (!matched) {
      continue;
    }

    const startLine = fileLines[index]?.lineNumber;
    const endLine = fileLines[index + snippetLines.length - 1]?.lineNumber;
    if (!startLine || !endLine) {
      continue;
    }
    matches.push({
      start: startLine,
      end: endLine
    });
  }

  if (matches.length === 0) {
    return null;
  }

  if (matches.length === 1 || hintStart === undefined) {
    return matches[0] ?? null;
  }

  const sorted = matches.sort((left, right) => {
    const leftDistance = Math.abs(left.start - hintStart);
    const rightDistance = Math.abs(right.start - hintStart);
    if (leftDistance !== rightDistance) {
      return leftDistance - rightDistance;
    }
    return left.start - right.start;
  });

  return sorted[0] ?? null;
}

function normalizeDiffFilePath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/^\/+/, "");
}

function toNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function stringifyForError(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
