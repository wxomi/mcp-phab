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
  phab_get_revision_context,
  phab_get_task
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
        name: "phab_get_task",
        description: "Fetches a task by ID (e.g. T123) from Maniphest.",
        inputSchema: {
          type: "object",
          properties: {
            task_id: {
              type: "string"
            }
          },
          required: ["task_id"],
          additionalProperties: false
        }
      },
      {
        name: "phab_get_revision_context",
        description:
          "Fetches revision details and includes code changes by resolving diffPHID -> diffID -> getrawdiff, with optional referenced T-task resolution.",
        inputSchema: {
          type: "object",
          properties: {
            revision_id: {
              anyOf: [{ type: "string" }, { type: "integer" }]
            },
            resolve_tasks: {
              type: "boolean"
            },
            include_changes: {
              type: "boolean"
            }
          },
          required: ["revision_id"],
          additionalProperties: false
        }
      },
      {
        name: "phab_add_draft_inline_comments",
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
        name: "phab_get_review_prompt",
        description:
          "Returns the built-in recursive Differential review prompt text (fallback for clients that do not expose MCP prompts).",
        inputSchema: {
          type: "object",
          properties: {
            revision_id: {
              type: "string"
            },
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
      case "phab_get_task": {
        const taskId = args.task_id;
        if (typeof taskId !== "string") {
          throw new Error("phab_get_task requires task_id as string.");
        }
        return toToolResult(await phab_get_task(taskId));
      }
      case "phab_get_revision_context": {
        const revisionId = args.revision_id;
        if (typeof revisionId !== "string" && typeof revisionId !== "number") {
          throw new Error("phab_get_revision_context requires revision_id as string or integer.");
        }
        return toToolResult(
          await phab_get_revision_context(
            revisionId,
            asOptionalBoolean(args.resolve_tasks) ?? true,
            asOptionalBoolean(args.include_changes) ?? true
          )
        );
      }
      case "phab_add_draft_inline_comments": {
        const revisionId = args.revision_id;
        if (typeof revisionId !== "string" && typeof revisionId !== "number") {
          throw new Error("phab_add_draft_inline_comments requires revision_id as string or integer.");
        }

        const reviewJson = args.review_json;
        const findings = args.findings;
        const reviewInput = reviewJson ?? findings;
        if (reviewInput === undefined) {
          throw new Error("phab_add_draft_inline_comments requires review_json or findings.");
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
      case "phab_get_review_prompt": {
        const promptName = typeof args.prompt_name === "string" ? args.prompt_name : "phab_recursive_review_json";
        const revisionId = typeof args.revision_id === "string" ? args.revision_id : "D<DIFFERENTIAL_ID>";
        return toToolResult(
          getPromptByName(promptName, {
            revision_id: revisionId
          })
        );
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
