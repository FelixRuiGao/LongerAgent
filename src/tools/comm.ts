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
    },
    required: ["id", "task", "mode"],
  },
  summaryTemplate: "{agent} is spawning sub-agent {id}",
};

export const SPAWN_FILE_TOOL: ToolDef = {
  name: "spawn_file",
  description:
    "Spawn multiple sub-agents or agent teams from a YAML call file. " +
    "Use this when spawning 2+ agents in parallel or creating teams with send-based communication. " +
    "For a single agent, prefer spawn instead.",
  parameters: {
    type: "object",
    properties: {
      file: {
        type: "string",
        description:
          "Filename of the YAML call file (relative to {SESSION_ARTIFACTS}).",
      },
    },
    required: ["file"],
  },
  summaryTemplate: "{agent} is spawning sub-agents from {file}",
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
        description: "IDs of the sub-agents to kill",
      },
    },
    required: ["ids"],
  },
  summaryTemplate: "{agent} is killing sub-agents",
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
};

export const SHOW_CONTEXT_TOOL: ToolDef = {
  name: "show_context",
  description:
    "Display the context distribution of the current active window. " +
    "Returns a Context Map showing all context groups with their sizes and types. " +
    "Also causes detailed annotations to appear inline until the next distill_context call or show_context(dismiss=true), " +
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
};

export const DISTILL_CONTEXT_TOOL: ToolDef = {
  name: "distill_context",
  description:
    "Distill groups of spatially contiguous contexts — extract and preserve valuable information, discard the rest. " +
    "If you need to inspect the current context distribution first, call show_context.",
  parameters: {
    type: "object",
    properties: {
      operations: {
        type: "array",
        description: "Each operation distills a group of contiguous context_ids into a preserved extract.",
        items: {
          type: "object",
          properties: {
            context_ids: {
              type: "array",
              items: { type: "string" },
              description: "Spatially contiguous context IDs to merge.",
            },
            content: {
              type: "string",
              description: "Distilled content preserving decisions, key facts, file paths, code references, and unresolved issues. Length should match the information density of the original — preserve everything you'd look back at.",
            },
            reason: {
              type: "string",
              description: "Brief reason for distilling this group.",
            },
          },
          required: ["context_ids", "content"],
        },
      },
    },
    required: ["operations"],
  },
  summaryTemplate: "{agent} is distilling context",
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
};

export const WAIT_TOOL: ToolDef = {
  name: "wait",
  description:
    "Block until a tracked worker changes state, a new message arrives, or the timeout expires. " +
    "Tracked workers include sub-agents and background shells. Returns status report with any new messages. " +
    "Preferred over check_status when you have nothing else to do.",
  parameters: {
    type: "object",
    properties: {
      seconds: {
        type: "number",
        description:
          "How long to wait (minimum 15). " +
          "Without 'agent': wall-clock timeout. " +
          "With 'agent': that agent's actual work time.",
      },
      agent: {
        type: "string",
        description:
          "Optional agent ID. When set, 'seconds' tracks that agent's work time only.",
      },
      shell: {
        type: "string",
        description:
          "Optional shell ID. When set, wait monitors that background shell in addition to normal message delivery.",
      },
    },
    required: ["seconds"],
  },
  summaryTemplate: "{agent} is waiting",
};

export const SEND_TOOL: ToolDef = {
  name: "send",
  description:
    "Send a message to a persistent sub-session or team member. " +
    "The message is delivered asynchronously — you get a confirmation, not a reply. " +
    "The target agent auto-activates if idle.",
  parameters: {
    type: "object",
    properties: {
      to: {
        type: "string",
        description: "Target agent ID.",
      },
      content: {
        type: "string",
        description: "Message content.",
      },
    },
    required: ["to", "content"],
  },
  summaryTemplate: "{agent} sent message to {to}",
};

