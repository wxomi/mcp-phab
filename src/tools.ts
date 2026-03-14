import { callConduit } from "./conduit.js";
import { ConduitApiError } from "./errors.js";
import { InputValidationError } from "./errors.js";
import {
  extractChangedFilesFromRawDiff,
  resolveLineRangeFromRawDiff,
  extractTaskIdsFromText,
  extractTextValue,
  extractRevisionSummary,
  extractSearchData,
  extractTaskSummary,
  isJsonObject,
  parseRevisionId,
  parseTaskId
} from "./parsing.js";

const DEFAULT_MAX_DRAFT_COMMENTS = 50;

interface DraftReviewCodeLocation {
  absolute_file_path: string;
  line_range?: {
    start: number;
    end?: number;
  };
  line_text?: string;
}

interface DraftReviewFinding {
  title: string;
  body: string;
  code_location: DraftReviewCodeLocation;
}

interface TaskHierarchySummary {
  taskId: string;
  found: boolean;
  title?: string | null;
  description?: string | null;
  status?: unknown;
}

interface ResolvedTaskResult {
  taskId: string;
  found: boolean;
  title?: string | null;
  description?: string | null;
  status?: unknown;
  mentionedTaskIds?: string[];
  parentTaskId?: string | null;
  parentTask?: TaskHierarchySummary | null;
  parentTasks?: TaskHierarchySummary[];
  hierarchy?: TaskHierarchySummary[];
}

export async function phab_get_task(task_id: string): Promise<ResolvedTaskResult> {
  const numericTaskId = parseTaskId(task_id);
  const task = await fetchTaskRecord({
    ids: [numericTaskId]
  });
  if (!task) {
    return {
      taskId: `T${numericTaskId}`,
      found: false
    };
  }

  const parentTasks = task.phid ? await fetchParentTaskChain(task.phid) : [];
  const parentTask = parentTasks[0] ?? null;
  const mentionedTaskIds = extractTaskIdsFromText(task.title, task.description).filter(
    (candidate) => candidate !== `T${numericTaskId}`
  );
  return {
    taskId: `T${numericTaskId}`,
    found: true,
    title: task.title,
    description: task.description,
    status: task.status,
    ...(mentionedTaskIds.length > 0 ? { mentionedTaskIds } : {}),
    ...(parentTask?.taskId ? { parentTaskId: parentTask.taskId } : {}),
    ...(parentTask ? { parentTask } : {}),
    ...(parentTasks.length > 0 ? { parentTasks } : {}),
    hierarchy: [
      ...parentTasks.slice().reverse(),
      {
        taskId: `T${numericTaskId}`,
        found: true,
        title: task.title,
        description: task.description,
        status: task.status
      }
    ]
  };
}

export async function phab_get_revision_context(
  revision_id: string | number,
  resolve_tasks = true,
  include_changes = true
): Promise<{
  revisionId: string;
  directReferencedTaskIds: string[];
  title?: string | null;
  summary?: string | null;
  referencedTaskIds: string[];
  changedFiles?: string[];
  rawDiff?: string;
  referencedTasks?: ResolvedTaskResult[];
}> {
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
      directReferencedTaskIds: [],
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
  const directReferencedTaskIds = extractTaskIdsFromText(revision.title, summary);
  let changedFiles: string[] | null = null;
  let rawDiff: string | null = null;
  let changesWarning: string | null = null;
  if (include_changes) {
    const changes = await fetchChangedFiles(diffPHIDs, diffIDs);
    changedFiles = changes.files;
    rawDiff = changes.rawDiff;
    changesWarning = changes.warning;
  }
  const taskGraph = resolve_tasks
    ? await resolveReferencedTasksRecursive(directReferencedTaskIds)
    : null;
  const referencedTaskIds = taskGraph ? taskGraph.taskIds : directReferencedTaskIds;
  const referencedTasks = taskGraph ? taskGraph.tasks : null;

  const result: {
    revisionId: string;
    directReferencedTaskIds: string[];
    title?: string | null;
    summary?: string | null;
    referencedTaskIds: string[];
    changedFiles?: string[];
    rawDiff?: string;
    changesWarning?: string;
    referencedTasks?: ResolvedTaskResult[];
  } = {
    revisionId: `D${revisionId}`,
    title: revision.title,
    summary,
    directReferencedTaskIds,
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

async function resolveReferencedTasksRecursive(initialTaskIds: string[]): Promise<{
  taskIds: string[];
  tasks: ResolvedTaskResult[];
}> {
  const queue = [...initialTaskIds];
  const enqueued = new Set<string>(initialTaskIds);
  const resolvedOrder: string[] = [];
  const resolvedTasks = new Map<string, ResolvedTaskResult>();

  while (queue.length > 0) {
    const currentTaskId = queue.shift();
    if (!currentTaskId || resolvedTasks.has(currentTaskId)) {
      continue;
    }

    const task = await phab_get_task(currentTaskId);
    resolvedTasks.set(currentTaskId, task);
    resolvedOrder.push(currentTaskId);

    const relatedTaskIds = [
      ...(task.mentionedTaskIds ?? []),
      ...((task.parentTasks ?? []).map((parent) => parent.taskId))
    ];

    for (const relatedTaskId of relatedTaskIds) {
      if (resolvedTasks.has(relatedTaskId) || enqueued.has(relatedTaskId)) {
        continue;
      }
      enqueued.add(relatedTaskId);
      queue.push(relatedTaskId);
    }
  }

  return {
    taskIds: resolvedOrder,
    tasks: resolvedOrder
      .map((taskId) => resolvedTasks.get(taskId))
      .filter((task): task is ResolvedTaskResult => task !== undefined)
  };
}

async function fetchTaskRecord(constraints: Record<string, unknown>): Promise<ReturnType<typeof extractTaskSummary> | null> {
  const response = await callConduit("maniphest.search", {
    constraints,
    limit: 1
  });

  const data = extractSearchData(response);
  const first = data[0];
  if (!first) {
    return null;
  }

  return extractTaskSummary(first);
}

async function fetchParentTaskChain(taskPhid: string): Promise<TaskHierarchySummary[]> {
  const parentTasks: TaskHierarchySummary[] = [];
  const seenPhids = new Set<string>([taskPhid]);
  let currentPhid: string | null = taskPhid;

  while (currentPhid) {
    const parentPhid = await fetchParentTaskPhid(currentPhid);
    if (!parentPhid || seenPhids.has(parentPhid)) {
      break;
    }

    seenPhids.add(parentPhid);
    const parentTask = await fetchTaskRecord({
      phids: [parentPhid]
    });
    if (!parentTask || !parentTask.id) {
      break;
    }

    parentTasks.push({
      taskId: `T${parentTask.id}`,
      found: true,
      title: parentTask.title,
      description: parentTask.description,
      status: parentTask.status
    });
    currentPhid = parentPhid;
  }

  return parentTasks;
}

async function fetchParentTaskPhid(taskPhid: string): Promise<string | null> {
  try {
    const response = await callConduit("edge.search", {
      sourcePHIDs: [taskPhid],
      types: ["task.parent"],
      limit: 1
    });
    const data = Array.isArray(response.data) ? response.data : [];
    for (const item of data) {
      if (!isJsonObject(item)) {
        continue;
      }
      const destinationPhid = asString(item.destinationPHID);
      if (destinationPhid) {
        return destinationPhid;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export async function phab_add_draft_inline_comments(
  revision_id: string | number,
  reviewInput: unknown,
  options: {
    is_new_file?: boolean;
    include_title?: boolean;
    max_comments?: number;
  } = {}
): Promise<{
  revisionId: string;
  diffId: number;
  isNewFile: boolean;
  changedFiles: string[];
  createdCount: number;
  skippedCount: number;
  results: Array<{
    index: number;
    ok: boolean;
    reason?: string;
    filePath?: string;
    lineNumber?: number;
    lineLength?: number;
    title?: string;
  }>;
}> {
  const revisionId = parseRevisionId(revision_id);
  const isNewFile = options.is_new_file ?? true;
  const includeTitle = options.include_title ?? true;
  const maxComments = normalizeMaxComments(options.max_comments);
  const findings = normalizeDraftReviewFindings(reviewInput).slice(0, maxComments);
  console.error(
    `[phab_add_draft_inline_comments] start revision=D${revisionId} isNewFile=${isNewFile} includeTitle=${includeTitle} maxComments=${maxComments} findings=${findings.length}`
  );
  const diffId = await fetchLatestDiffIdForRevision(revisionId);
  const diffContext = await fetchSingleDiffContext(diffId);
  const changedFiles = diffContext.changedFiles;
  console.error(
    `[phab_add_draft_inline_comments] resolved diffID=${diffId} changedFiles=${changedFiles.length}`
  );
  if (changedFiles.length > 0) {
    console.error(
      `[phab_add_draft_inline_comments] changedFiles sample=${changedFiles.slice(0, 20).join(", ")}`
    );
  }
  const results: Array<{
    index: number;
    ok: boolean;
    reason?: string;
    filePath?: string;
    lineNumber?: number;
    lineLength?: number;
    title?: string;
  }> = [];

  for (const [index, finding] of findings.entries()) {
    const title = finding.title;
    const filePath = resolveInlineFilePath(
      finding.code_location.absolute_file_path,
      changedFiles
    );
    const resolvedLocation = resolveInlineLocation(filePath, finding.code_location, diffContext.rawDiff);
    const lineStart = resolvedLocation?.start ?? null;
    const lineEnd = resolvedLocation?.end ?? null;
    const lineLength = lineStart && lineEnd ? Math.max(1, lineEnd - lineStart + 1) : null;
    console.error(
      `[phab_add_draft_inline_comments] finding#${index} sourcePath=${finding.code_location.absolute_file_path} mappedPath=${filePath ?? "null"} lineStart=${lineStart ?? "null"} lineEnd=${lineEnd ?? "null"} lineLength=${lineLength ?? "null"} title=${JSON.stringify(title)}`
    );

    if (!filePath) {
      const reason =
        changedFiles.length === 0
          ? `could not resolve changed files for diff ${diffId}; refusing to send a non-revision-relative file path`
          : "could not map absolute_file_path to a changed file in this diff";
      results.push({
        index,
        ok: false,
        reason,
        title
      });
      continue;
    }

    if (!lineStart || !lineLength) {
      results.push({
        index,
        ok: false,
        reason: buildMissingLineReason(finding.code_location, filePath),
        filePath,
        title
      });
      continue;
    }

    const content = buildInlineCommentContent(finding, includeTitle);

    try {
      console.error(
        `[phab_add_draft_inline_comments] createinline finding#${index} revisionID=${revisionId} diffID=${diffId} filePath=${filePath} isNewFile=${isNewFile} lineNumber=${lineStart} lineLength=${lineLength} contentLength=${content.length}`
      );
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
      console.error(
        `[phab_add_draft_inline_comments] success finding#${index} filePath=${filePath} lineNumber=${lineStart} lineLength=${lineLength}`
      );
    } catch (error) {
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
      console.error(
        `[phab_add_draft_inline_comments] failure finding#${index} filePath=${filePath} lineNumber=${lineStart} lineLength=${lineLength} error=${message}`
      );
    }
  }

  const createdCount = results.filter((entry) => entry.ok).length;
  console.error(
    `[phab_add_draft_inline_comments] done revision=D${revisionId} diffID=${diffId} created=${createdCount} skipped=${results.length - createdCount}`
  );
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

async function fetchChangedFiles(
  diffPHIDs: string[],
  diffIDs: number[]
): Promise<{ files: string[]; rawDiff: string | null; warning: string | null }> {
  const warnings: string[] = [];
  const resolvedDiffIDs = mergeDiffIDs(await fetchDiffIdsFromPhids(diffPHIDs), diffIDs);
  let files: string[] = [];
  let rawDiff: string | null = null;

  if (diffPHIDs.length > 0) {
    try {
      files = await fetchChangedFilesFromChangesets(diffPHIDs);
      if (files.length === 0) {
        warnings.push("changeset search returned 0 files");
      }
    } catch (error) {
      warnings.push(`changeset lookup failed: ${buildChangesetWarning(error)}`);
    }
  } else {
    warnings.push("revision search did not include diffPHID");
  }

  if (resolvedDiffIDs.length > 0) {
    try {
      const fromRawDiff = await fetchRawDiffChanges(resolvedDiffIDs);
      if (fromRawDiff.files.length > 0 && files.length === 0) {
        files = fromRawDiff.files;
      }
      if (fromRawDiff.rawDiff.length > 0) {
        rawDiff = fromRawDiff.rawDiff;
      } else if (fromRawDiff.files.length === 0) {
        warnings.push(`rawdiff parsing returned 0 files for diffs [${resolvedDiffIDs.join(", ")}]`);
      }
    } catch (error) {
      warnings.push(`rawdiff lookup failed: ${buildRawDiffWarning(error)}`);
    }
  } else {
    warnings.push("could not resolve numeric diff IDs from revision diffPHID");
  }

  return {
    files,
    rawDiff,
    warning: files.length > 0 || rawDiff ? null : warnings.length > 0 ? warnings.join("; ") : null
  };
}

async function fetchRawDiffChanges(diffIDs: number[]): Promise<{ files: string[]; rawDiff: string }> {
  const files: string[] = [];
  const seen = new Set<string>();
  const rawDiffChunks: string[] = [];

  for (const diffID of diffIDs) {
    const response = await callConduit("differential.getrawdiff", {
      diffID
    });

    const rawDiff = extractRawDiffText(response);
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

async function fetchChangedFilesFromChangesets(diffPHIDs: string[]): Promise<string[]> {
  const files: string[] = [];
  const seen = new Set<string>();

  for (const diffPHID of diffPHIDs) {
    let after: string | null = null;

    while (true) {
      const response = await callConduit("differential.changeset.search", {
        constraints: {
          diffPHIDs: [diffPHID]
        },
        limit: 100,
        ...(after ? { after } : {})
      });

      const data = extractSearchData(response);
      for (const item of data) {
        const fields = isJsonObject(item.fields) ? item.fields : {};
        const path = asString(fields.path) ?? asString(item.path);
        if (!path || seen.has(path)) {
          continue;
        }
        seen.add(path);
        files.push(path);
      }

      const cursor = isJsonObject(response.cursor) ? response.cursor : {};
      const nextAfter = asString(cursor.after);
      if (!nextAfter || data.length === 0 || nextAfter === after) {
        break;
      }
      after = nextAfter;
    }
  }

  return files;
}

function buildChangesetWarning(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof ConduitApiError) {
    return `Could not fetch changed files from changeset API: ${message}`;
  }
  return `Could not fetch changed files from changesets: ${message}`;
}

function buildRawDiffWarning(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof ConduitApiError) {
    return `Could not fetch changed files from raw diff API: ${message}`;
  }
  return `Could not fetch changed files from raw diff: ${message}`;
}

function normalizeMaxComments(max_comments?: number): number {
  if (max_comments === undefined || max_comments === null) {
    return DEFAULT_MAX_DRAFT_COMMENTS;
  }
  if (!Number.isInteger(max_comments) || max_comments <= 0) {
    throw new InputValidationError("max_comments must be a positive integer.");
  }
  return max_comments;
}

function normalizeDraftReviewFindings(input: unknown): DraftReviewFinding[] {
  const container = parseReviewInputContainer(input);
  const rawFindings = container.findings;
  if (!Array.isArray(rawFindings) || rawFindings.length === 0) {
    throw new InputValidationError("review findings are required.");
  }

  const findings: DraftReviewFinding[] = [];
  for (const rawFinding of rawFindings) {
    if (!isJsonObject(rawFinding)) {
      continue;
    }
    const title = asString(rawFinding.title);
    const body = asString(rawFinding.body);
    const codeLocation = isJsonObject(rawFinding.code_location) ? rawFinding.code_location : null;
    const absoluteFilePath = codeLocation ? asString(codeLocation.absolute_file_path) : null;
    const lineRange = codeLocation && isJsonObject(codeLocation.line_range) ? codeLocation.line_range : null;
    const lineText = codeLocation ? asString(codeLocation.line_text) : null;
    const start = lineRange ? asPositiveInteger(lineRange.start) : null;
    const end = lineRange ? asPositiveInteger(lineRange.end) : null;

    if (!title || !body || !absoluteFilePath || (!start && !lineText)) {
      continue;
    }

    findings.push({
      title,
      body,
      code_location: {
        absolute_file_path: absoluteFilePath,
        ...(start
          ? {
              line_range: {
                start,
                ...(end ? { end } : {})
              }
            }
          : {}),
        ...(lineText ? { line_text: lineText } : {})
      }
    });
  }

  if (findings.length === 0) {
    throw new InputValidationError("no valid findings with code_location were provided.");
  }

  return findings;
}

function parseReviewInputContainer(input: unknown): Record<string, unknown> {
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input);
      if (isJsonObject(parsed)) {
        return parsed;
      }
    } catch {
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

function asPositiveInteger(value: unknown): number | null {
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

async function fetchLatestDiffIdForRevision(revisionId: number): Promise<number> {
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

function extractDiffIdsFromQueryDiffsResponse(response: Record<string, unknown>): number[] {
  const ids = new Set<number>();
  const candidates: unknown[] = [];
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

async function fetchChangedFilesFromSingleDiff(diffId: number): Promise<string[]> {
  const context = await fetchSingleDiffContext(diffId);
  return context.changedFiles;
}

async function fetchSingleDiffContext(diffId: number): Promise<{ changedFiles: string[]; rawDiff: string }> {
  const rawDiffResponse = await callConduit("differential.getrawdiff", {
    diffID: diffId
  });
  const rawDiff = extractRawDiffText(rawDiffResponse);

  if (!rawDiff) {
    return {
      changedFiles: [],
      rawDiff: ""
    };
  }
  return {
    changedFiles: extractChangedFilesFromRawDiff(rawDiff),
    rawDiff
  };
}

function resolveInlineFilePath(inputPath: string, changedFiles: string[]): string | null {
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

  const suffixMatches = changedFiles.filter((path) =>
    normalized === path ||
    normalized.endsWith(`/${path}`) ||
    withoutLeadingSlash.endsWith(`/${path}`) ||
    withoutLeadingSlash.endsWith(path)
  );

  if (suffixMatches.length === 1) {
    return suffixMatches[0] ?? null;
  }

  if (suffixMatches.length > 1) {
    const sorted = suffixMatches.sort((a, b) => b.length - a.length);
    return sorted[0] ?? null;
  }

  return null;
}

function normalizeFilePath(path: string): string {
  return path.trim().replace(/\\/g, "/");
}

function resolveInlineLocation(
  filePath: string | null,
  codeLocation: DraftReviewCodeLocation,
  rawDiff: string
): { start: number; end: number } | null {
  if (!filePath) {
    return null;
  }

  const hintStart = codeLocation.line_range?.start;
  const lineText = codeLocation.line_text?.trim();
  if (lineText) {
    const resolved = resolveLineRangeFromRawDiff(rawDiff, filePath, lineText, hintStart);
    if (resolved) {
      return resolved;
    }
  }

  if (hintStart) {
    return {
      start: hintStart,
      end: codeLocation.line_range?.end ?? hintStart
    };
  }

  return null;
}

function buildMissingLineReason(codeLocation: DraftReviewCodeLocation, filePath: string): string {
  if (codeLocation.line_text?.trim()) {
    return `could not resolve line_text against raw diff for ${filePath}`;
  }
  return "finding is missing a resolvable line location";
}

function buildInlineCommentContent(finding: DraftReviewFinding, includeTitle: boolean): string {
  if (includeTitle) {
    return `${finding.title}\n\n${finding.body}`;
  }
  return finding.body;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function extractRawDiffText(response: Record<string, unknown>): string {
  return (
    asString(response.response) ??
    asString(response.result) ??
    asString(response.rawDiff) ??
    asString(response.diff) ??
    ""
  );
}

function asNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is number => typeof entry === "number" && Number.isInteger(entry) && entry > 0);
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function collectDiffPHIDs(diffPHID: string | null, diffsAttachment: Record<string, unknown>): string[] {
  const phids = new Set<string>();
  if (diffPHID) {
    phids.add(diffPHID);
  }
  for (const phid of asStringArray(diffsAttachment.diffPHIDs)) {
    phids.add(phid);
  }
  return Array.from(phids);
}

function collectDiffIDs(fields: Record<string, unknown>, diffsAttachment: Record<string, unknown>): number[] {
  const ids = new Set<number>();
  for (const id of asNumberArray(fields.diffs)) {
    ids.add(id);
  }
  for (const id of asNumberArray(diffsAttachment.diffIDs)) {
    ids.add(id);
  }
  return Array.from(ids);
}

function mergeDiffIDs(first: number[], second: number[]): number[] {
  const ids = new Set<number>();
  for (const id of first) {
    ids.add(id);
  }
  for (const id of second) {
    ids.add(id);
  }
  return Array.from(ids);
}

async function fetchDiffIdsFromPhids(diffPHIDs: string[]): Promise<number[]> {
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

    const ids = new Set<number>();
    for (const item of extractSearchData(response)) {
      const id = item.id;
      if (typeof id === "number" && Number.isInteger(id) && id > 0) {
        ids.add(id);
      }
    }
    return Array.from(ids);
  } catch {
    return [];
  }
}
