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
export declare function isJsonObject(value: unknown): value is JsonObject;
export declare function normalizeConduitResponse(raw: unknown): JsonObject;
export declare function parseRevisionId(revisionId: string | number): number;
export declare function parseTaskId(taskId: string): number;
export declare function extractSearchData(response: JsonObject): JsonObject[];
export declare function extractRevisionSummary(item: JsonObject): RevisionSummary;
export declare function extractTaskSummary(item: JsonObject): TaskSummary;
export declare function extractTextValue(value: unknown): string | null;
export declare function extractTaskIdsFromText(...texts: Array<string | null | undefined>): string[];
export declare function extractChangedFilesFromRawDiff(rawDiff: string): string[];
