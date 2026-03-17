import React, { useCallback, useEffect, useState } from "react";
import { useSession } from "../context";
import { useToast } from "./Toast";
import { theme, mono, sans, humanModelName, PROVIDER_INFO, extractProvider, formatTokens } from "../theme";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
  initialTab?: string;
  initialProvider?: string;
}

interface SessionPreferences {
  thinkingLevel: string;
  thinkingLevels: string[];
  cacheHitEnabled: boolean;
  contextRatio: number;
  accentColor: string;
}

interface SkillInfo {
  name: string;
  description: string;
  enabled: boolean;
}

interface McpServerInfo {
  name: string;
  toolCount: number;
  tools: string[];
}

interface McpStatusInfo {
  servers: McpServerInfo[];
  totalTools: number;
}

interface SubProviderInfo {
  id: string;
  label: string;
  configured: boolean;
  envVar: string;
  candidates: Array<{ envVar: string; masked: string }>;
  models: Array<{ key: string; label: string; note?: string }>;
}

interface ProviderInfo {
  id: string;
  label: string;
  type: "standard" | "grouped" | "local";
  configured: boolean;
  envVar: string;
  candidates: Array<{ envVar: string; masked: string }>;
  models: Array<{ key: string; label: string; note?: string }>;
  subProviders?: SubProviderInfo[];
  localConfig?: { baseUrl: string; model: string; contextLength: number } | null;
}

type SettingsTab = "session" | "models" | "display" | "archive";

const TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: "session", label: "Session" },
  { id: "models", label: "Models" },
  { id: "display", label: "Display" },
  { id: "archive", label: "Archive" },
];

// ---------------------------------------------------------------------------
// SettingsPanel
// ---------------------------------------------------------------------------

export function SettingsPanel({ open, onClose, initialTab, initialProvider }: SettingsPanelProps): React.ReactElement | null {
  const { currentModel, tokenInfo, cwd, models } = useSession();
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState<SettingsTab>("session");

  // Sync initial tab/provider from parent when panel opens
  React.useEffect(() => {
    if (open && initialTab) {
      setActiveTab(initialTab as SettingsTab);
    }
  }, [open, initialTab]);

  // ---- Preferences state ----
  const [prefs, setPrefs] = useState<SessionPreferences>({
    thinkingLevel: "default",
    thinkingLevels: [],
    cacheHitEnabled: true,
    contextRatio: 1.0,
    accentColor: "",
  });

  // ---- Skills state ----
  const [skills, setSkills] = useState<SkillInfo[]>([]);

  // ---- MCP state ----
  const [mcpStatus, setMcpStatus] = useState<McpStatusInfo>({ servers: [], totalTools: 0 });
  const [mcpLoading, setMcpLoading] = useState(false);

  // ---- Provider key status ----
  const [providerKeys, setProviderKeys] = useState<ProviderInfo[]>([]);
  const [keysLoading, setKeysLoading] = useState(false);

  // ---- Load data when panel opens ----
  useEffect(() => {
    if (!open) return;
    const api = (window as any).api;
    if (!api) return;

    api.invoke("session:getPreferences").then((p: SessionPreferences) => {
      if (p) setPrefs(p);
    }).catch(() => {});

    api.invoke("session:getSkills").then((s: SkillInfo[]) => {
      if (Array.isArray(s)) setSkills(s);
    }).catch(() => {});

    setMcpLoading(true);
    api.invoke("session:getMcpStatus").then((status: McpStatusInfo) => {
      if (status) setMcpStatus(status);
    }).catch(() => {}).finally(() => setMcpLoading(false));
  }, [open]);

  // Load provider key status when Models tab is selected
  useEffect(() => {
    if (!open || activeTab !== "models") return;
    const api = (window as any).api;
    if (!api) return;
    setKeysLoading(true);
    api.invoke("session:getProviderKeyStatus").then((status: ProviderInfo[]) => {
      if (Array.isArray(status)) setProviderKeys(status);
    }).catch(() => {}).finally(() => setKeysLoading(false));
  }, [open, activeTab]);

  // ---- Preference setters ----
  const setPref = useCallback((key: string, value: unknown) => {
    const api = (window as any).api;
    if (!api) return;
    api.invoke("session:setPreference", key, value).catch(() => {});
  }, []);

  const handleThinkingChange = useCallback((level: string) => {
    setPrefs((p) => ({ ...p, thinkingLevel: level }));
    setPref("thinkingLevel", level);
    toast(`Thinking level: ${level}`, "info");
  }, [setPref, toast]);

  const handleCacheToggle = useCallback(() => {
    const newValue = !prefs.cacheHitEnabled;
    setPrefs((p) => ({ ...p, cacheHitEnabled: newValue }));
    setPref("cacheHitEnabled", newValue);
    toast(`Prompt caching: ${newValue ? "ON" : "OFF"}`, "info");
  }, [prefs.cacheHitEnabled, setPref, toast]);

  const handleContextRatioChange = useCallback((ratio: number) => {
    setPrefs((p) => ({ ...p, contextRatio: ratio }));
    setPref("contextRatio", ratio);
  }, [setPref]);

  const handleSkillToggle = useCallback((skillName: string, enabled: boolean) => {
    const api = (window as any).api;
    if (!api) return;
    setSkills((prev) => prev.map((s) => s.name === skillName ? { ...s, enabled } : s));
    api.invoke("session:setSkillEnabled", skillName, enabled).catch(() => {});
  }, []);

  const handleCompact = useCallback(() => {
    const api = (window as any).api;
    if (!api) return;
    onClose();
    api.invoke("session:compact", "").then(() => {
      toast("Context compacted", "success");
    }).catch((err: any) => {
      toast(err?.message || "Compact failed", "error");
    });
  }, [onClose, toast]);

  const handleSummarize = useCallback(() => {
    const api = (window as any).api;
    if (!api) return;
    onClose();
    api.invoke("session:summarize", "").then(() => {
      toast("Context summarized", "success");
    }).catch((err: any) => {
      toast(err?.message || "Summarize failed", "error");
    });
  }, [onClose, toast]);

  const refreshProviderKeys = useCallback(() => {
    const api = (window as any).api;
    if (!api) return;
    setKeysLoading(true);
    api.invoke("session:getProviderKeyStatus").then((status: ProviderInfo[]) => {
      if (Array.isArray(status)) setProviderKeys(status);
    }).catch(() => {}).finally(() => setKeysLoading(false));
  }, []);

  if (!open) return null;

  const displayModel = currentModel ? humanModelName(currentModel) : "No model";
  const providerKey = ((models.find((m) => m.name === currentModel) as any)?.provider || (currentModel ? extractProvider(currentModel) : "")).toLowerCase();
  const providerInfo = PROVIDER_INFO[providerKey];
  const budget = tokenInfo.contextBudget || 200_000;
  const pct = Math.min(100, (tokenInfo.totalTokens / budget) * 100);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 200,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "rgba(0, 0, 0, 0.6)",
        animation: "overlayFadeIn 150ms ease-out",
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          width: 640,
          maxHeight: "80vh",
          backgroundColor: theme.surface,
          border: `1px solid ${theme.borderHover}`,
          borderRadius: 4,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          animation: "overlayScaleIn 150ms ease-out",
        }}
      >
        {/* Header with tabs */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "14px 20px 0",
            borderBottom: `1px solid ${theme.border}`,
          }}
        >
          <div style={{ display: "flex", gap: 0 }}>
            {TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                style={{
                  padding: "8px 16px 10px",
                  border: "none",
                  borderBottom: activeTab === tab.id ? `2px solid ${theme.accent}` : "2px solid transparent",
                  background: "transparent",
                  color: activeTab === tab.id ? theme.text : theme.muted,
                  fontFamily: mono,
                  fontSize: 11,
                  fontWeight: activeTab === tab.id ? 600 : 400,
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                  cursor: "pointer",
                  transition: "color 120ms ease, border-color 120ms ease",
                }}
                onMouseEnter={(e) => { if (activeTab !== tab.id) e.currentTarget.style.color = theme.secondary; }}
                onMouseLeave={(e) => { if (activeTab !== tab.id) e.currentTarget.style.color = theme.muted; }}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{ width: 24, height: 24, border: "none", borderRadius: 4, background: "transparent", color: theme.muted, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, transition: "color 100ms ease" }}
            onMouseEnter={(e) => { e.currentTarget.style.color = theme.text; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = theme.muted; }}
          >
            ×
          </button>
        </div>

        {/* Body — scrollable */}
        <div style={{ padding: "16px 20px", overflowY: "auto", flex: 1, minHeight: 0 }}>
          {activeTab === "session" && (
            <SessionTab
              prefs={prefs}
              displayModel={displayModel}
              providerInfo={providerInfo}
              providerKey={providerKey}
              tokenInfo={tokenInfo}
              budget={budget}
              pct={pct}
              cwd={cwd}
              skills={skills}
              mcpStatus={mcpStatus}
              mcpLoading={mcpLoading}
              onThinkingChange={handleThinkingChange}
              onCacheToggle={handleCacheToggle}
              onContextRatioChange={handleContextRatioChange}
              onCompact={handleCompact}
              onSummarize={handleSummarize}
              onSkillToggle={handleSkillToggle}
            />
          )}
          {activeTab === "models" && (
            <ModelsTab
              providers={providerKeys}
              loading={keysLoading}
              onRefresh={refreshProviderKeys}
              initialProvider={initialProvider}
            />
          )}
          {activeTab === "display" && (
            <DisplayTab />
          )}
          {activeTab === "archive" && (
            <ArchiveTab />
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Session Tab
// ---------------------------------------------------------------------------

function SessionTab({
  prefs, displayModel, providerInfo, providerKey, tokenInfo, budget, pct, cwd,
  skills, mcpStatus, mcpLoading,
  onThinkingChange, onCacheToggle, onContextRatioChange, onCompact, onSummarize, onSkillToggle,
}: {
  prefs: SessionPreferences;
  displayModel: string;
  providerInfo: { label: string; color: string } | undefined;
  providerKey: string;
  tokenInfo: { totalTokens: number; contextBudget?: number };
  budget: number;
  pct: number;
  cwd: string;
  skills: SkillInfo[];
  mcpStatus: McpStatusInfo;
  mcpLoading: boolean;
  onThinkingChange: (level: string) => void;
  onCacheToggle: () => void;
  onContextRatioChange: (ratio: number) => void;
  onCompact: () => void;
  onSummarize: () => void;
  onSkillToggle: (name: string, enabled: boolean) => void;
}): React.ReactElement {
  return (
    <>
      {/* Session info */}
      <SettingsSection title="Session">
        <div style={{ fontFamily: mono, fontSize: 11, color: theme.secondary, lineHeight: 2 }}>
          <SettingsRow label="Model" value={displayModel} />
          <SettingsRow label="Provider" value={providerInfo?.label || providerKey || "—"} />
          <SettingsRow label="Context" value={`${formatTokens(tokenInfo.totalTokens)} / ${formatTokens(budget)} (${Math.round(pct)}%)`} />
          {cwd && <SettingsRow label="Directory" value={cwd.replace(/^\/Users\/[^/]+/, "~")} />}
        </div>
      </SettingsSection>

      {/* Thinking Level */}
      {prefs.thinkingLevels.length > 0 && (
        <SettingsSection title="Thinking Level">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            <OptionChip label="default" active={prefs.thinkingLevel === "default"} onClick={() => onThinkingChange("default")} />
            {prefs.thinkingLevels.map((level) => (
              <OptionChip key={level} label={level} active={prefs.thinkingLevel === level} onClick={() => onThinkingChange(level)} />
            ))}
          </div>
        </SettingsSection>
      )}

      {/* Prompt Caching */}
      <SettingsSection title="Prompt Caching">
        <ToggleSwitch checked={prefs.cacheHitEnabled} onChange={onCacheToggle} label={prefs.cacheHitEnabled ? "Enabled" : "Disabled"} />
      </SettingsSection>

      {/* Context */}
      <SettingsSection title="Context">
        <div style={{ fontFamily: mono, fontSize: 11, color: theme.secondary, marginBottom: 10 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
            <span style={{ color: theme.muted }}>Context ratio</span>
            <span style={{ color: theme.text }}>{Math.round(prefs.contextRatio * 100)}%</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="range" min="0.1" max="1.0" step="0.05"
              value={prefs.contextRatio}
              onChange={(e) => onContextRatioChange(parseFloat(e.target.value))}
              style={{ flex: 1, height: 4, appearance: "none", WebkitAppearance: "none", background: theme.border, borderRadius: 2, outline: "none", cursor: "pointer", accentColor: theme.accent }}
            />
          </div>
          <div style={{ fontSize: 10, color: theme.muted, marginTop: 4 }}>Controls effective context window budget</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <ActionButton label="Compact" onClick={onCompact} />
          <ActionButton label="Summarize" onClick={onSummarize} />
        </div>
      </SettingsSection>

      {/* Skills */}
      {skills.length > 0 && (
        <SettingsSection title={`Skills (${skills.filter((s) => s.enabled).length}/${skills.length})`}>
          <div style={{ maxHeight: 200, overflowY: "auto" }}>
            {skills.map((skill) => (
              <SkillRow key={skill.name} skill={skill} onToggle={(enabled) => onSkillToggle(skill.name, enabled)} />
            ))}
          </div>
        </SettingsSection>
      )}

      {/* MCP */}
      <SettingsSection title="MCP Servers">
        {mcpLoading ? (
          <div style={{ fontFamily: mono, fontSize: 11, color: theme.muted }}>Connecting...</div>
        ) : mcpStatus.servers.length === 0 ? (
          <div style={{ fontFamily: mono, fontSize: 11, color: theme.muted }}>No MCP servers configured</div>
        ) : (
          <div>
            <div style={{ fontFamily: mono, fontSize: 11, color: theme.secondary, marginBottom: 8 }}>
              {mcpStatus.servers.length} server{mcpStatus.servers.length !== 1 ? "s" : ""}, {mcpStatus.totalTools} tool{mcpStatus.totalTools !== 1 ? "s" : ""}
            </div>
            {mcpStatus.servers.map((server) => (
              <McpServerRow key={server.name} server={server} />
            ))}
          </div>
        )}
      </SettingsSection>
    </>
  );
}

// ---------------------------------------------------------------------------
// Models Tab — list-detail layout with provider sub-pages
// ---------------------------------------------------------------------------

function ModelsTab({
  providers,
  loading,
  onRefresh,
  initialProvider,
}: {
  providers: ProviderInfo[];
  loading: boolean;
  onRefresh: () => void;
  initialProvider?: string;
}): React.ReactElement {
  const { toast } = useToast();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Auto-select provider from model picker navigation
  React.useEffect(() => {
    if (initialProvider && providers.length > 0) {
      // Find matching provider: could be a group member (e.g., "kimi-cn" → group "kimi")
      const direct = providers.find((p) => p.id === initialProvider);
      if (direct) { setSelectedId(direct.id); return; }
      // Check sub-providers for grouped providers
      const parent = providers.find((p) => p.subProviders?.some((s) => s.id === initialProvider));
      if (parent) { setSelectedId(parent.id); return; }
      setSelectedId(providers[0]?.id ?? null);
    } else if (providers.length > 0 && !selectedId) {
      setSelectedId(providers[0].id);
    }
  }, [initialProvider, providers, selectedId]);

  const handleSetKey = useCallback(async (providerId: string, apiKey: string) => {
    const api = (window as any).api;
    if (!api) return;
    try {
      await api.invoke("session:setProviderKey", providerId, apiKey);
      toast(`API key saved`, "success");
      onRefresh();
    } catch (err: any) {
      toast(err?.message || "Failed to save key", "error");
    }
  }, [toast, onRefresh]);

  const handleImportKey = useCallback(async (providerId: string, envVar: string) => {
    const api = (window as any).api;
    if (!api) return;
    try {
      await api.invoke("session:importProviderKey", providerId, envVar);
      toast(`Imported ${envVar}`, "success");
      onRefresh();
    } catch (err: any) {
      toast(err?.message || "Failed to import key", "error");
    }
  }, [toast, onRefresh]);

  const handleConfigureLocal = useCallback(async (providerId: string, config: { baseUrl: string; model: string; contextLength: number }) => {
    const api = (window as any).api;
    if (!api) return;
    try {
      await api.invoke("session:configureLocalProvider", providerId, config);
      toast(`Configured ${config.model}`, "success");
      onRefresh();
    } catch (err: any) {
      toast(err?.message || "Failed to configure", "error");
    }
  }, [toast, onRefresh]);

  if (loading) {
    return <div style={{ fontFamily: mono, fontSize: 11, color: theme.muted, padding: "20px 0" }}>Loading providers...</div>;
  }

  const selected = providers.find((p) => p.id === selectedId) || null;
  const cloudProviders = providers.filter((p) => p.type !== "local");
  const localProviders = providers.filter((p) => p.type === "local");

  return (
    <div style={{ display: "flex", gap: 0, margin: "-16px -20px", height: "calc(80vh - 100px)", minHeight: 300 }}>
      {/* Left: provider list */}
      <div
        style={{
          width: 180,
          flexShrink: 0,
          borderRight: `1px solid ${theme.border}`,
          overflowY: "auto",
          padding: "8px 0",
        }}
      >
        {/* Cloud providers */}
        {cloudProviders.map((p) => (
          <ProviderListItem
            key={p.id}
            provider={p}
            selected={selectedId === p.id}
            onClick={() => setSelectedId(p.id)}
          />
        ))}

        {/* Local section */}
        {localProviders.length > 0 && (
          <>
            <div style={{ fontFamily: mono, fontSize: 9, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: theme.muted, padding: "10px 12px 4px", opacity: 0.6 }}>
              Local
            </div>
            {localProviders.map((p) => (
              <ProviderListItem
                key={p.id}
                provider={p}
                selected={selectedId === p.id}
                onClick={() => setSelectedId(p.id)}
              />
            ))}
          </>
        )}
      </div>

      {/* Right: detail pane */}
      <div style={{ flex: 1, overflowY: "auto", padding: "12px 16px" }}>
        {selected ? (
          <ProviderDetail
            provider={selected}
            onSetKey={handleSetKey}
            onImportKey={handleImportKey}
            onConfigureLocal={handleConfigureLocal}
          />
        ) : (
          <div style={{ fontFamily: mono, fontSize: 11, color: theme.muted, padding: "20px 0", textAlign: "center" }}>
            Select a provider
          </div>
        )}
      </div>
    </div>
  );
}

// Provider list item (left sidebar of Models tab)
function ProviderListItem({
  provider,
  selected,
  onClick,
}: {
  provider: ProviderInfo;
  selected: boolean;
  onClick: () => void;
}): React.ReactElement {
  const info = PROVIDER_INFO[provider.id] || PROVIDER_INFO[provider.id.split("-")[0]];
  const color = info?.color || theme.muted;

  // For grouped: show sub-provider status compactly
  const statusDot = provider.configured
    ? <span style={{ width: 5, height: 5, borderRadius: "50%", backgroundColor: theme.success, flexShrink: 0 }} />
    : <span style={{ width: 5, height: 5, borderRadius: "50%", border: `1px solid ${theme.muted}`, flexShrink: 0 }} />;

  return (
    <div
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "5px 12px",
        cursor: "pointer",
        borderLeft: selected ? `2px solid ${theme.accent}` : "2px solid transparent",
        background: selected ? theme.accentDim : "transparent",
        transition: "all 100ms ease",
        fontFamily: mono,
        fontSize: 11,
      }}
      onMouseEnter={(e) => { if (!selected) e.currentTarget.style.background = theme.elevated; }}
      onMouseLeave={(e) => { if (!selected) e.currentTarget.style.background = "transparent"; }}
    >
      <span style={{ width: 6, height: 6, borderRadius: "50%", backgroundColor: color, flexShrink: 0 }} />
      <span style={{ flex: 1, color: selected ? theme.text : theme.secondary, fontWeight: selected ? 500 : 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {provider.label}
      </span>
      {statusDot}
    </div>
  );
}

// Provider detail pane (right side of Models tab)
function ProviderDetail({
  provider,
  onSetKey,
  onImportKey,
  onConfigureLocal,
}: {
  provider: ProviderInfo;
  onSetKey: (providerId: string, key: string) => void;
  onImportKey: (providerId: string, envVar: string) => void;
  onConfigureLocal: (providerId: string, config: { baseUrl: string; model: string; contextLength: number }) => void;
}): React.ReactElement {
  const info = PROVIDER_INFO[provider.id] || PROVIDER_INFO[provider.id.split("-")[0]];
  const color = info?.color || theme.muted;

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", backgroundColor: color, flexShrink: 0 }} />
        <span style={{ fontFamily: mono, fontSize: 14, fontWeight: 600, color: theme.text }}>
          {provider.label}
        </span>
        {provider.configured ? (
          <span style={{ fontFamily: mono, fontSize: 9, color: theme.success, padding: "1px 6px", border: `1px solid ${theme.success}30`, borderRadius: 3 }}>
            configured
          </span>
        ) : (
          <span style={{ fontFamily: mono, fontSize: 9, color: theme.warning, padding: "1px 6px", border: `1px solid ${theme.warning}30`, borderRadius: 3 }}>
            no key
          </span>
        )}
      </div>

      {/* --- Standard provider --- */}
      {provider.type === "standard" && (
        <>
          {provider.envVar && (
            <div style={{ fontFamily: mono, fontSize: 10, color: theme.muted, marginBottom: 12 }}>
              ENV: {provider.envVar}
            </div>
          )}

          <KeyConfigSection providerId={provider.id} candidates={provider.candidates} configured={provider.configured} onSetKey={onSetKey} onImportKey={onImportKey} />

          {provider.models.length > 0 && (
            <div style={{ marginTop: 18 }}>
              <div style={{ fontFamily: mono, fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: theme.muted, marginBottom: 8 }}>
                Models ({provider.models.length})
              </div>
              {provider.models.map((m) => {
                const noteRedundant = m.note && m.label.includes(m.note);
                return (
                  <div key={m.key} style={{ fontFamily: mono, fontSize: 11, color: theme.secondary, padding: "4px 0", display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
                    <span style={{ color: theme.text, whiteSpace: "nowrap" }}>{m.label}</span>
                    {m.note && !noteRedundant && <span style={{ fontSize: 9, color: theme.muted, whiteSpace: "nowrap", flexShrink: 0 }}>{m.note}</span>}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* --- Grouped provider (kimi, minimax, glm) --- */}
      {provider.type === "grouped" && provider.subProviders && (
        <div>
          {provider.subProviders.map((sub) => (
            <div key={sub.id} style={{ marginBottom: 16, padding: "10px 12px", border: `1px solid ${theme.border}`, borderRadius: 4 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
                <span style={{ fontFamily: mono, fontSize: 12, fontWeight: 500, color: theme.text }}>{sub.label}</span>
                {sub.configured ? (
                  <span style={{ width: 5, height: 5, borderRadius: "50%", backgroundColor: theme.success, flexShrink: 0 }} />
                ) : (
                  <span style={{ width: 5, height: 5, borderRadius: "50%", border: `1px solid ${theme.muted}`, flexShrink: 0 }} />
                )}
              </div>
              {sub.envVar && (
                <div style={{ fontFamily: mono, fontSize: 10, color: theme.muted, marginBottom: 6 }}>
                  ENV: {sub.envVar}
                </div>
              )}
              <KeyConfigSection providerId={sub.id} candidates={sub.candidates} configured={sub.configured} onSetKey={onSetKey} onImportKey={onImportKey} />
              {sub.models.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  {sub.models.map((m) => (
                    <div key={m.key} style={{ fontFamily: mono, fontSize: 10, color: theme.secondary, padding: "2px 0" }}>
                      {m.label} {m.note && <span style={{ color: theme.muted }}>({m.note})</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* --- Local server --- */}
      {provider.type === "local" && (
        <LocalProviderSection
          provider={provider}
          onConfigure={onConfigureLocal}
        />
      )}
    </div>
  );
}

// Reusable key configuration section (paste + import)
function KeyConfigSection({
  providerId,
  candidates,
  configured,
  onSetKey,
  onImportKey,
}: {
  providerId: string;
  candidates: Array<{ envVar: string; masked: string }>;
  configured: boolean;
  onSetKey: (providerId: string, key: string) => void;
  onImportKey: (providerId: string, envVar: string) => void;
}): React.ReactElement {
  const [keyInput, setKeyInput] = useState("");

  return (
    <div>
      {/* Import candidates */}
      {candidates.length > 0 && (
        <div style={{ marginBottom: 6 }}>
          {candidates.map((c) => (
            <button
              key={c.envVar}
              type="button"
              onClick={() => onImportKey(providerId, c.envVar)}
              style={{
                display: "flex", alignItems: "center", gap: 6, width: "100%",
                padding: "4px 8px", border: `1px solid ${theme.border}`, borderRadius: 3,
                background: "transparent", color: theme.secondary, fontFamily: mono, fontSize: 10,
                cursor: "pointer", textAlign: "left", marginBottom: 3,
                transition: "border-color 120ms ease, color 120ms ease",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = theme.accentBorder; e.currentTarget.style.color = theme.text; }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = theme.border; e.currentTarget.style.color = theme.secondary; }}
            >
              <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 3v10M4 9l4 4 4-4" />
              </svg>
              Import {c.envVar} ({c.masked})
            </button>
          ))}
        </div>
      )}

      {/* Paste key */}
      <div style={{ display: "flex", gap: 6 }}>
        <input
          type="password"
          placeholder={configured ? "Replace key..." : "Paste API key..."}
          value={keyInput}
          onChange={(e) => setKeyInput(e.target.value)}
          style={{
            flex: 1, padding: "4px 8px", border: `1px solid ${theme.border}`, borderRadius: 3,
            background: theme.bg, color: theme.text, fontFamily: mono, fontSize: 11, outline: "none",
          }}
          onFocus={(e) => { e.target.style.borderColor = theme.accentBorder; }}
          onBlur={(e) => { e.target.style.borderColor = theme.border; }}
          onKeyDown={(e) => { if (e.key === "Enter" && keyInput.trim()) { onSetKey(providerId, keyInput); setKeyInput(""); } }}
        />
        <button
          type="button"
          onClick={() => { if (keyInput.trim()) { onSetKey(providerId, keyInput); setKeyInput(""); } }}
          disabled={!keyInput.trim()}
          style={{
            padding: "4px 10px", border: `1px solid ${keyInput.trim() ? theme.accent : theme.border}`, borderRadius: 3,
            background: keyInput.trim() ? theme.accent : "transparent", color: keyInput.trim() ? theme.bg : theme.muted,
            fontFamily: mono, fontSize: 10, fontWeight: 600, cursor: keyInput.trim() ? "pointer" : "default",
            transition: "all 120ms ease",
          }}
        >
          Save
        </button>
      </div>
    </div>
  );
}

// Local provider discover + configure section
function LocalProviderSection({
  provider,
  onConfigure,
}: {
  provider: ProviderInfo;
  onConfigure: (providerId: string, config: { baseUrl: string; model: string; contextLength: number }) => void;
}): React.ReactElement {
  const [discovering, setDiscovering] = useState(false);
  const [discovered, setDiscovered] = useState<Array<{ id: string; contextLength?: number }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ctxInput, setCtxInput] = useState("131072");

  const handleDiscover = useCallback(async () => {
    const api = (window as any).api;
    if (!api) return;
    setDiscovering(true);
    setError(null);
    setDiscovered(null);
    try {
      const result = await api.invoke("session:discoverLocalModels", provider.id);
      if (result.models.length === 0) {
        setError("No models found. Is the server running?");
      } else {
        setDiscovered(result.models);
      }
    } catch (err: any) {
      setError(err?.message || "Discovery failed");
    } finally {
      setDiscovering(false);
    }
  }, [provider.id]);

  const handleSelect = useCallback((modelId: string, ctxLen?: number) => {
    const preset = { baseUrl: "", model: modelId, contextLength: ctxLen || parseInt(ctxInput) || 131072 };
    // Derive baseUrl from provider defaults
    const defaultPorts: Record<string, number> = { ollama: 11434, omlx: 8000, lmstudio: 1234 };
    const port = defaultPorts[provider.id] || 8000;
    preset.baseUrl = `http://localhost:${port}/v1`;
    onConfigure(provider.id, preset);
    setDiscovered(null);
  }, [provider.id, onConfigure, ctxInput]);

  return (
    <div>
      {provider.localConfig ? (
        <>
          <div style={{ fontFamily: mono, fontSize: 11, color: theme.secondary, lineHeight: 2, marginBottom: 12 }}>
            <SettingsRow label="URL" value={provider.localConfig.baseUrl} />
            <SettingsRow label="Model" value={provider.localConfig.model} />
            <SettingsRow label="Context" value={String(provider.localConfig.contextLength)} />
          </div>
          <ActionButton label="Rediscover" onClick={handleDiscover} />
        </>
      ) : (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontFamily: mono, fontSize: 11, color: theme.muted, marginBottom: 12 }}>
            No model configured. Discover available models from the local server.
          </div>
          <ActionButton label={discovering ? "Scanning..." : "Discover Models"} onClick={handleDiscover} />
        </div>
      )}

      {error && (
        <div style={{ fontFamily: mono, fontSize: 10, color: theme.warning, marginTop: 8, padding: "6px 8px", border: `1px solid ${theme.warning}30`, borderRadius: 4, backgroundColor: `${theme.warning}08` }}>
          {error}
        </div>
      )}

      {discovered && discovered.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontFamily: mono, fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: theme.muted, marginBottom: 8 }}>
            Found {discovered.length} model{discovered.length !== 1 ? "s" : ""}
          </div>
          {discovered.map((m) => (
            <div
              key={m.id}
              onClick={() => handleSelect(m.id, m.contextLength)}
              style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                padding: "6px 8px", marginBottom: 4, borderRadius: 4,
                border: `1px solid ${theme.border}`, cursor: "pointer",
                fontFamily: mono, fontSize: 11,
                transition: "border-color 120ms ease, background 120ms ease",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = theme.accentBorder; e.currentTarget.style.background = theme.accentDim; }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = theme.border; e.currentTarget.style.background = "transparent"; }}
            >
              <span style={{ color: theme.text }}>{m.id}</span>
              <span style={{ fontSize: 9, color: theme.muted }}>
                {m.contextLength ? `ctx: ${m.contextLength.toLocaleString()}` : ""}
              </span>
            </div>
          ))}
          {!discovered.some((m) => m.contextLength) && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}>
              <span style={{ fontFamily: mono, fontSize: 10, color: theme.muted }}>Context length:</span>
              <input
                type="number"
                value={ctxInput}
                onChange={(e) => setCtxInput(e.target.value)}
                style={{
                  width: 80, padding: "3px 6px", border: `1px solid ${theme.border}`, borderRadius: 3,
                  background: theme.bg, color: theme.text, fontFamily: mono, fontSize: 10, outline: "none",
                }}
                onFocus={(e) => { e.target.style.borderColor = theme.accentBorder; }}
                onBlur={(e) => { e.target.style.borderColor = theme.border; }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Display Tab
// ---------------------------------------------------------------------------

function DisplayTab(): React.ReactElement {
  return (
    <>
      {/* Zoom */}
      <SettingsSection title="Display">
        <ZoomControl />
      </SettingsSection>

      {/* Keyboard */}
      <SettingsSection title="Keyboard">
        <div style={{ fontFamily: mono, fontSize: 11, color: theme.secondary, lineHeight: 1.8 }}>
          {[
            ["Send message", "Enter"],
            ["New line", "Shift+Enter"],
            ["Cancel turn", "Esc"],
            ["Toggle sidebar", "\u2318B"],
            ["Focus input", "\u2318L"],
            ["New session", "\u2318N"],
            ["Settings", "\u2318,"],
            ["Search messages", "\u2318F"],
            ["Commands", "/"],
            ["Shortcut help", "\u2318/"],
          ].map(([desc, key]) => (
            <div key={desc} style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ color: theme.muted }}>{desc}</span>
              <kbd style={kbdStyle}>{key}</kbd>
            </div>
          ))}
        </div>
      </SettingsSection>

      {/* About */}
      <SettingsSection title="About">
        <div style={{ fontFamily: mono, fontSize: 11, color: theme.muted, lineHeight: 1.8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
            <div style={{ width: 4, height: 14, backgroundColor: theme.accent, borderRadius: 1 }} />
            <span style={{ color: theme.text, fontWeight: 600 }}>LongerAgent Desktop</span>
          </div>
          <div>Forge Design System</div>
          <div style={{ marginTop: 4, color: theme.muted, fontSize: 10 }}>
            Three-layer context · Parallel sub-agents · Persistent memory
          </div>
          <div style={{ marginTop: 4 }}>
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                const api = (window as any).api;
                if (api) api.invoke("shell:openExternal", "https://github.com/FelixRuiGao/LongerAgent").catch(() => {});
              }}
              style={{ color: theme.accent, fontSize: 10, textDecoration: "none", borderBottom: `1px solid ${theme.accentBorder}` }}
            >
              GitHub · FelixRuiGao/LongerAgent
            </a>
          </div>
        </div>
      </SettingsSection>
    </>
  );
}

// ---------------------------------------------------------------------------
// Shared sub-components
// ---------------------------------------------------------------------------

function SettingsSection({ title, children }: { title: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ fontFamily: mono, fontSize: 10, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: theme.muted, marginBottom: 10 }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function SettingsRow({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
      <span style={{ color: theme.muted, flexShrink: 0 }}>{label}</span>
      <span style={{ color: theme.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "right" }}>{value}</span>
    </div>
  );
}

function OptionChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: "4px 12px",
        borderRadius: 4,
        border: `1px solid ${active ? theme.accentBorder : theme.borderHover}`,
        background: active ? theme.accentDim : "transparent",
        color: active ? theme.accent : theme.secondary,
        fontFamily: mono,
        fontSize: 11,
        fontWeight: active ? 600 : 400,
        cursor: "pointer",
        transition: "all 100ms ease",
        letterSpacing: "0.02em",
      }}
      onMouseEnter={(e) => { if (!active) e.currentTarget.style.borderColor = theme.accentBorder; }}
      onMouseLeave={(e) => { if (!active) e.currentTarget.style.borderColor = theme.borderHover; }}
    >
      {label}
    </button>
  );
}

function ToggleSwitch({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }): React.ReactElement {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer" }} onClick={onChange}>
      <span style={{ fontFamily: mono, fontSize: 11, color: theme.secondary }}>{label}</span>
      <div
        style={{
          width: 36, height: 20, borderRadius: 3,
          backgroundColor: checked ? theme.accent : theme.border,
          padding: 2, cursor: "pointer", transition: "background-color 200ms ease", position: "relative",
        }}
      >
        <div
          style={{
            width: 16, height: 16, borderRadius: 2,
            backgroundColor: checked ? theme.bg : theme.muted,
            transition: "transform 200ms ease, background-color 200ms ease",
            transform: checked ? "translateX(16px)" : "translateX(0)",
          }}
        />
      </div>
    </div>
  );
}

function ActionButton({ label, onClick }: { label: string; onClick: () => void }): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: "5px 14px", borderRadius: 4,
        border: `1px solid ${theme.borderHover}`, background: theme.elevated,
        color: theme.secondary, fontFamily: mono, fontSize: 11, fontWeight: 500,
        cursor: "pointer", transition: "all 100ms ease", letterSpacing: "0.02em",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = theme.accentBorder; e.currentTarget.style.color = theme.accent; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = theme.borderHover; e.currentTarget.style.color = theme.secondary; }}
    >
      {label}
    </button>
  );
}

function SkillRow({ skill, onToggle }: { skill: SkillInfo; onToggle: (enabled: boolean) => void }): React.ReactElement {
  return (
    <div
      style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "5px 4px", borderRadius: 3, cursor: "pointer", transition: "background 80ms ease" }}
      onClick={() => onToggle(!skill.enabled)}
      onMouseEnter={(e) => { e.currentTarget.style.background = theme.elevated; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
    >
      <div
        style={{
          width: 14, height: 14, borderRadius: 3,
          border: `1.5px solid ${skill.enabled ? theme.accent : theme.muted}`,
          backgroundColor: skill.enabled ? theme.accentDim : "transparent",
          display: "flex", alignItems: "center", justifyContent: "center",
          flexShrink: 0, marginTop: 1, transition: "all 150ms ease",
        }}
      >
        {skill.enabled && (
          <svg width="8" height="8" viewBox="0 0 16 16" fill="none" stroke={theme.accent} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3,8 6.5,11.5 13,5" />
          </svg>
        )}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: mono, fontSize: 11, color: skill.enabled ? theme.text : theme.secondary, fontWeight: 500 }}>{skill.name}</div>
        <div style={{ fontSize: 10, color: theme.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{skill.description}</div>
      </div>
    </div>
  );
}

function McpServerRow({ server }: { server: McpServerInfo }): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  return (
    <div style={{ marginBottom: 4 }}>
      <div
        style={{
          display: "flex", alignItems: "center", gap: 6, padding: "4px 6px", borderRadius: 3,
          cursor: "pointer", fontFamily: mono, fontSize: 11, color: theme.secondary, transition: "background 80ms ease",
        }}
        onClick={() => setExpanded(!expanded)}
        onMouseEnter={(e) => { e.currentTarget.style.background = theme.elevated; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
      >
        <span style={{ fontSize: 8, flexShrink: 0, color: theme.muted }}>{expanded ? "\u25BC" : "\u25B6"}</span>
        <span style={{ color: theme.accent, fontWeight: 500 }}>{server.name}</span>
        <span style={{ color: theme.muted }}>({server.toolCount} tool{server.toolCount !== 1 ? "s" : ""})</span>
      </div>
      {expanded && (
        <div style={{ paddingLeft: 22 }}>
          {server.tools.map((tool) => (
            <div key={tool} style={{ fontFamily: mono, fontSize: 10, color: theme.muted, padding: "1px 0" }}>{tool}</div>
          ))}
        </div>
      )}
    </div>
  );
}

function ZoomControl(): React.ReactElement {
  const [zoom, setZoom] = useState(() => {
    const stored = localStorage.getItem("longeragent-zoom");
    return stored ? parseInt(stored, 10) : 100;
  });
  useEffect(() => {
    document.documentElement.style.fontSize = `${zoom}%`;
    localStorage.setItem("longeragent-zoom", String(zoom));
  }, [zoom]);
  return (
    <div style={{ fontFamily: mono, fontSize: 11, color: theme.secondary }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <span style={{ color: theme.muted }}>Zoom</span>
        <span style={{ color: theme.text }}>{zoom}%</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button type="button" onClick={() => setZoom((z) => Math.max(80, z - 10))} style={zoomBtnStyle}>−</button>
        <div style={{ flex: 1, height: 4, borderRadius: 2, backgroundColor: theme.border, position: "relative" }}>
          <div style={{ position: "absolute", left: 0, top: 0, height: "100%", width: `${((zoom - 80) / 60) * 100}%`, backgroundColor: theme.accent, borderRadius: 2, transition: "width 100ms ease" }} />
        </div>
        <button type="button" onClick={() => setZoom((z) => Math.min(140, z + 10))} style={zoomBtnStyle}>+</button>
      </div>
      {zoom !== 100 && (
        <button
          type="button" onClick={() => setZoom(100)}
          style={{ marginTop: 6, border: "none", background: "transparent", color: theme.muted, fontFamily: mono, fontSize: 10, cursor: "pointer", padding: 0 }}
        >
          Reset to 100%
        </button>
      )}
    </div>
  );
}

const zoomBtnStyle: React.CSSProperties = {
  width: 24, height: 24, border: `1px solid ${theme.borderHover}`, borderRadius: 4,
  backgroundColor: theme.elevated, color: theme.text, cursor: "pointer",
  display: "flex", alignItems: "center", justifyContent: "center",
  fontFamily: mono, fontSize: 14, fontWeight: 600,
};

const kbdStyle: React.CSSProperties = {
  padding: "2px 6px", borderRadius: 3, border: `1px solid ${theme.borderHover}`,
  backgroundColor: theme.elevated, fontFamily: mono, fontSize: 10, lineHeight: 1,
};

// ---------------------------------------------------------------------------
// Archive Tab
// ---------------------------------------------------------------------------

interface ArchivedSession {
  path: string;
  created: string;
  summary: string;
  title?: string;
  turns: number;
}

interface ArchivedProject {
  originalPath: string;
  sessions: ArchivedSession[];
}

function ArchiveTab(): React.ReactElement {
  const [projects, setProjects] = useState<ArchivedProject[]>([]);
  const [loading, setLoading] = useState(true);

  const loadArchived = useCallback(async () => {
    const api = (window as any).api;
    if (!api) return;
    setLoading(true);
    try {
      const allProjects = await api.invoke("store:listProjects");
      const results: ArchivedProject[] = [];
      for (const p of allProjects) {
        const archived = await api.invoke("store:listArchivedSessions", p.originalPath);
        if (Array.isArray(archived) && archived.length > 0) {
          results.push({ originalPath: p.originalPath, sessions: archived });
        }
      }
      setProjects(results);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { loadArchived(); }, [loadArchived]);

  const handleUnarchive = useCallback(async (sessionPath: string) => {
    const api = (window as any).api;
    if (!api) return;
    await api.invoke("store:unarchiveSession", sessionPath);
    loadArchived();
  }, [loadArchived]);

  if (loading) {
    return React.createElement("div", {
      style: { padding: 24, color: theme.muted, fontFamily: mono, fontSize: 12 },
    }, "Loading...");
  }

  if (projects.length === 0) {
    return React.createElement("div", {
      style: { padding: 24, color: theme.muted, fontFamily: mono, fontSize: 12, textAlign: "center" },
    }, "No archived sessions");
  }

  return React.createElement("div", { style: { padding: "16px 24px" } },
    projects.map((project) => {
      const label = project.originalPath.replace(/^\/Users\/[^/]+/, "~");
      return React.createElement("div", { key: project.originalPath, style: { marginBottom: 16 } },
        React.createElement("div", {
          style: {
            fontFamily: mono, fontSize: 11, fontWeight: 600,
            color: theme.secondary, letterSpacing: "0.02em", marginBottom: 6,
          },
        }, label),
        project.sessions.map((s) => {
          const name = s.title || s.summary || "Untitled";
          return React.createElement("div", {
            key: s.path,
            style: {
              display: "flex", alignItems: "center", justifyContent: "space-between",
              padding: "5px 8px", borderRadius: 4, marginBottom: 1,
              fontSize: 12, color: theme.secondary, fontFamily: sans,
            },
          },
            React.createElement("span", {
              style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 },
            }, name),
            React.createElement("button", {
              type: "button",
              onClick: () => handleUnarchive(s.path),
              style: {
                border: `1px solid ${theme.border}`, borderRadius: 4,
                background: "transparent", color: theme.muted, cursor: "pointer",
                fontFamily: mono, fontSize: 10, padding: "2px 8px", flexShrink: 0, marginLeft: 8,
                transition: "color 100ms ease, border-color 100ms ease",
              },
              onMouseEnter: (e: React.MouseEvent<HTMLButtonElement>) => { e.currentTarget.style.color = theme.accent; e.currentTarget.style.borderColor = theme.accentBorder; },
              onMouseLeave: (e: React.MouseEvent<HTMLButtonElement>) => { e.currentTarget.style.color = theme.muted; e.currentTarget.style.borderColor = theme.border; },
            }, "Unarchive"),
          );
        }),
      );
    }),
  );
}
