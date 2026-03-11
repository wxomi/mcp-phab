import { callConduit } from "./conduit.js";
import { ConduitApiError } from "./errors.js";
import { InputValidationError } from "./errors.js";
import { extractChangedFilesFromRawDiff, extractTaskIdsFromText, extractTextValue, extractRevisionSummary, extractSearchData, extractTaskSummary, isJsonObject, parseRevisionId, parseTaskId } from "./parsing.js";
const DEFAULT_REVISION_STATUSES = ["needs-review", "needs-revision", "accepted"];
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const DEFAULT_MAX_DRAFT_COMMENTS = 50;
export async function phab_whoami() {
    const response = await callConduit("user.whoami", {});
    const username = asString(response.userName) ?? asString(response.username);
    const realName = asString(response.realName);
    const phid = asString(response.phid);
    if (!username || !realName || !phid) {
        throw new InputValidationError("user.whoami response missing username, realName, or phid.");
    }
    return { username, realName, phid };
}
export async function phab_list_my_open_revisions(statuses, limit) {
    const whoami = await phab_whoami();
    const effectiveStatuses = normalizeStatuses(statuses);
    const effectiveLimit = normalizeLimit(limit);
    const response = await callConduit("differential.revision.search", {
        constraints: {
            authorPHIDs: [whoami.phid],
            statuses: effectiveStatuses
        },
        order: "newest",
        limit: effectiveLimit
    });
    const revisions = extractSearchData(response).map(extractRevisionSummary);
    return {
        authorPHID: whoami.phid,
        statuses: effectiveStatuses,
        revisions
    };
}
export async function phab_is_revision_accepted(revision_id) {
    const revisionId = parseRevisionId(revision_id);
    const response = await callConduit("differential.revision.search", {
        constraints: {
            ids: [revisionId]
        },
        attachments: {
            diffs: true
        },
        limit: 1
    });
    const data = extractSearchData(response);
    const first = data[0];
    if (!first) {
        return {
            revisionId,
            found: false,
            accepted: false,
            status: null
        };
    }
    const summary = extractRevisionSummary(first);
    const accepted = summary.status.value === "accepted";
    return {
        revisionId,
        found: true,
        accepted,
        status: summary.status
    };
}
export async function phab_get_task(task_id) {
    const numericTaskId = parseTaskId(task_id);
    const response = await callConduit("maniphest.search", {
        constraints: {
            ids: [numericTaskId]
        },
        limit: 1
    });
    const data = extractSearchData(response);
    const first = data[0];
    if (!first) {
        return {
            taskId: `T${numericTaskId}`,
            found: false
        };
    }
    const task = extractTaskSummary(first);
    return {
        taskId: `T${numericTaskId}`,
        found: true,
        title: task.title,
        description: task.description,
        status: task.status,
    };
}
export async function phab_get_revision_context(revision_id, resolve_tasks = true, include_changes = true) {
    const revisionId = parseRevisionId(revision_id);
    const response = await callConduit("differential.revision.search", {
        constraints: {
            ids: [revisionId]
        },
        attachments: {
            diffs: true
        },
        limit: 1
    });
    const data = extractSearchData(response);
    const first = data[0];
    if (!first) {
        return {
            revisionId: `D${revisionId}`,
            found: false,
            referencedTaskIds: []
        };
    }
    const revision = extractRevisionSummary(first);
    const fields = isJsonObject(first.fields) ? first.fields : {};
    const attachments = isJsonObject(first.attachments) ? first.attachments : {};
    const diffsAttachment = isJsonObject(attachments.diffs) ? attachments.diffs : {};
    const summary = extractTextValue(fields.summary);
    const diffPHID = asString(fields.diffPHID);
    const diffPHIDs = collectDiffPHIDs(diffPHID, diffsAttachment);
    const initialDiffIDs = collectDiffIDs(fields, diffsAttachment);
    const resolvedDiffIDs = await fetchDiffIdsFromPhids(diffPHIDs);
    const diffIDs = mergeDiffIDs(initialDiffIDs, resolvedDiffIDs);
    const referencedTaskIds = extractTaskIdsFromText(revision.title, summary);
    let changedFiles = null;
    let rawDiff = null;
    let changesWarning = null;
    if (include_changes) {
        const changes = await fetchChangedFiles(diffPHIDs, diffIDs);
        changedFiles = changes.files;
        rawDiff = changes.rawDiff;
        changesWarning = changes.warning;
    }
    const referencedTasks = resolve_tasks
        ? await Promise.all(referencedTaskIds.map((taskId) => phab_get_task(taskId)))
        : null;
    const result = {
        revisionId: `D${revisionId}`,
        found: true,
        title: revision.title,
        summary,
        uri: revision.uri,
        diffPHID,
        status: revision.status,
        referencedTaskIds
    };
    if (changedFiles) {
        result.changedFiles = changedFiles;
    }
    if (rawDiff) {
        result.rawDiff = rawDiff;
    }
    if (changesWarning) {
        result.changesWarning = changesWarning;
    }
    if (referencedTasks) {
        result.referencedTasks = referencedTasks;
    }
    return result;
}
export async function phab_add_draft_inline_comments(revision_id, reviewInput, options = {}) {
    const revisionId = parseRevisionId(revision_id);
    const isNewFile = options.is_new_file ?? true;
    const includeTitle = options.include_title ?? true;
    const maxComments = normalizeMaxComments(options.max_comments);
    const findings = normalizeDraftReviewFindings(reviewInput).slice(0, maxComments);
    console.error(`[phab_add_draft_inline_comments] start revision=D${revisionId} isNewFile=${isNewFile} includeTitle=${includeTitle} maxComments=${maxComments} findings=${findings.length}`);
    const diffId = await fetchLatestDiffIdForRevision(revisionId);
    const changedFiles = await fetchChangedFilesFromSingleDiff(diffId);
    console.error(`[phab_add_draft_inline_comments] resolved diffID=${diffId} changedFiles=${changedFiles.length}`);
    if (changedFiles.length > 0) {
        console.error(`[phab_add_draft_inline_comments] changedFiles sample=${changedFiles.slice(0, 20).join(", ")}`);
    }
    const results = [];
    for (const [index, finding] of findings.entries()) {
        const lineStart = finding.code_location.line_range.start;
        const lineEnd = finding.code_location.line_range.end ?? lineStart;
        const lineLength = Math.max(1, lineEnd - lineStart + 1);
        const title = finding.title;
        const filePath = resolveInlineFilePath(finding.code_location.absolute_file_path, changedFiles);
        console.error(`[phab_add_draft_inline_comments] finding#${index} sourcePath=${finding.code_location.absolute_file_path} mappedPath=${filePath ?? "null"} lineStart=${lineStart} lineEnd=${lineEnd} lineLength=${lineLength} title=${JSON.stringify(title)}`);
        if (!filePath) {
            results.push({
                index,
                ok: false,
                reason: "could not map absolute_file_path to a changed file in this diff",
                title
            });
            continue;
        }
        const content = buildInlineCommentContent(finding, includeTitle);
        try {
            console.error(`[phab_add_draft_inline_comments] createinline finding#${index} revisionID=${revisionId} diffID=${diffId} filePath=${filePath} isNewFile=${isNewFile} lineNumber=${lineStart} lineLength=${lineLength} contentLength=${content.length}`);
            await callConduit("differential.createinline", {
                revisionID: revisionId,
                diffID: diffId,
                filePath,
                isNewFile,
                lineNumber: lineStart,
                lineLength,
                content
            });
            results.push({
                index,
                ok: true,
                filePath,
                lineNumber: lineStart,
                lineLength,
                title
            });
            console.error(`[phab_add_draft_inline_comments] success finding#${index} filePath=${filePath} lineNumber=${lineStart} lineLength=${lineLength}`);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            results.push({
                index,
                ok: false,
                reason: message,
                filePath,
                lineNumber: lineStart,
                lineLength,
                title
            });
            console.error(`[phab_add_draft_inline_comments] failure finding#${index} filePath=${filePath} lineNumber=${lineStart} lineLength=${lineLength} error=${message}`);
        }
    }
    const createdCount = results.filter((entry) => entry.ok).length;
    console.error(`[phab_add_draft_inline_comments] done revision=D${revisionId} diffID=${diffId} created=${createdCount} skipped=${results.length - createdCount}`);
    return {
        revisionId: `D${revisionId}`,
        diffId,
        isNewFile,
        changedFiles,
        createdCount,
        skippedCount: results.length - createdCount,
        results
    };
}
async function fetchChangedFiles(diffPHIDs, diffIDs) {
    const warnings = [];
    const resolvedDiffIDs = mergeDiffIDs(await fetchDiffIdsFromPhids(diffPHIDs), diffIDs);
    if (resolvedDiffIDs.length > 0) {
        try {
            const fromRawDiff = await fetchRawDiffChanges(resolvedDiffIDs);
            if (fromRawDiff.files.length > 0 || fromRawDiff.rawDiff.length > 0) {
                return { files: fromRawDiff.files, rawDiff: fromRawDiff.rawDiff, warning: null };
            }
            warnings.push(`rawdiff parsing returned 0 files for diffs [${resolvedDiffIDs.join(", ")}]`);
        }
        catch (error) {
            warnings.push(`rawdiff lookup failed: ${buildRawDiffWarning(error)}`);
        }
    }
    else {
        warnings.push("could not resolve numeric diff IDs from revision diffPHID");
    }
    if (diffPHIDs.length === 0) {
        warnings.push("revision search did not include diffPHID");
    }
    return {
        files: [],
        rawDiff: null,
        warning: warnings.join("; ")
    };
}
async function fetchRawDiffChanges(diffIDs) {
    const files = [];
    const seen = new Set();
    const rawDiffChunks = [];
    for (const diffID of diffIDs) {
        const response = await callConduit("differential.getrawdiff", {
            diffID
        });
        const rawDiff = asString(response.response) ?? asString(response.rawDiff) ?? asString(response.diff) ?? "";
        if (!rawDiff) {
            continue;
        }
        rawDiffChunks.push(rawDiff);
        for (const path of extractChangedFilesFromRawDiff(rawDiff)) {
            if (!seen.has(path)) {
                seen.add(path);
                files.push(path);
            }
        }
    }
    return {
        files,
        rawDiff: rawDiffChunks.join("\n")
    };
}
function buildRawDiffWarning(error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof ConduitApiError) {
        return `Could not fetch changed files from raw diff API: ${message}`;
    }
    return `Could not fetch changed files from raw diff: ${message}`;
}
function normalizeStatuses(statuses) {
    if (!statuses || statuses.length === 0) {
        return [...DEFAULT_REVISION_STATUSES];
    }
    const cleaned = statuses
        .map((status) => status.trim())
        .filter((status) => status.length > 0);
    if (cleaned.length === 0) {
        return [...DEFAULT_REVISION_STATUSES];
    }
    return cleaned;
}
function normalizeLimit(limit) {
    if (limit === undefined || limit === null) {
        return DEFAULT_LIMIT;
    }
    if (!Number.isInteger(limit) || limit <= 0) {
        throw new InputValidationError("limit must be a positive integer.");
    }
    return Math.min(limit, MAX_LIMIT);
}
function normalizeMaxComments(max_comments) {
    if (max_comments === undefined || max_comments === null) {
        return DEFAULT_MAX_DRAFT_COMMENTS;
    }
    if (!Number.isInteger(max_comments) || max_comments <= 0) {
        throw new InputValidationError("max_comments must be a positive integer.");
    }
    return max_comments;
}
function normalizeDraftReviewFindings(input) {
    const container = parseReviewInputContainer(input);
    const rawFindings = container.findings;
    if (!Array.isArray(rawFindings) || rawFindings.length === 0) {
        throw new InputValidationError("review findings are required.");
    }
    const findings = [];
    for (const rawFinding of rawFindings) {
        if (!isJsonObject(rawFinding)) {
            continue;
        }
        const title = asString(rawFinding.title);
        const body = asString(rawFinding.body);
        const codeLocation = isJsonObject(rawFinding.code_location) ? rawFinding.code_location : null;
        const absoluteFilePath = codeLocation ? asString(codeLocation.absolute_file_path) : null;
        const lineRange = codeLocation && isJsonObject(codeLocation.line_range) ? codeLocation.line_range : null;
        const start = lineRange ? asPositiveInteger(lineRange.start) : null;
        const end = lineRange ? asPositiveInteger(lineRange.end) : null;
        if (!title || !body || !absoluteFilePath || !start) {
            continue;
        }
        findings.push({
            title,
            body,
            code_location: {
                absolute_file_path: absoluteFilePath,
                line_range: {
                    start,
                    ...(end ? { end } : {})
                }
            }
        });
    }
    if (findings.length === 0) {
        throw new InputValidationError("no valid findings with code_location were provided.");
    }
    return findings;
}
function parseReviewInputContainer(input) {
    if (typeof input === "string") {
        try {
            const parsed = JSON.parse(input);
            if (isJsonObject(parsed)) {
                return parsed;
            }
        }
        catch {
            throw new InputValidationError("review_json must be valid JSON.");
        }
        throw new InputValidationError("review_json must be a JSON object.");
    }
    if (Array.isArray(input)) {
        return { findings: input };
    }
    if (isJsonObject(input)) {
        return input;
    }
    throw new InputValidationError("review_json/findings input is invalid.");
}
function asPositiveInteger(value) {
    if (typeof value === "number") {
        if (!Number.isInteger(value) || value <= 0) {
            return null;
        }
        return value;
    }
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (!/^\d+$/.test(trimmed)) {
            return null;
        }
        const parsed = Number.parseInt(trimmed, 10);
        if (!Number.isInteger(parsed) || parsed <= 0) {
            return null;
        }
        return parsed;
    }
    return null;
}
async function fetchLatestDiffIdForRevision(revisionId) {
    const response = await callConduit("differential.querydiffs", {
        revisionIDs: [revisionId]
    });
    const diffIDs = extractDiffIdsFromQueryDiffsResponse(response);
    const latest = diffIDs.sort((a, b) => a - b).at(-1);
    if (!latest) {
        throw new InputValidationError(`no diffs found for D${revisionId}.`);
    }
    return latest;
}
function extractDiffIdsFromQueryDiffsResponse(response) {
    const ids = new Set();
    const candidates = [];
    for (const value of Object.values(response)) {
        candidates.push(value);
    }
    for (const item of candidates) {
        if (!isJsonObject(item)) {
            continue;
        }
        const id = asPositiveInteger(item.id);
        if (id) {
            ids.add(id);
        }
    }
    return Array.from(ids);
}
async function fetchChangedFilesFromSingleDiff(diffId) {
    const rawDiffResponse = await callConduit("differential.getrawdiff", {
        diffID: diffId
    });
    const rawDiff = asString(rawDiffResponse.response) ?? asString(rawDiffResponse.rawDiff) ?? asString(rawDiffResponse.diff) ?? "";
    if (!rawDiff) {
        return [];
    }
    return extractChangedFilesFromRawDiff(rawDiff);
}
function resolveInlineFilePath(inputPath, changedFiles) {
    const normalized = normalizeFilePath(inputPath);
    if (!normalized) {
        return null;
    }
    if (changedFiles.includes(normalized)) {
        return normalized;
    }
    const withoutLeadingSlash = normalized.replace(/^\/+/, "");
    if (changedFiles.includes(withoutLeadingSlash)) {
        return withoutLeadingSlash;
    }
    const suffixMatches = changedFiles.filter((path) => normalized === path ||
        normalized.endsWith(`/${path}`) ||
        withoutLeadingSlash.endsWith(`/${path}`) ||
        withoutLeadingSlash.endsWith(path));
    if (suffixMatches.length === 1) {
        return suffixMatches[0] ?? null;
    }
    if (suffixMatches.length > 1) {
        const sorted = suffixMatches.sort((a, b) => b.length - a.length);
        return sorted[0] ?? null;
    }
    return changedFiles.length === 0 ? withoutLeadingSlash : null;
}
function normalizeFilePath(path) {
    return path.trim().replace(/\\/g, "/");
}
function buildInlineCommentContent(finding, includeTitle) {
    if (includeTitle) {
        return `${finding.title}\n\n${finding.body}`;
    }
    return finding.body;
}
function asString(value) {
    return typeof value === "string" ? value : null;
}
function asNumberArray(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.filter((entry) => typeof entry === "number" && Number.isInteger(entry) && entry > 0);
}
function asStringArray(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.filter((entry) => typeof entry === "string" && entry.length > 0);
}
function collectDiffPHIDs(diffPHID, diffsAttachment) {
    const phids = new Set();
    if (diffPHID) {
        phids.add(diffPHID);
    }
    for (const phid of asStringArray(diffsAttachment.diffPHIDs)) {
        phids.add(phid);
    }
    return Array.from(phids);
}
function collectDiffIDs(fields, diffsAttachment) {
    const ids = new Set();
    for (const id of asNumberArray(fields.diffs)) {
        ids.add(id);
    }
    for (const id of asNumberArray(diffsAttachment.diffIDs)) {
        ids.add(id);
    }
    return Array.from(ids);
}
function mergeDiffIDs(first, second) {
    const ids = new Set();
    for (const id of first) {
        ids.add(id);
    }
    for (const id of second) {
        ids.add(id);
    }
    return Array.from(ids);
}
async function fetchDiffIdsFromPhids(diffPHIDs) {
    if (diffPHIDs.length === 0) {
        return [];
    }
    try {
        const response = await callConduit("differential.diff.search", {
            constraints: {
                phids: diffPHIDs
            },
            limit: Math.max(10, diffPHIDs.length)
        });
        const ids = new Set();
        for (const item of extractSearchData(response)) {
            const id = item.id;
            if (typeof id === "number" && Number.isInteger(id) && id > 0) {
                ids.add(id);
            }
        }
        return Array.from(ids);
    }
    catch {
        return [];
    }
}
//# sourceMappingURL=tools.js.map