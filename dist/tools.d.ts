import { extractRevisionSummary } from "./parsing.js";
export declare function phab_whoami(): Promise<{
    username: string;
    realName: string;
    phid: string;
}>;
export declare function phab_list_my_open_revisions(statuses?: string[], limit?: number): Promise<{
    authorPHID: string;
    statuses: string[];
    revisions: ReturnType<typeof extractRevisionSummary>[];
}>;
export declare function phab_is_revision_accepted(revision_id: string | number): Promise<{
    revisionId: number;
    found: boolean;
    accepted: boolean;
    status: ReturnType<typeof extractRevisionSummary>["status"] | null;
}>;
export declare function phab_get_task(task_id: string): Promise<{
    taskId: string;
    found: boolean;
    title?: string | null;
    description?: string | null;
    status?: unknown;
}>;
export declare function phab_get_revision_context(revision_id: string | number, resolve_tasks?: boolean, include_changes?: boolean): Promise<{
    revisionId: string;
    found: boolean;
    title?: string | null;
    summary?: string | null;
    uri?: string | null;
    diffPHID?: string | null;
    status?: ReturnType<typeof extractRevisionSummary>["status"] | null;
    referencedTaskIds: string[];
    changedFiles?: string[];
    rawDiff?: string;
    changesWarning?: string;
    referencedTasks?: Array<{
        taskId: string;
        found: boolean;
        title?: string | null;
        description?: string | null;
        status?: unknown;
    }>;
}>;
export declare function phab_add_draft_inline_comments(revision_id: string | number, reviewInput: unknown, options?: {
    is_new_file?: boolean;
    include_title?: boolean;
    max_comments?: number;
}): Promise<{
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
}>;
