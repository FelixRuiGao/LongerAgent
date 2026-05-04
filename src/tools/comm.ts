/**
 * Communication and orchestration tools.
 *
 * Tool definitions for the context-centric runtime.
 * Detailed usage guidance is in agent_templates/main/system_prompt.md.
 * Tool executors are created at runtime by Session.
 */

import type { ToolDef } from "../providers/base.js";

export const SPAWN_TOOL: ToolDef = {
  name: "spawn",
  description:
    "Spawn a single sub-agent with inline parameters. " +
    "Check pre-defined templates (e.g. 'explorer', 'executor') before creating custom ones. " +
    "See system prompt for available templates and their capabilities.",
  parameters: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "Unique agent ID.",
      },
      template: {
        type: "string",
        description: "Pre-defined template name, e.g. 'explorer', 'executor'.",
      },
      template_path: {
        type: "string",
        description: "Path to a custom template directory relative to {SESSION_ARTIFACTS}.",
      },
      task: {
        type: "string",
        description: "Task description for the agent.",
      },
      mode: {
        type: "string",
        enum: ["oneshot", "persistent"],
        description: "Agent mode: 'oneshot' (single turn) or 'persistent' (stays alive, receives messages via send).",
      },
      model_level: {
        type: "string",
        enum: ["high", "medium", "low"],
        description: "Model tier for this sub-agent. If omitted, the sub-agent inherits the parent model. Tiers must be configured by the user.",
      },
    },
    required: ["id", "task", "mode"],
  },
  summaryTemplate: "{agent} is spawning sub-agent {id}",
  tuiPolicy: { partialReveal: { completeArgs: ["id"] } },
};

export const KILL_AGENT_TOOL: ToolDef = {
  name: "kill_agent",
  description: "Kill one or more running sub-agents by ID.",
  parameters: {
    type: "object",
    properties: {
      ids: {
        type: "array",
        items: { type: "string" },
        description: "IDs of the sub-agents to kill.",
      },
    },
    required: ["ids"],
  },
  summaryTemplate: "{agent} is killing sub-agents",
  tuiPolicy: { partialReveal: "closed" },
};

export const ASK_TOOL: ToolDef = {
  name: "ask",
  description:
    "Ask the user 1-4 structured questions with 1-4 options each.",
  parameters: {
    type: "object",
    properties: {
      questions: {
        type: "array", minItems: 1, maxItems: 4,
        items: {
          type: "object",
          properties: {
            question: { type: "string" },
            options: {
              type: "array", minItems: 1, maxItems: 4,
              items: {
                type: "object",
                properties: {
                  label: { type: "string" },
                  description: { type: "string" },
                },
                required: ["label"],
              },
            },
          },
          required: ["question", "options"],
        },
      },
    },
    required: ["questions"],
  },
  summaryTemplate: "{agent} is asking the user a question",
  tuiPolicy: { partialReveal: "closed" },
};

export const SHOW_CONTEXT_TOOL: ToolDef = {
  name: "show_context",
  description:
    "Display the context distribution of the current active window. " +
    "Returns a Context Map showing all context groups with their sizes and types. " +
    "Also causes detailed annotations to appear inline until the next summarize call or show_context(dismiss=true), " +
    "showing exactly what each context ID covers and the approximate size of each part.",
  parameters: {
    type: "object",
    properties: {
      dismiss: {
        type: "boolean",
        description:
          "If true, dismiss the currently active context annotations without showing new ones.",
      },
    },
    required: [],
  },
  summaryTemplate: "{agent} is inspecting context",
  tuiPolicy: { partialReveal: "immediate" },
};

export const SUMMARIZE_TOOL: ToolDef = {
  name: "summarize",
  description:
    "Summarize a contiguous range of context groups — extract and preserve valuable information, discard the rest. " +
    "Specify the range with `from` and `to` context IDs (inclusive). " +
    "If you need to inspect the current context distribution first, call show_context.\n\n" +
    "Example — single context group: from=\"a3f1\", to=\"a3f1\"\n" +
    "Example — two non-adjacent groups: use TWO separate operations (one per group), NOT one operation spanning the gap.",
  parameters: {
    type: "object",
    properties: {
      operations: {
        type: "array",
        description: "Each operation summarizes a contiguous range of context groups into a preserved extract.",
        items: {
          type: "object",
          properties: {
            from: {
              type: "string",
              description: "Start context ID of the range (inclusive).",
            },
            to: {
              type: "string",
              description: "End context ID of the range (inclusive). Same as `from` for a single group.",
            },
            content: {
              type: "string",
              description: "Summary content preserving decisions, key facts, file paths, code references, and unresolved issues. Length should match the information density of the original — preserve everything you'd look back at.",
            },
            reason: {
              type: "string",
              description: "Brief reason for summarizing this group.",
            },
          },
          required: ["from", "to", "content"],
        },
      },
    },
    required: ["operations"],
  },
  summaryTemplate: "{agent} is summarizing context",
  tuiPolicy: { partialReveal: "immediate" },
};

export const CHECK_STATUS_TOOL: ToolDef = {
  name: "check_status",
  description:
    "View sub-agent status and background shell status. " +
    "Returns agent reports (working, completed, errored) and tracked shell summaries.",
  parameters: {
    type: "object",
    properties: {},
  },
  summaryTemplate: "{agent} is checking status",
  tuiPolicy: { partialReveal: "immediate" },
};

export const AWAIT_EVENT_TOOL: ToolDef = {
  name: "await_event",
  description:
    "Pause this turn until a runtime event arrives or the timeout expires. " +
    "Runtime events include sub-agent completion, incoming messages, and tracked background shell exit. " +
    "Preferred over check_status when you have nothing else to do.",
  parameters: {
    type: "object",
    properties: {
      seconds: {
        type: "number",
        description: "How long to await runtime events (minimum 15, wall-clock timeout).",
      },
    },
    required: ["seconds"],
  },
  summaryTemplate: "{agent} is awaiting runtime events",
  tuiPolicy: { partialReveal: { completeArgs: ["seconds"] } },
};

export const SEND_TOOL: ToolDef = {
  name: "send",
  description:
    "Send a message to a persistent child agent by ID. " +
    "The message is delivered asynchronously — you get a confirmation, not a reply. " +
    "The target auto-activates if idle.",
  parameters: {
    type: "object",
    properties: {
      to: {
        type: "string",
        description: "Target child agent ID.",
      },
      content: {
        type: "string",
        description: "Message content.",
      },
    },
    required: ["to", "content"],
  },
  summaryTemplate: "{agent} sent message to {to}",
  tuiPolicy: { partialReveal: { completeArgs: ["to"] } },
};
