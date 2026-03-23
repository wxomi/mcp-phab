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

const INLINE_COMMENTS_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    revisionId: { type: "string" },
    diffId: { type: "integer" },
    isNewFile: { type: "boolean" },
    changedFiles: {
      type: "array",
      items: { type: "string" }
    },
    createdCount: { type: "integer" },
    skippedCount: { type: "integer" },
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer" },
          ok: { type: "boolean" },
          reason: { type: "string" },
          filePath: { type: "string" },
          lineNumber: { type: "integer" },
          lineLength: { type: "integer" },
          title: { type: "string" }
        }
      }
    }
  },
  required: ["revisionId", "diffId", "isNewFile", "changedFiles", "createdCount", "skippedCount", "results"]
} as const;

const REVIEW_PHAB_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    revision_id: { type: "string" },
    review_prompt: { type: "string" },
    revision_context: { type: "object" },
    review_summary: {
      type: "object",
      properties: {
        changed_file_count: { type: "integer" },
        referenced_task_count: { type: "integer" },
        direct_referenced_task_count: { type: "integer" },
        has_raw_diff: { type: "boolean" },
        has_changes_warning: { type: "boolean" }
      },
      required: [
        "changed_file_count",
        "referenced_task_count",
        "direct_referenced_task_count",
        "has_raw_diff",
        "has_changes_warning"
      ]
    },
    next_action: {
      type: "object",
      properties: {
        type: { type: "string" },
        tool_name: { type: "string" },
        required_argument: { type: "string" }
      },
      required: ["type", "tool_name", "required_argument"]
    }
  },
  required: ["revision_id", "review_prompt", "revision_context", "review_summary", "next_action"]
} as const;

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
        },
        outputSchema: INLINE_COMMENTS_OUTPUT_SCHEMA
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
        },
        outputSchema: REVIEW_PHAB_OUTPUT_SCHEMA
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
        const normalizedRevisionId =
          typeof revisionId === "number" ? `D${revisionId}` : normalizeRevisionIdForTool(revisionId);
        const result = {
          revision_id: normalizedRevisionId,
          review_prompt: reviewPrompt.text,
          revision_context: reviewContext,
          review_summary: {
            changed_file_count: reviewContext.changedFiles?.length ?? 0,
            referenced_task_count: reviewContext.referencedTaskIds.length,
            direct_referenced_task_count: reviewContext.directReferencedTaskIds.length,
            has_raw_diff: Boolean(reviewContext.rawDiff),
            has_changes_warning: Boolean(reviewContext.changesWarning)
          },
          next_action: {
            type: "generate_review_json_then_call_tool",
            tool_name: "inline-comments-phab",
            required_argument: "review_json"
          }
        };

        return toToolResultWithText(
          result,
          buildReviewPhabText(result)
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
  return toToolResultWithText(value);
}

function toToolResultWithText(value: unknown, text?: string): CallToolResult {
  const contentText = text ?? JSON.stringify(value, null, 2);
  return {
    content: [
      {
        type: "text",
        text: contentText
      }
    ],
    ...(isStructuredContent(value) ? { structuredContent: value } : {})
  };
}

function buildReviewPhabText(result: {
  revision_id: string;
  review_summary: {
    changed_file_count: number;
    referenced_task_count: number;
    direct_referenced_task_count: number;
    has_raw_diff: boolean;
    has_changes_warning: boolean;
  };
  next_action: {
    tool_name: string;
    required_argument: string;
  };
}): string {
  const parts = [
    `Fetched review package for ${result.revision_id}.`,
    `Changed files: ${result.review_summary.changed_file_count}.`,
    `Direct tasks: ${result.review_summary.direct_referenced_task_count}.`,
    `Resolved tasks: ${result.review_summary.referenced_task_count}.`,
    `Raw diff available: ${result.review_summary.has_raw_diff ? "yes" : "no"}.`
  ];

  if (result.review_summary.has_changes_warning) {
    parts.push("Change-context warnings are present in revision_context.changesWarning.");
  }

  parts.push(
    `Use structuredContent.review_prompt with structuredContent.revision_context, then call ${result.next_action.tool_name} with ${result.next_action.required_argument}.`
  );

  return parts.join(" ");
}

function isStructuredContent(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
