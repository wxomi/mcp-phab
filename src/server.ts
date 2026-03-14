import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { pathToFileURL } from "node:url";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult
} from "@modelcontextprotocol/sdk/types.js";
import {
  phab_add_draft_inline_comments,
  phab_get_revision_context
} from "./tools.js";
import { getPromptByName, listPromptDefinitions } from "./prompts.js";

const server = new Server(
  {
    name: "phab-arc-mcp",
    version: "0.1.0"
  },
  {
    capabilities: {
      tools: {},
      prompts: {}
    }
  }
);

server.setRequestHandler(ListPromptsRequestSchema, async () => {
  return {
    prompts: listPromptDefinitions()
  };
});

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const name = request.params.name;
  const args = asPromptArgs(request.params.arguments);
  const prompt = getPromptByName(name, args);

  return {
    description: prompt.description,
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: prompt.text
        }
      }
    ]
  };
});

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "inline-comments-phab",
        description:
          "Creates draft inline comments on a Differential revision from review findings JSON (does not publish).",
        inputSchema: {
          type: "object",
          properties: {
            revision_id: {
              anyOf: [{ type: "string" }, { type: "integer" }]
            },
            review_json: {
              anyOf: [{ type: "string" }, { type: "object" }]
            },
            findings: {
              type: "array",
              items: { type: "object" }
            },
            is_new_file: {
              type: "boolean"
            },
            include_title: {
              type: "boolean"
            },
            max_comments: {
              type: "integer",
              minimum: 1
            }
          },
          required: ["revision_id"],
          additionalProperties: false
        }
      },
      {
        name: "review-phab",
        description:
          "Fetches the exact review prompt and revision context needed to review a Differential without MCP sampling.",
        inputSchema: {
          type: "object",
          properties: {
            revision_id: {
              anyOf: [{ type: "string" }, { type: "integer" }]
            }
          },
          required: ["revision_id"],
          additionalProperties: false
        }
      },
      {
        name: "review-phab-prompt",
        description:
          "Returns the built-in recursive Differential review prompt text (fallback for clients that do not expose MCP prompts).",
        inputSchema: {
          type: "object",
          properties: {
            prompt_name: {
              type: "string"
            }
          },
          additionalProperties: false
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
  const name = request.params.name;
  const args = asObject(request.params.arguments);

  try {
    switch (name) {
      case "inline-comments-phab": {
        const revisionId = args.revision_id;
        if (typeof revisionId !== "string" && typeof revisionId !== "number") {
          throw new Error("inline-comments-phab requires revision_id as string or integer.");
        }

        const reviewJson = args.review_json;
        const findings = args.findings;
        const reviewInput = reviewJson ?? findings;
        if (reviewInput === undefined) {
          throw new Error("inline-comments-phab requires review_json or findings.");
        }

        const isNewFile = asOptionalBoolean(args.is_new_file);
        const includeTitle = asOptionalBoolean(args.include_title);
        const maxComments = asOptionalInteger(args.max_comments);

        return toToolResult(
          await phab_add_draft_inline_comments(revisionId, reviewInput, {
            ...(isNewFile === undefined ? {} : { is_new_file: isNewFile }),
            ...(includeTitle === undefined ? {} : { include_title: includeTitle }),
            ...(maxComments === undefined ? {} : { max_comments: maxComments })
          })
        );
      }
      case "review-phab": {
        const revisionId = args.revision_id;
        if (typeof revisionId !== "string" && typeof revisionId !== "number") {
          throw new Error("review-phab requires revision_id as string or integer.");
        }

        const reviewContext = await phab_get_revision_context(revisionId, true, true);
        const reviewPrompt = getPromptByName("review-phab", {});

        return toToolResult({
          revision_id: typeof revisionId === "number" ? `D${revisionId}` : normalizeRevisionIdForTool(revisionId),
          prompt: reviewPrompt,
          revision_context: reviewContext,
          next_step:
            "Review using prompt.text and revision_context, then call inline-comments-phab with the generated review JSON."
        });
      }
      case "review-phab-prompt": {
        const promptName = typeof args.prompt_name === "string" ? args.prompt_name : "review-phab";
        return toToolResult(getPromptByName(promptName, {}));
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: message
        }
      ]
    };
  }
});

function toToolResult(value: unknown): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function asPromptArgs(value: unknown): Record<string, string | undefined> {
  if (value === undefined) {
    return {};
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("prompt arguments must be an object.");
  }

  const args = value as Record<string, unknown>;
  const result: Record<string, string | undefined> = {};
  for (const [key, entry] of Object.entries(args)) {
    if (entry === undefined) {
      result[key] = undefined;
      continue;
    }
    if (typeof entry !== "string") {
      throw new Error(`prompt argument '${key}' must be a string.`);
    }
    result[key] = entry;
  }
  return result;
}

function normalizeRevisionIdForTool(value: string): string {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return `D${trimmed}`;
  }
  if (/^[dD]\d+$/.test(trimmed)) {
    return `D${trimmed.slice(1)}`;
  }
  return trimmed;
}

function asOptionalStringArray(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error("statuses must be an array of strings.");
  }

  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new Error("statuses must contain only strings.");
    }
  }
  return value;
}

function asOptionalInteger(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error("limit must be an integer.");
  }
  return value;
}

function asOptionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error("resolve_tasks must be a boolean.");
  }
  return value;
}

export async function run(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`phab-arc-mcp failed to start: ${message}`);
    process.exit(1);
  });
}
