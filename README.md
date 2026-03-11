# phab-arc-mcp

`phab-arc-mcp` is an MCP stdio server that talks to Phabricator through local Arcanist:

```bash
echo '{}' | arc call-conduit --conduit-uri https://phab.instahyre.com/ -- user.whoami
```

It does not use raw HTTP. All Conduit calls are executed via `arc call-conduit` with JSON payloads on stdin.

## Prerequisites

1. Node.js 20+ (Node 22 recommended)
2. `arc` installed and on `PATH`
3. Arcanist authenticated against your Phabricator instance, for example:
   - `arc install-certificate https://phab.instahyre.com/`
4. Access to `https://phab.instahyre.com/`

## Install and Run

```bash
npm install
npm run build
npm start
```

For local development:

```bash
npm run dev
```

## Environment Variables

- `PHAB_CONDUIT_URI` (default: `https://phab.instahyre.com/`)
- `PHAB_ARC_TIMEOUT_MS` (default: `30000`)

## MCP Tools

### 1) `phab_whoami()`
Calls `user.whoami` with `{}` and returns:

```json
{
  "username": "jdoe",
  "realName": "Jane Doe",
  "phid": "PHID-USER-xxxxxxxxxxxxxxxxxxxx"
}
```

### 2) `phab_list_my_open_revisions(statuses?: string[], limit?: number)`
Calls `differential.revision.search` with:
- `constraints.authorPHIDs=[whoami.phid]`
- `constraints.statuses` default `["needs-review","needs-revision","accepted"]`
- `order="newest"`
- `limit` default `100`

Example result:

```json
{
  "authorPHID": "PHID-USER-xxxxxxxxxxxxxxxxxxxx",
  "statuses": ["needs-review", "needs-revision", "accepted"],
  "revisions": [
    {
      "id": 1234,
      "title": "Add retry logic to conduit wrapper",
      "uri": "https://phab.instahyre.com/D1234",
      "status": {
        "value": "needs-review",
        "name": "Needs Review"
      },
      "dateModified": 1761234567
    }
  ]
}
```

### 3) `phab_is_revision_accepted(revision_id: string | number)`
Calls `differential.revision.search` with `constraints.ids=[id]`.
Accepted is computed by `status.value === "accepted"`.

Example result:

```json
{
  "revisionId": 1234,
  "found": true,
  "accepted": false,
  "status": {
    "value": "needs-review",
    "name": "Needs Review"
  }
}
```

### 4) `phab_get_task(task_id: "T123")`
Calls `maniphest.search` with:
- `constraints.ids=[123]`

Example result:

```json
{
  "taskId": "T123",
  "found": true,
  "title": "Migrate CI workers",
  "description": "Move worker pools to new autoscaling group and verify queue latency.",
  "status": {
    "value": "open",
    "name": "Open"
  }
}
```

### 5) `phab_get_revision_context(revision_id: "D1234", resolve_tasks?: boolean, include_changes?: boolean)`
Calls `differential.revision.search` with `constraints.ids=[1234]` and returns:
- revision title, summary, uri, status, and `diffPHID`
- `referencedTaskIds` parsed from title/summary text (e.g. `T44043`)
- `changedFiles` and `rawDiff` (full patch text) from raw diff parsing (default `true`)
  - resolves `diffPHID -> diffID` via `differential.diff.search`, then parses `differential.getrawdiff` output
- optionally `referencedTasks` resolved via `maniphest.search` (default `true`)

Example result:

```json
{
  "revisionId": "D1234",
  "found": true,
  "title": "Fix retries for applicant sync (T44043)",
  "summary": "This change handles API flakiness and closes T44043.",
  "uri": "https://phab.instahyre.com/D1234",
  "diffPHID": "PHID-DIFF-xxxxxxxxxxxxxxxxxxxx",
  "status": {
    "value": "needs-review",
    "name": "Needs Review"
  },
  "changedFiles": [
    "src/worker/deleteS3Files.ts",
    "src/services/s3.ts"
  ],
  "rawDiff": "diff --git a/src/worker/deleteS3Files.ts b/src/worker/deleteS3Files.ts\n...",
  "referencedTaskIds": ["T44043"],
  "referencedTasks": [
    {
      "taskId": "T44043",
      "found": true,
      "title": "Applicant sync intermittently fails",
      "description": "Fix retries and error handling in sync worker.",
      "status": {
        "value": "open",
        "name": "Open"
      }
    }
  ]
}
```

### 6) `phab_add_draft_inline_comments(revision_id: "D1234", review_json?: object|string, findings?: object[], is_new_file?: boolean, include_title?: boolean, max_comments?: number)`
Creates draft inline comments from code-review findings JSON and does **not** publish them.

- Resolves latest `diffID` for the revision via `differential.querydiffs`
- Maps each `code_location.absolute_file_path` to a changed file path in that diff
- Uses `code_location.line_range.start` as inline line number
- Creates comments with `differential.createinline`

Expected finding shape:

```json
{
  "findings": [
    {
      "title": "[P1] ...",
      "body": "Why this is a bug...",
      "code_location": {
        "absolute_file_path": "/abs/path/to/file.py",
        "line_range": { "start": 42, "end": 42 }
      }
    }
  ]
}
```

Notes:
- Draft inlines are only visible in draft/add-comment flow until published.
- To publish drafted inlines, call `differential.createcomment` with `attach_inlines=true`.

### 7) `phab_get_review_prompt(revision_id?: string, prompt_name?: string)`
Fallback tool for MCP clients that do not expose prompt templates in UI.

Returns:
- `description`
- `text` (full review prompt template)

Defaults:
- `prompt_name = "phab_recursive_review_json"`
- `revision_id = "D<DIFFERENTIAL_ID>"`

## MCP Prompts

### 1) `phab_recursive_review_json(revision_id: string)`
Returns a reusable review prompt template for Differential reviews that:
- enforces JSON-only findings output with severity/priorities
- instructs recursive context expansion across referenced tasks and revisions
- prioritizes runtime/syntax/name errors first
- includes repository note that reviews should assume Mercurial workflow (not Git)

`revision_id` accepts values like `D1234` or `1234`.

## Codex MCP Config Example

Use the built server:

```json
{
  "mcpServers": {
    "phab-arc-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/phab-arc-mcp/dist/server.js"],
      "env": {
        "PHAB_CONDUIT_URI": "https://phab.instahyre.com/",
        "PHAB_ARC_TIMEOUT_MS": "30000"
      }
    }
  }
}
```

Or run from source with `tsx`:

```json
{
  "mcpServers": {
    "phab-arc-mcp": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/phab-arc-mcp/src/server.ts"]
    }
  }
}
```

## Security Note

This server relies on your local `arc` authentication/session and permissions. It does not manage tokens directly; any action runs as your local authenticated Phabricator identity.
