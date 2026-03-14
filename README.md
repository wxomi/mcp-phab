# phab-arc-mcp

`phab-arc-mcp` is an MCP stdio server that talks to Phabricator via Conduit over the HTTP API using a Conduit token.

## Prerequisites

1. Node.js 20+ (Node 22 recommended)
2. Access to `https://phab.instahyre.com/`
3. `PHAB_API_TOKEN` configured

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
- `PHAB_API_TOKEN` (required; `CONDUIT_TOKEN` and `PHAB_CONDUIT_TOKEN` are also accepted)

## MCP Tools

### 1) `inline-comments-phab(revision_id: "D1234", review_json?: object|string, findings?: object[], is_new_file?: boolean, include_title?: boolean, max_comments?: number)`
Creates draft inline comments from code-review findings JSON and does **not** publish them.

- Resolves latest `diffID` for the revision via `differential.querydiffs`
- Maps each `code_location.absolute_file_path` to a changed file path in that diff
- Resolves the inline line number from raw diff using `code_location.line_text` when provided
- Falls back to `code_location.line_range.start` only when no snippet is available
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
        "line_text": "exact changed line text here",
        "line_range": { "start": 42, "end": 42 }
      }
    }
  ]
}
```

Notes:
- Prefer providing `line_text`; it is the reliable source of truth for inline placement.
- Draft inlines are only visible in draft/add-comment flow until published.
- To publish drafted inlines, call `differential.createcomment` with `attach_inlines=true`.

### 2) `review-phab(revision_id: "D1234")`
Fetches the exact reusable review prompt and full revision context needed to review a Differential without MCP sampling.

Returns:
- `prompt` (same prompt body returned by the `review-phab` MCP prompt)
- `revision_context`:
  - revision metadata
  - `directReferencedTaskIds`
  - recursively expanded `referencedTaskIds`
  - `referencedTasks` with `mentionedTaskIds`, `parentTasks`, and `hierarchy`
  - `changedFiles`
  - `rawDiff`
- `next_step` (instruction to call `inline-comments-phab` after generating review JSON)

Notes:
- This does not require MCP sampling support.
- Use `inline-comments-phab` after producing review JSON from the returned prompt and context.

## MCP Prompts

### 1) `review-phab()`
Returns a reusable review prompt template for Differential reviews that:
- enforces JSON-only findings output with severity/priorities
- assumes revision context and recursive task hierarchy are already provided
- prioritizes runtime/syntax/name errors first
- includes repository note that reviews should assume Mercurial workflow (not Git)

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

This server authenticates with a Conduit API token (`PHAB_API_TOKEN`, `CONDUIT_TOKEN`, or `PHAB_CONDUIT_TOKEN`). Keep tokens in environment variables and do not hardcode them.
