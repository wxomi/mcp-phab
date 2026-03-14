# phab-arc-mcp

`phab-arc-mcp` is a small MCP stdio server for reviewing Phabricator revisions.

It does two things:

1. It prepares review context for a Differential.
2. It can create draft inline comments on that Differential through Conduit.


## What This Server Exposes

The public MCP surface is intentionally small:

- `review-phab`
- `inline-comments-phab`

There is also an MCP prompt named `review-phab`, but it is used internally by the server as well and can be fetched by clients that support prompts.

## How The Review Flow Works

The current flow is:

1. Call `review-phab` with a revision ID like `D35297`.
2. The server returns:
   - the reusable review prompt
   - the fetched revision context
   - the raw diff
   - recursively resolved task context
3. The model reviews the revision using that returned data and produces review JSON.
4. Call `inline-comments-phab` with that review JSON.
5. The server creates draft inline comments on the revision.

This design is deliberate.

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