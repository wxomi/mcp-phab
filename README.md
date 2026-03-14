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

### Requirements

1. Node.js 18 or newer
2. `npm`
3. access to a Phabricator instance with the Conduit API enabled
4. a Conduit API token for an account that can read the revisions and tasks you want to review

### 1. Clone the repository

```bash
git clone https://github.com/wxomi/node-chat.git
cd mcp-phab
```

### 2. Install dependencies

```bash
npm install
```

### 3. Build the server

```bash
npm run build
```

This produces the MCP server entrypoint at `dist/server.js`.

### 4. Configure environment variables

Set these before starting the server or before wiring it into your MCP client:

- `PHAB_API_TOKEN`
  - required
  - primary token variable used by the server
- `CONDUIT_TOKEN`
  - optional alias for `PHAB_API_TOKEN`
- `PHAB_CONDUIT_TOKEN`
  - optional alias for `PHAB_API_TOKEN`
- `PHAB_CONDUIT_URI`
  - optional
  - default: `https://phab.instahyre.com/`
  - should point to the base URL of your Phabricator instance
- `PHAB_ARC_TIMEOUT_MS`
  - optional
  - default: `30000`
  - request timeout in milliseconds

Example:

```bash
export PHAB_CONDUIT_URI="https://phabricator.example.com/"
export PHAB_API_TOKEN="api-xxxxxxxxxxxxxxxx"
export PHAB_ARC_TIMEOUT_MS="30000"
```

If you do not set `PHAB_CONDUIT_URI`, the server will try `https://phab.instahyre.com/`.

### 5. Start the server manually (optional)

You usually do not need this step when using the server through an MCP client. In the normal setup, the MCP client launches the stdio server process for you using its `mcpServers` configuration.

Run the built server manually only if you want to verify that the binary starts correctly:

```bash
npm start
```

For local development without building on every change:

```bash
npm run dev
```

The server uses stdio transport, so manual `npm start` is optional and is not a required installation step.

## Setup In An MCP Client

### Codex / MCP config using the built server

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

## Setup Checklist

Use this to verify the installation quickly:

1. `npm install` completes successfully
2. `npm run build` creates `dist/server.js`
3. your MCP client is configured with `PHAB_API_TOKEN`
4. `PHAB_CONDUIT_URI` points to the correct Phabricator base URL
5. the MCP client can see the `review-phab` and `inline-comments-phab` tools

## Example Usage

### Step 1: get review context

Call `review-phab` with:

```json
{
  "revision_id": "D35297"
}
```

## Notes

- This server talks to Phabricator over the Conduit HTTP API.
- A valid API token is required for every tool call.
- Comments created by `inline-comments-phab` are draft inlines and are not published automatically.
