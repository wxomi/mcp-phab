import { ConduitApiError, ConduitResponseError, InputValidationError } from "./errors.js";
export function isJsonObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function normalizeConduitResponse(raw) {
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
export function parseRevisionId(revisionId) {
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
export function parseTaskId(taskId) {
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
export function extractSearchData(response) {
    const data = response.data;
    if (!Array.isArray(data)) {
        return [];
    }
    return data.filter(isJsonObject);
}
export function extractRevisionSummary(item) {
    const fields = isJsonObject(item.fields) ? item.fields : {};
    const statusInput = fields.status;
    const status = {
        value: null,
        name: null
    };
    if (isJsonObject(statusInput)) {
        status.value = typeof statusInput.value === "string" ? statusInput.value : null;
        status.name = typeof statusInput.name === "string" ? statusInput.name : null;
        Object.assign(status, statusInput);
    }
    else if (typeof statusInput === "string") {
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
export function extractTaskSummary(item) {
    const fields = isJsonObject(item.fields) ? item.fields : {};
    return {
        id: toNullableNumber(item.id),
        phid: toNullableString(item.phid),
        title: toNullableString(fields.name),
        description: extractTextValue(fields.description),
        status: fields.status ?? null,
    };
}
export function extractTextValue(value) {
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
export function extractTaskIdsFromText(...texts) {
    const ids = [];
    const seen = new Set();
    for (const text of texts) {
        if (!text) {
            continue;
        }
        const regex = /\bT(\d+)\b/gi;
        let match;
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
export function extractChangedFilesFromRawDiff(rawDiff) {
    const files = [];
    const seen = new Set();
    const lines = rawDiff.split(/\r?\n/);
    for (const line of lines) {
        let path = null;
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
function toNullableNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function toNullableString(value) {
    return typeof value === "string" ? value : null;
}
function stringifyForError(value) {
    if (typeof value === "string") {
        return value;
    }
    try {
        return JSON.stringify(value);
    }
    catch {
        return String(value);
    }
}
//# sourceMappingURL=parsing.js.map