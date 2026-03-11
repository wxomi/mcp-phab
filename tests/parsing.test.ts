import test from "node:test";
import assert from "node:assert/strict";
import {
  extractChangedFilesFromRawDiff,
  extractTaskIdsFromText,
  extractTextValue,
  extractRevisionSummary,
  extractTaskSummary,
  normalizeConduitResponse,
  parseRevisionId,
  parseTaskId
} from "../src/parsing.ts";

test("normalizeConduitResponse unwraps response envelope", () => {
  const value = normalizeConduitResponse({
    error: null,
    response: {
      ok: true
    }
  });
  assert.deepEqual(value, { ok: true });
});

test("normalizeConduitResponse throws when error is non-null", () => {
  assert.throws(() => {
    normalizeConduitResponse({
      error: "Boom"
    });
  });
});

test("normalizeConduitResponse wraps primitive response payloads", () => {
  const value = normalizeConduitResponse({
    error: null,
    response: "RAW-DIFF"
  });
  assert.deepEqual(value, { response: "RAW-DIFF" });
});

test("parseRevisionId supports D-prefixed and numeric strings", () => {
  assert.equal(parseRevisionId("D123"), 123);
  assert.equal(parseRevisionId("456"), 456);
  assert.equal(parseRevisionId(789), 789);
});

test("parseTaskId supports T-prefixed and numeric strings", () => {
  assert.equal(parseTaskId("T123"), 123);
  assert.equal(parseTaskId("456"), 456);
});

test("extractRevisionSummary maps key fields", () => {
  const summary = extractRevisionSummary({
    id: 12,
    fields: {
      title: "Fix flaky test",
      uri: "https://phab.instahyre.com/D12",
      status: {
        value: "accepted",
        name: "Accepted"
      },
      dateModified: 1700000000
    }
  });

  assert.equal(summary.id, 12);
  assert.equal(summary.title, "Fix flaky test");
  assert.equal(summary.status.value, "accepted");
});

test("extractTaskSummary extracts title/description/status", () => {
  const summary = extractTaskSummary({
    id: 123,
    phid: "PHID-TASK-1",
    fields: {
      name: "Implement MCP",
      description: {
        raw: "Build a local arc-based MCP server."
      },
      status: { value: "open", name: "Open" },
    }
  });

  assert.equal(summary.title, "Implement MCP");
  assert.equal(summary.description, "Build a local arc-based MCP server.");
  assert.deepEqual(summary.status, { value: "open", name: "Open" });
});

test("extractTextValue handles string and rich text objects", () => {
  assert.equal(extractTextValue("plain"), "plain");
  assert.equal(extractTextValue({ raw: "raw-text" }), "raw-text");
  assert.equal(extractTextValue({ text: "text-value" }), "text-value");
  assert.equal(extractTextValue({ content: "content-value" }), "content-value");
  assert.equal(extractTextValue({}), null);
});

test("extractTaskIdsFromText deduplicates and normalizes IDs", () => {
  const ids = extractTaskIdsFromText(
    "Fixes T44043 and t44043.",
    "Related: T7, T0007, and T9012."
  );

  assert.deepEqual(ids, ["T44043", "T7", "T9012"]);
});

test("extractChangedFilesFromRawDiff parses git and index headers", () => {
  const raw = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,1 +1,2 @@",
    "diff --git a/src/b.ts b/src/b.ts",
    "Index: src/c.ts",
    "+++ b/src/c.ts"
  ].join("\n");

  assert.deepEqual(extractChangedFilesFromRawDiff(raw), ["src/a.ts", "src/b.ts", "src/c.ts"]);
});
