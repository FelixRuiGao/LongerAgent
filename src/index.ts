/**
 * Fermi -- Public barrel re-exports.
 *
 * Provides a single import point for all public APIs:
 *
 *   import { Session, Agent, Config, SessionStore } from "fermi";
 *
 * @packageDocumentation
 */

// -- Config ---------------------------------------------------------------
export {
  Config,
  type ModelConfig,
  type MCPServerConfig,
  type ResolvedPaths,
  getContextLength,
  getMultimodalSupport,
  getThinkingSupport,
  getWebSearchSupport,
  resolveAssetPaths,
  getBundledAssetsDir,
  FERMI_HOME_DIR,
} from "./config.js";

// -- Dotenv ---------------------------------------------------------------
export { loadDotenv, setDotenvKey } from "./dotenv.js";

// -- MCP config -----------------------------------------------------------
export { loadMcpServers } from "./mcp-config.js";

// -- Model discovery ------------------------------------------------------
export { fetchModelsFromServer, type DiscoveredModel } from "./model-discovery.js";

// -- Update check ---------------------------------------------------------
export { checkForUpdates } from "./update-check.js";

// -- Session --------------------------------------------------------------
export { Session } from "./session.js";

// -- Plan state -----------------------------------------------------------
export { parsePlanFile, formatPlanSnapshot, PLAN_FILENAME, type PlanCheckpoint } from "./plan-state.js";

// -- Context rendering ----------------------------------------------------
export {
  COMPACT_MARKER_ROLE,
  CONTEXT_ID_KEY,
  isCompactMarker,
  injectContextIdTag,
  mergeConsecutiveSameRole,
  type CompactMarker,
} from "./context-rendering.js";

// -- Agents ---------------------------------------------------------------
export { Agent, type AgentResult, isNoReply, NO_REPLY_MARKER } from "./agents/agent.js";

// -- Providers (base types) -----------------------------------------------
export {
  type ImageBlock,
  type ToolDef,
  type ToolCall,
  type Citation,
  ToolResult,
  Usage,
  ProviderResponse,
  BaseProvider,
  type Message,
  type MessageRole,
  type SendMessageOptions,
} from "./providers/base.js";

// -- Primitives -----------------------------------------------------------
export { prompt, context, combine, type MessageBlock } from "./primitives/context.js";

// -- Network retry --------------------------------------------------------
export {
  isRetryableNetworkError,
  computeRetryDelay,
  retrySleep,
  MAX_NETWORK_RETRIES,
} from "./network-retry.js";

// -- Progress -------------------------------------------------------------
export {
  type ProgressLevel,
  type ProgressEvent,
  type ProgressCallback,
  ProgressReporter,
  ConsoleProgress,
} from "./progress.js";

// -- Persistence ----------------------------------------------------------
export {
  SessionStore,
} from "./persistence.js";

// -- Commands -------------------------------------------------------------
export {
  CommandRegistry,
  type SlashCommand,
  type CommandContext,
  type ShowMessageFn,
  buildDefaultRegistry,
  registerSkillCommands,
} from "./commands.js";

// -- Skills ---------------------------------------------------------------
export {
  loadSkills,
  resolveSkillContent,
  type SkillMeta,
} from "./skills/loader.js";

// -- Templates ------------------------------------------------------------
export {
  loadTemplate,
  loadTemplates,
  assembleSystemPrompt,
  type PromptRecipe,
} from "./templates/loader.js";

// -- Tools ----------------------------------------------------------------
export { BASIC_TOOLS, BASIC_TOOLS_MAP, executeTool } from "./tools/basic.js";
export {
  SPAWN_TOOL,
  KILL_AGENT_TOOL,
  CHECK_STATUS_TOOL,
  WAIT_TOOL,
  DISTILL_CONTEXT_TOOL,
  ASK_TOOL,
} from "./tools/comm.js";

// -- Ask protocol ---------------------------------------------------------
export {
  type AgentQuestion,
  type AgentQuestionItem,
  type AgentQuestionAnswer,
  type AgentQuestionDecision,
} from "./ask.js";

// -- File attach ----------------------------------------------------------
export {
  processFileAttachments,
  scanCandidates,
  type FileAttachResult,
  type FileInfo,
} from "./file-attach.js";

// -- TUI ------------------------------------------------------------------
// NOTE: launchTui is provided by opentui-src/main.ts. We no longer re-export
// it from this barrel file because opentui-src lives outside src/'s rootDir.
// Consumers that need to launch the TUI programmatically should import
// directly from the compiled opentui-src entry at runtime.
export type {
  ConversationEntry,
  ConversationEntryKind,
  LaunchOptions,
} from "./ui/contracts.js";

// -- Version --------------------------------------------------------------
export { VERSION } from "./version.js";
