/**
 * Session bridge — connects the Electron main process to the SessionRegistry.
 *
 * Handles shared resource initialization (Config, agents, skills, MCP),
 * registry creation, and IPC handler registration for all session:* channels.
 */

import { app, ipcMain, type BrowserWindow } from "electron";
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Resolve the project root directory.
 * esbuild bundles to gui/dist-main/main.js; the banner sets __dirname to that
 * folder, so ../../ always points at the project root regardless of cwd.
 */
function getProjectRoot(): string {
  return resolve(__dirname, "..", "..");
}

import { Config, resolveAssetPaths } from "../../src/config.js";
import { loadTemplates } from "../../src/templates/loader.js";
import { loadSkillsMulti } from "../../src/skills/loader.js";
import { loadMcpServers } from "../../src/mcp-config.js";
import { loadDotenv, setDotenvKey } from "../../src/dotenv.js";
import { getLongerAgentHomeDir } from "../../src/home-path.js";
import {
  isManagedProvider,
  getManagedCredentialSpec,
  hasManagedCredential,
  detectManagedCredentialCandidates,
} from "../../src/managed-provider-credentials.js";
import {
  PROVIDER_PRESETS,
  findProviderPreset,
} from "../../src/provider-presets.js";
import { hasEnvApiKey } from "../../src/model-selection.js";
import {
  buildDefaultRegistry,
  registerSkillCommands,
  resolveModelSelection,
} from "../../src/commands.js";
import { SessionStore } from "../../src/persistence.js";
import type { AgentQuestionDecision } from "../../src/ask.js";
import type { ModelInfo, SessionState } from "../shared/ipc-protocol.js";
import { SessionRegistry, type ManagedSession } from "./session-registry.js";

// ------------------------------------------------------------------
// Module state
// ------------------------------------------------------------------

let registry: SessionRegistry | null = null;
let registeredHandlers = false;

// ------------------------------------------------------------------
// Exports for store-bridge
// ------------------------------------------------------------------

export function getRegistry(): SessionRegistry | null {
  return registry;
}

// ------------------------------------------------------------------
// Setup
// ------------------------------------------------------------------

export async function setupSessionBridge(win: BrowserWindow): Promise<void> {
  // Register IPC handlers first so the renderer never gets "No handler" errors
  registerIpcHandlers(win);

  // Load environment
  loadDotenv(getLongerAgentHomeDir());

  // Resolve asset paths
  const paths = resolveAssetPaths({});
  const projectRoot = getProjectRoot();
  const homeDir = getLongerAgentHomeDir();

  // Load global preferences from a temporary store
  const tempStore = new SessionStore({ projectPath: projectRoot });
  const globalPreferences = tempStore.loadGlobalPreferences() ?? {
    version: 1, thinkingLevel: "default", cacheHitEnabled: true,
  };

  // Auto-detect cloud providers from shell env vars
  const detectedEnvVars: Record<string, string> = {
    ...((globalPreferences as any).providerEnvVars ?? {}),
  };
  try {
    for (const preset of PROVIDER_PRESETS) {
      if (preset.localServer) continue;
      if (isManagedProvider(preset.id)) continue;
      if (detectedEnvVars[preset.id]) continue;
      if (preset.envVar.startsWith("_")) continue;
      const val = process.env[preset.envVar];
      if (typeof val === "string" && val.trim() !== "") {
        detectedEnvVars[preset.id] = preset.envVar;
      }
    }
  } catch { /* non-critical */ }

  // Build Config
  const mcpServers = loadMcpServers(homeDir);
  const config = new Config({
    providerEnvVars: detectedEnvVars,
    localProviders: (globalPreferences as any).localProviders ?? {},
    mcpServers,
  });

  // Initialize MCP
  let mcpManager: unknown = null;
  if (config.mcpServerConfigs.length > 0) {
    try {
      const { MCPClientManager } = await import("../../src/mcp-client.js");
      mcpManager = new MCPClientManager(config.mcpServerConfigs);
    } catch {
      console.warn("MCP client module not available.");
    }
  }

  // Load agent templates
  const bundledTemplates = join(projectRoot, "agent_templates");
  const bundledPrompts = join(projectRoot, "prompts");
  const promptsDirs: string[] = [];
  if (paths.promptsPath) promptsDirs.push(paths.promptsPath);
  promptsDirs.push(bundledPrompts);

  const agents = loadTemplates(
    bundledTemplates,
    config,
    mcpManager as any,
    promptsDirs,
    paths.templatesPath ?? undefined,
  );

  // Identify primary agent name
  const primaryAgentName = agents["main"] ? "main" : Object.keys(agents).sort()[0];
  if (!primaryAgentName) throw new Error("No agent templates found");

  // Load skills
  const bundledSkills = join(projectRoot, "skills");
  const skillRoots: string[] = [];
  if (existsSync(bundledSkills) && statSync(bundledSkills).isDirectory()) {
    skillRoots.push(bundledSkills);
  }
  const userSkillsPath = paths.skillsPath;
  if (userSkillsPath && userSkillsPath !== bundledSkills &&
    existsSync(userSkillsPath) && statSync(userSkillsPath).isDirectory()) {
    skillRoots.push(userSkillsPath);
  }
  const skills = loadSkillsMulti(skillRoots);

  // Create registry
  registry = new SessionRegistry(win, {
    config,
    agents,
    skills,
    skillRoots,
    mcpManager,
    promptsDirs,
    globalPreferences,
  }, primaryAgentName);

  // Create initial session for the cwd project
  const initial = registry.create(projectRoot);
  registry.setForeground(initial.id);

  console.log("[GUI] Session initialized successfully");
}

// ------------------------------------------------------------------
// IPC Handlers
// ------------------------------------------------------------------

function registerIpcHandlers(win: BrowserWindow): void {
  // Push initial state when renderer loads
  win.webContents.on("did-finish-load", () => {
    console.log("[GUI] Renderer loaded, pushing initial state...");
    if (registry) {
      const fg = registry.getForeground();
      if (fg) {
        registry.setForeground(fg.id); // triggers full state push
      }
      // Push active sessions list
      win.webContents.send("session:listActive", registry.listActive());
    }
  });

  if (registeredHandlers) return;
  registeredHandlers = true;

  // Helper: look up a managed session or throw
  function requireSession(sessionId: string): ManagedSession {
    const m = registry?.get(sessionId);
    if (!m) throw new Error(`Session ${sessionId} not found`);
    return m;
  }

  // ==================================================================
  // Session lifecycle
  // ==================================================================

  ipcMain.handle("session:create", async (_event, projectPath: string) => {
    if (!registry) throw new Error("Registry not initialized");
    const managed = registry.create(projectPath);
    return { sessionId: managed.id };
  });

  ipcMain.handle("session:destroy", async (_event, sessionId: string) => {
    if (!registry) return;
    await registry.destroy(sessionId);
  });

  ipcMain.handle("session:setForeground", async (_event, sessionId: string) => {
    if (!registry) throw new Error("Registry not initialized");
    registry.setForeground(sessionId);
  });

  ipcMain.handle("session:listActive", async () => {
    return registry?.listActive() ?? [];
  });

  ipcMain.handle("session:loadIntoNew", async (_event, sessionPath: string, projectPath: string) => {
    if (!registry) throw new Error("Registry not initialized");
    const managed = registry.loadFromDisk(sessionPath, projectPath);
    return { sessionId: managed.id };
  });

  // ==================================================================
  // Session-scoped operations
  // ==================================================================

  ipcMain.handle("session:turn", async (_event, sessionId: string, input: string) => {
    const m = requireSession(sessionId);
    m.abortController = new AbortController();
    registry!.setState(m, "thinking");

    try {
      const result = await m.session.turn(input, { signal: m.abortController.signal });
      if (m.state !== "asking") {
        registry!.setState(m, "idle");
      }
      if (m.id === registry!.foregroundId) {
        registry!.sendTokenUpdate(m);
      }
      return result;
    } catch (err) {
      if (m.state !== "asking") {
        registry!.setState(m, "idle");
      }
      throw err;
    } finally {
      m.abortController = null;
    }
  });

  ipcMain.handle("session:cancel", async (_event, sessionId: string) => {
    const m = requireSession(sessionId);
    if (m.abortController) {
      registry!.setState(m, "cancelling");
      m.abortController.abort();
      m.abortController = null;
    }
    m.session.cancelCurrentTurn?.();
  });

  ipcMain.handle("session:interrupt", async (_event, sessionId: string) => {
    const m = requireSession(sessionId);
    if (!m.session.requestTurnInterrupt) {
      return { accepted: false, reason: "not supported" };
    }
    return m.session.requestTurnInterrupt();
  });

  ipcMain.handle("session:resume", async (_event, sessionId: string) => {
    const m = requireSession(sessionId);
    if (!m.session.resumePendingTurn) {
      throw new Error("Resume not supported");
    }
    m.abortController = new AbortController();
    registry!.setState(m, "thinking");
    try {
      const result = await m.session.resumePendingTurn({ signal: m.abortController.signal });
      registry!.setState(m, "idle");
      return result;
    } catch (err) {
      if (m.state !== "asking") {
        registry!.setState(m, "idle");
      }
      throw err;
    } finally {
      m.abortController = null;
    }
  });

  ipcMain.handle("session:close", async (_event, sessionId: string) => {
    if (!registry) return;
    await registry.destroy(sessionId);
  });

  ipcMain.handle("session:reset", async (_event, sessionId: string) => {
    const m = requireSession(sessionId);
    // Save if the session has turns
    const logData = (m.session as any).getLogForPersistence?.();
    if (logData && (logData.meta.turnCount ?? 0) > 0) {
      // auto-save handled by registry
    }
    m.store.clearSession();
    m.session.resetForNewSession?.(m.store);
    registry!.setState(m, "idle");
    if (m.id === registry!.foregroundId) {
      registry!.sendLogUpdate(m);
      const model = m.session.currentModelConfigName ?? "";
      if (!win.isDestroyed()) {
        win.webContents.send("session:modelChanged", { sessionId: m.id, model });
      }
    }
  });

  ipcMain.handle("session:switchModel", async (_event, sessionId: string, modelConfigName: string) => {
    const m = requireSession(sessionId);
    if (!m.session.switchModel) throw new Error("Model switching not supported");

    m.store.clearSession();
    const resolved = resolveModelSelection(m.session, modelConfigName);
    m.session.switchModel(resolved.selectedConfigName);
    (m.session as any).setPersistedModelSelection?.({
      modelConfigName: resolved.selectedConfigName,
      modelProvider: resolved.modelProvider,
      modelSelectionKey: resolved.modelSelectionKey,
      modelId: resolved.modelId,
    });
    m.session.resetForNewSession?.(m.store);
    registry!.setState(m, "idle");
    if (m.id === registry!.foregroundId) {
      registry!.sendLogUpdate(m);
      if (!win.isDestroyed()) {
        win.webContents.send("session:modelChanged", {
          sessionId: m.id,
          model: m.session.currentModelConfigName ?? resolved.selectedConfigName,
        });
      }
    }
  });

  ipcMain.handle("session:getState", async (_event, sessionId: string) => {
    const m = requireSession(sessionId);
    return {
      state: m.state,
      summary: {
        turnCount: (m.session as any)._turnCount ?? 0,
        compactCount: (m.session as any)._compactCount ?? 0,
        createdAt: (m.session as any)._createdAt ?? "",
        currentModel: m.session.currentModelConfigName ?? "",
      },
      currentModel: m.session.currentModelConfigName ?? "",
      cwd: m.projectPath,
    };
  });

  ipcMain.handle("session:deliverMessage", async (_event, sessionId: string, content: string) => {
    const m = requireSession(sessionId);
    m.session.deliverMessage("user", content);
  });

  ipcMain.handle("ask:resolve", async (_event, sessionId: string, askId: string, decision: unknown) => {
    const m = requireSession(sessionId);
    if (!m.session.resolveAgentQuestionAsk) {
      throw new Error("Ask resolution not supported");
    }
    m.session.resolveAgentQuestionAsk(askId, decision as AgentQuestionDecision);

    if (m.session.hasPendingTurnToResume?.()) {
      registry!.setState(m, "thinking");
      m.abortController = new AbortController();
      try {
        await m.session.resumePendingTurn({ signal: m.abortController.signal });
        registry!.setState(m, "idle");
        if (m.id === registry!.foregroundId) {
          registry!.sendTokenUpdate(m);
        }
      } catch {
        if (m.state !== "asking") {
          registry!.setState(m, "idle");
        }
      } finally {
        m.abortController = null;
      }
    } else if (m.state === "asking") {
      registry!.setState(m, "thinking");
    }
  });

  ipcMain.handle("command:execute", async (_event, sessionId: string, name: string, argStr: string) => {
    const m = requireSession(sessionId);
    const cmdRegistry = buildDefaultRegistry();
    if (m.session.skills) {
      registerSkillCommands(cmdRegistry, m.session.skills as any);
    }
    const cmd = cmdRegistry.lookup(name);
    if (!cmd) return { success: false, error: `Unknown command: ${name}` };

    try {
      const messages: string[] = [];
      await cmd.handler(
        {
          session: m.session,
          showMessage: (text: string) => messages.push(text),
          store: m.store ?? undefined,
          autoSave: () => { /* handled by registry */ },
          resetUiState: () => {
            if (m.abortController) {
              m.abortController.abort();
              m.abortController = null;
            }
            registry!.setState(m, "idle");
          },
          commandRegistry: cmdRegistry,
          exit: () => { app.quit(); },
          onTurnRequested: (content: string) => {
            m.abortController = new AbortController();
            registry!.setState(m, "thinking");
            m.session.turn(content, { signal: m.abortController.signal })
              .then(() => { registry!.setState(m, "idle"); })
              .catch(() => { if (m.state !== "asking") registry!.setState(m, "idle"); })
              .finally(() => { m.abortController = null; });
          },
          onManualSummarizeRequested: (instruction: string) => {
            if (typeof (m.session as any).runManualSummarize !== "function") return;
            m.abortController = new AbortController();
            registry!.setState(m, "thinking");
            (m.session as any).runManualSummarize(instruction, { signal: m.abortController.signal })
              .then(() => { registry!.setState(m, "idle"); })
              .catch(() => { if (m.state !== "asking") registry!.setState(m, "idle"); })
              .finally(() => { m.abortController = null; });
          },
          onManualCompactRequested: (instruction: string) => {
            if (typeof (m.session as any).runManualCompact !== "function") return;
            m.abortController = new AbortController();
            registry!.setState(m, "thinking");
            (m.session as any).runManualCompact(instruction, { signal: m.abortController.signal })
              .then(() => { registry!.setState(m, "idle"); })
              .catch(() => { if (m.state !== "asking") registry!.setState(m, "idle"); })
              .finally(() => { m.abortController = null; });
          },
        },
        argStr,
      );
      return { success: true, messages };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("session:getPreferences", async (_event, sessionId: string) => {
    const m = requireSession(sessionId);
    const { getThinkingLevels } = await import("../../src/config.js");
    const model = (m.session as any).currentModelName ?? "";
    const levels = getThinkingLevels(model);
    return {
      thinkingLevel: (m.session as any).thinkingLevel ?? "default",
      thinkingLevels: levels,
      cacheHitEnabled: (m.session as any).cacheHitEnabled ?? true,
      contextRatio: (m.session as any).contextRatio ?? 1.0,
      accentColor: (m.session as any).accentColor ?? "",
    };
  });

  ipcMain.handle("session:setPreference", async (_event, sessionId: string, key: string, value: unknown) => {
    const m = requireSession(sessionId);
    switch (key) {
      case "thinkingLevel": (m.session as any).thinkingLevel = value; break;
      case "cacheHitEnabled": (m.session as any).cacheHitEnabled = Boolean(value); break;
      case "contextRatio": (m.session as any).contextRatio = Number(value); break;
      case "accentColor": (m.session as any).accentColor = String(value); break;
      default: return;
    }
    // Persist preferences
    persistPreferences(m);
  });

  ipcMain.handle("session:compact", async (_event, sessionId: string, instruction: string) => {
    const m = requireSession(sessionId);
    if (typeof (m.session as any).runManualCompact !== "function") throw new Error("Compact not supported");
    m.abortController = new AbortController();
    registry!.setState(m, "thinking");
    try {
      await (m.session as any).runManualCompact(instruction, { signal: m.abortController.signal });
      registry!.setState(m, "idle");
    } catch (err) {
      if (m.state !== "asking") registry!.setState(m, "idle");
      throw err;
    } finally {
      m.abortController = null;
    }
  });

  ipcMain.handle("session:summarize", async (_event, sessionId: string, instruction: string) => {
    const m = requireSession(sessionId);
    if (typeof (m.session as any).runManualSummarize !== "function") throw new Error("Summarize not supported");
    m.abortController = new AbortController();
    registry!.setState(m, "thinking");
    try {
      await (m.session as any).runManualSummarize(instruction, { signal: m.abortController.signal });
      registry!.setState(m, "idle");
    } catch (err) {
      if (m.state !== "asking") registry!.setState(m, "idle");
      throw err;
    } finally {
      m.abortController = null;
    }
  });

  // ==================================================================
  // Global operations (no sessionId)
  // ==================================================================

  ipcMain.handle("session:getModels", async () => {
    if (!registry) return [];
    const cfg = registry.shared.config as any;
    if (typeof cfg.listModelEntries === "function") {
      try {
        const entries = cfg.listModelEntries() as Array<{
          name: string; provider: string; model: string; hasResolvedApiKey: boolean;
        }>;
        return entries.map((e) => ({
          name: e.name, provider: e.provider, model: e.model, hasResolvedApiKey: e.hasResolvedApiKey,
        }));
      } catch { /* fall through */ }
    }
    return [];
  });

  ipcMain.handle("session:getModelTree", async (_event, sessionId: string) => {
    const m = requireSession(sessionId);
    const cmdRegistry = buildDefaultRegistry();
    const modelCmd = cmdRegistry.lookup("/model");
    if (!modelCmd?.options) return [];
    try {
      const tree = modelCmd.options({ session: m.session, store: m.store ?? undefined });
      function transform(opts: Array<{ label: string; value: string; children?: any[] }>): any[] {
        return opts.map((opt) => {
          const isCurrent = opt.label.includes("(current)");
          const keyMissing = opt.label.includes("key missing") || opt.label.includes("not logged in");
          let keyHint: string | undefined;
          const keyMatch = opt.label.match(/\((key missing:[^)]+)\)/);
          if (keyMatch) keyHint = keyMatch[1];
          const oauthMatch = opt.label.match(/\((not logged in:[^)]+)\)/);
          if (oauthMatch) keyHint = oauthMatch[1];
          let label = opt.label
            .replace(/\s+\(current\)/g, "")
            .replace(/\s+\(current,\s*[^)]*\)/g, "")
            .replace(/\s+\(key missing:[^)]*\)/g, "")
            .replace(/\s+\(not logged in:[^)]*\)/g, "")
            .trim();
          return { label, value: opt.value, isCurrent, keyMissing, keyHint, children: opt.children ? transform(opt.children) : undefined };
        });
      }
      return transform(tree);
    } catch (err) {
      console.error("[GUI] Failed to build model tree:", err);
      return [];
    }
  });

  ipcMain.handle("session:getProviderKeyStatus", async () => {
    const results: any[] = [];
    const seenGroups = new Set<string>();
    const tempStore = new SessionStore({ projectPath: getProjectRoot() });

    for (const preset of PROVIDER_PRESETS) {
      if (preset.group) {
        if (seenGroups.has(preset.group)) continue;
        seenGroups.add(preset.group);
        const groupPresets = PROVIDER_PRESETS.filter((p) => p.group === preset.group);
        const subs = groupPresets.map((gp) => {
          const configured = isManagedProvider(gp.id) ? hasManagedCredential(gp.id) : hasEnvApiKey(gp.envVar);
          const rawCandidates = isManagedProvider(gp.id) ? detectManagedCredentialCandidates(gp.id) : [];
          return {
            id: gp.id, label: gp.subLabel || gp.name, configured, envVar: gp.envVar,
            candidates: rawCandidates.map((c) => ({ envVar: c.envVar, masked: c.value.slice(0, 4) + "..." + c.value.slice(-4) })),
            models: gp.models.map((m) => ({ key: m.key, label: m.label || m.key, note: m.optionNote })),
          };
        });
        results.push({ id: preset.group, label: preset.groupLabel || preset.name, type: "grouped", configured: subs.some((s) => s.configured), envVar: "", candidates: [], models: [], subProviders: subs });
        continue;
      }
      if (preset.localServer) {
        const prefs = tempStore.loadGlobalPreferences();
        const lp = (prefs as any)?.localProviders?.[preset.id];
        results.push({ id: preset.id, label: preset.name, type: "local", configured: !!lp, envVar: "", candidates: [], models: lp ? [{ key: lp.model, label: lp.model, note: `ctx: ${lp.contextLength}` }] : [], localConfig: lp ?? null });
        continue;
      }
      results.push({ id: preset.id, label: preset.name, type: "standard", configured: hasEnvApiKey(preset.envVar), envVar: preset.envVar, candidates: [], models: preset.models.map((m) => ({ key: m.key, label: m.label || m.key, note: m.optionNote })) });
    }
    return results;
  });

  ipcMain.handle("session:setProviderKey", async (_event, providerId: string, apiKey: string) => {
    const spec = getManagedCredentialSpec(providerId);
    if (spec) { setDotenvKey(spec.internalEnvVar, apiKey.trim()); return { success: true, envVar: spec.internalEnvVar }; }
    const preset = findProviderPreset(providerId);
    if (preset?.envVar) { setDotenvKey(preset.envVar, apiKey.trim()); return { success: true, envVar: preset.envVar }; }
    throw new Error(`Cannot determine env var for provider '${providerId}'`);
  });

  ipcMain.handle("session:importProviderKey", async (_event, providerId: string, externalEnvVar: string) => {
    const spec = getManagedCredentialSpec(providerId);
    if (!spec) throw new Error(`Provider '${providerId}' does not use managed credentials`);
    const value = process.env[externalEnvVar];
    if (!value) throw new Error(`Environment variable ${externalEnvVar} is not set`);
    setDotenvKey(spec.internalEnvVar, value.trim());
    return { success: true, envVar: spec.internalEnvVar };
  });

  ipcMain.handle("session:discoverLocalModels", async (_event, providerId: string) => {
    const preset = findProviderPreset(providerId);
    if (!preset?.localServer) throw new Error(`'${providerId}' is not a local provider`);
    const { fetchModelsFromServer } = await import("../../src/model-discovery.js");
    const baseUrl = preset.defaultBaseUrl || `http://localhost:${preset.localServer.defaultPort}/v1`;
    const models = await fetchModelsFromServer(baseUrl);
    return { baseUrl, models };
  });

  ipcMain.handle("session:configureLocalProvider", async (_event, providerId: string, config: { baseUrl: string; model: string; contextLength: number }) => {
    const tempStore = new SessionStore({ projectPath: getProjectRoot() });
    const prefs = tempStore.loadGlobalPreferences() as any;
    const localProviders = prefs.localProviders ?? {};
    localProviders[providerId] = config;
    tempStore.saveGlobalPreferences({ ...prefs, localProviders });
    return { success: true };
  });

  ipcMain.handle("session:getSkills", async () => {
    // Use foreground session or first available
    const fg = registry?.getForeground();
    if (!fg || !(fg.session as any).getAllSkillNames) return [];
    return (fg.session as any).getAllSkillNames().map((s: any) => ({
      name: s.name, description: s.description, enabled: s.enabled,
    }));
  });

  ipcMain.handle("session:setSkillEnabled", async (_event, skillName: string, enabled: boolean) => {
    const fg = registry?.getForeground();
    if (!fg || !(fg.session as any).setSkillEnabled) return;
    (fg.session as any).setSkillEnabled(skillName, enabled);
    (fg.session as any).reloadSkills?.();
    persistPreferences(fg);
  });

  ipcMain.handle("session:getMcpStatus", async () => {
    const fg = registry?.getForeground();
    if (!fg) return { servers: [], totalTools: 0 };
    const mcpManager = (fg.session as any).mcpManager;
    if (!mcpManager) return { servers: [], totalTools: 0 };
    try {
      if (typeof (fg.session as any).ensureMcpReady === "function") {
        await (fg.session as any).ensureMcpReady();
      } else if (typeof mcpManager.connectAll === "function") {
        await mcpManager.connectAll();
      }
    } catch { return { servers: [], totalTools: 0 }; }
    const allTools = mcpManager.getAllTools?.() ?? [];
    const byServer = new Map<string, string[]>();
    for (const tool of allTools) {
      const parts = tool.name.split("__");
      const server = parts.length >= 3 ? parts[1] : "unknown";
      if (!byServer.has(server)) byServer.set(server, []);
      byServer.get(server)!.push(parts.length >= 3 ? parts.slice(2).join("__") : tool.name);
    }
    return { servers: Array.from(byServer.entries()).map(([name, tools]) => ({ name, toolCount: tools.length, tools })), totalTools: allTools.length };
  });

  ipcMain.handle("command:list", async () => {
    const cmdRegistry = buildDefaultRegistry();
    const fg = registry?.getForeground();
    if (fg?.session.skills) {
      registerSkillCommands(cmdRegistry, fg.session.skills as any);
    }
    return cmdRegistry.getAll().map((cmd) => ({ name: cmd.name, description: cmd.description }));
  });
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function persistPreferences(m: ManagedSession): void {
  try {
    if (typeof (m.session as any).getGlobalPreferences !== "function") return;
    const current = (m.session as any).getGlobalPreferences();
    const existing = typeof m.store.loadGlobalPreferences === "function"
      ? m.store.loadGlobalPreferences()
      : undefined;
    m.store.saveGlobalPreferences({
      ...existing,
      ...current,
      providerEnvVars: current.providerEnvVars ?? existing?.providerEnvVars,
      localProviders: current.localProviders ?? existing?.localProviders,
      contextRatio: current.contextRatio ?? existing?.contextRatio,
    });
  } catch { /* ignore */ }
}
