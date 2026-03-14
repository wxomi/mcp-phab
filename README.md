# phab-arc-mcp

`phab-arc-mcp` is a small MCP stdio server for reviewing Phabricator revisions.

## What This Server Exposes

The public MCP surface is intentionally small:

- `review-phab`
- `inline-comments-phab`

## What `review-phab` Does

`review-phab` is the tool you call when you want an AI reviewer to review a Differential properly.

You give it a revision ID like `D35297`. It fetches the revision title, summary, changed files, raw diff, and the linked Maniphest task context, then packages all of that together with the review prompt the model should use.

From a user point of view, this means you do not have to manually open the revision, copy the diff, inspect related tasks, and explain the background before asking for a review. The tool gives the model the code changes and the surrounding context in one shot.

That makes reviews more useful because the model can judge the change against the actual task being solved, not just the raw code diff. It can use the overall repository context to reason about likely bugs, regressions, and edge cases, and it can also check whether the revision actually does what the linked task says it should do. In practice.

After that, `inline-comments-phab` can take the review findings and create draft inline comments directly on the Differential.

Important details:

- comments are created as draft inlines, not published comments

## Installation

Requirements:

1. Node.js 20 or newer
2. access to your Phabricator instance
3. a Conduit API token

Install and build:

```bash
npm install
npm run build
```

Run the built server:

```bash
npm start
```

For local development:

```bash
npm run dev
```

## Environment Variables

- `PHAB_CONDUIT_URI`
  - default: `https://phab.instahyre.com/`
- `PHAB_ARC_TIMEOUT_MS`
  - default: `30000`
- `PHAB_API_TOKEN`
  - required
- `CONDUIT_TOKEN`
  - accepted as an alternative token env var
- `PHAB_CONDUIT_TOKEN`
  - accepted as an alternative token env var

## Example Usage

### Step 1: get review context

Call `review-phab` with:

```json
{
  "revision_id": "D35297"
}
```

## Codex MCP Config Example

Built server:

```json
{
  "mcpServers": {
    "phab-arc-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/phab-arc-mcp/dist/server.js"],
      "env": {
        "PHAB_CONDUIT_URI": "https://phab.instahyre.com/",
        "PHAB_API_TOKEN": "api-xxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

Run from source:

```json
{
  "mcpServers": {
    "phab-arc-mcp": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/phab-arc-mcp/src/server.ts"],
      "env": {
        "PHAB_CONDUIT_URI": "https://phab.instahyre.com/",
        "PHAB_API_TOKEN": "api-xxxxxxxxxxxxxxxx"
      }
    }
  }
}
```
