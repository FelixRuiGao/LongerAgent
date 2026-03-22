import React, { useCallback, useEffect, useRef, useState } from "react";
import { useSession, useSessionRegistry } from "../context";
import { useUiPrefs } from "../App";
import { theme, mono, PROVIDER_INFO, formatTokens } from "../theme";

// ---------------------------------------------------------------------------
// Model tree node (from IPC)
// ---------------------------------------------------------------------------

interface ModelTreeNode {
  kind?: "group" | "provider" | "vendor" | "model" | "action";
  id?: string;
  label: string;
  value: string;
  note?: string;
  isCurrent: boolean;
  keyMissing: boolean;
  keyHint?: string;
  brandKey?: string;
  brandLabel?: string;
  providerId?: string;
  selectionKey?: string;
  modelId?: string;
  children?: ModelTreeNode[];
}

// ---------------------------------------------------------------------------
// StatusBar
// ---------------------------------------------------------------------------

export function StatusBar(): React.ReactElement {
  const { currentModelDisplay, switchModel, tokenInfo, activityPhase } = useSession();
  const { foregroundSessionId } = useSessionRegistry();
  const { openSettings, sidebarCollapsed } = useUiPrefs();
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  // Model tree state — separate sets for providers vs sub-groups to avoid
  // value collisions (e.g., Kimi provider value "kimi" === Kimi-Global sub-group value "kimi")
  const [modelTree, setModelTree] = useState<ModelTreeNode[]>([]);
  const [expandedProviders, setExpandedProviders] = useState<Set<string>>(new Set());
  const [expandedSubGroups, setExpandedSubGroups] = useState<Set<string>>(new Set());

  // Close picker on outside click
  useEffect(() => {
    if (!pickerOpen) return;
    const handler = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [pickerOpen]);

  // Load model tree when picker opens
  useEffect(() => {
    if (!pickerOpen) return;
    const api = (window as any).api;
    if (!api) return;
    if (!foregroundSessionId) return;
    api.invoke("session:getModelTree", foregroundSessionId).then((tree: ModelTreeNode[]) => {
      if (Array.isArray(tree)) {
        setModelTree(tree);
        // Auto-expand only the top-level provider that contains the current model
        const currentProviders = new Set<string>();
        const currentSubs = new Set<string>();
        for (const node of tree) {
          if (nodeContainsCurrent(node)) {
            currentProviders.add(node.value);
            // Also auto-expand the sub-group containing the current model
            if (node.children) {
              for (const child of node.children) {
                if (child.children && nodeContainsCurrent(child)) {
                  currentSubs.add(child.value);
                }
              }
            }
          }
        }
        setExpandedProviders(currentProviders);
        setExpandedSubGroups(currentSubs);
      }
    }).catch(() => {});
  }, [pickerOpen]);

  const toggleProvider = useCallback((value: string) => {
    setExpandedProviders((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  }, []);

  const toggleSubGroup = useCallback((value: string) => {
    setExpandedSubGroups((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  }, []);

  const handleSelectModel = useCallback((value: string, _label: string) => {
    // value is "provider:model" format
    switchModel(value);
    setPickerOpen(false);
  }, [switchModel]);

  // Current model display
  const displayModel = currentModelDisplay?.modelDetailedLabel ?? "No model";
  const providerInfo = currentModelDisplay
    ? PROVIDER_INFO[currentModelDisplay.brandKey.toLowerCase()] ?? {
      label: currentModelDisplay.brandLabel,
      color: theme.muted,
    }
    : undefined;

  // Activity phase display (mirrors TUI status bar)
  const isActive = activityPhase !== "idle";
  const [phaseStartedAt, setPhaseStartedAt] = useState(() => Date.now());
  const [elapsed, setElapsed] = useState(0);

  // Reset timer when phase changes
  useEffect(() => {
    if (isActive) {
      setPhaseStartedAt(Date.now());
    }
  }, [activityPhase, isActive]);

  // Tick elapsed every 100ms while active
  useEffect(() => {
    if (!isActive) { setElapsed(0); return; }
    const timer = setInterval(() => setElapsed(Date.now() - phaseStartedAt), 100);
    return () => clearInterval(timer);
  }, [isActive, phaseStartedAt]);

  const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const [spinnerFrame, setSpinnerFrame] = useState(0);
  useEffect(() => {
    if (!isActive) return;
    const timer = setInterval(() => setSpinnerFrame((f) => (f + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(timer);
  }, [isActive]);

  let activityLabel: string;
  let activityColor = theme.accent;
  switch (activityPhase) {
    case "thinking": activityLabel = "Thinking"; break;
    case "generating": activityLabel = "Generating"; break;
    case "working": activityLabel = "Working"; break;
    case "waiting": activityLabel = "Waiting"; activityColor = theme.warning; break;
    default: activityLabel = "READY"; break;
  }
  const elapsedSuffix = isActive && elapsed >= 1000 ? ` (${(elapsed / 1000).toFixed(1)}s)` : "";

  return (
    <div
      style={{
        width: "100%",
        height: 36,
        minHeight: 36,
        background: theme.surface,
        borderTop: `1px solid ${theme.border}`,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 16px",
        fontFamily: mono,
        fontSize: 12,
        userSelect: "none",
        position: "relative",
      }}
    >
      {/* Left side: activity indicator + model selector */}
      <div style={{ display: "flex", alignItems: "center", gap: 0 }}>
      {/* Activity indicator — fixed width to prevent model picker from shifting */}
      <div style={{ minWidth: 150, display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ color: activityColor, fontSize: 12, width: 12, textAlign: "center" }}>
          {isActive ? SPINNER_FRAMES[spinnerFrame] : "●"}
        </span>
        <span style={{ color: activityColor, fontSize: 11, fontWeight: 500 }}>
          {activityLabel}
        </span>
        {elapsedSuffix && (
          <span style={{ color: theme.muted, fontSize: 11 }}>{elapsedSuffix}</span>
        )}
      </div>

      <span style={{ color: theme.muted, margin: "0 8px" }}>|</span>

      {/* Model selector */}
      <div ref={pickerRef} style={{ position: "relative" }}>
        <button
          type="button"
          onClick={() => setPickerOpen((v) => !v)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            background: pickerOpen ? theme.elevated : "transparent",
            border: "none",
            borderRadius: 4,
            padding: "4px 10px",
            cursor: "pointer",
            color: theme.secondary,
            fontFamily: mono,
            fontSize: 12,
            fontWeight: 500,
            transition: "background 100ms ease, color 100ms ease",
          }}
          onMouseEnter={(e) => { if (!pickerOpen) e.currentTarget.style.background = theme.elevated; }}
          onMouseLeave={(e) => { if (!pickerOpen) e.currentTarget.style.background = "transparent"; }}
        >
          {providerInfo && (
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                padding: "1px 6px",
                borderRadius: 3,
                backgroundColor: `${providerInfo.color}15`,
                border: `1px solid ${providerInfo.color}30`,
                fontSize: 9,
                fontWeight: 600,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                color: providerInfo.color,
                flexShrink: 0,
              }}
            >
              <span style={{ width: 5, height: 5, borderRadius: "50%", backgroundColor: providerInfo.color, flexShrink: 0 }} />
              {providerInfo.label}
            </span>
          )}
          <span style={{ color: theme.text }}>{displayModel}</span>
          <svg
            width="8" height="8" viewBox="0 0 8 8" fill="none"
            stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
            style={{ opacity: 0.5, transform: pickerOpen ? "rotate(180deg)" : "none", transition: "transform 150ms ease" }}
          >
            <path d="M1 3l3 3 3-3" />
          </svg>
        </button>

        {/* Model picker dropdown (opens upward) */}
        {pickerOpen && (
          <div
            style={{
              position: "absolute",
              bottom: "calc(100% + 6px)",
              left: 0,
              minWidth: 300,
              maxWidth: 420,
              maxHeight: 480,
              overflowY: "auto",
              background: theme.elevated,
              border: `1px solid ${theme.borderHover}`,
              borderRadius: 4,
              zIndex: 100,
              padding: "6px 0",
            }}
          >
            {modelTree.length === 0 && (
              <div style={{ padding: "12px 14px", fontSize: 12, color: theme.muted, textAlign: "center" }}>
                Loading models...
              </div>
            )}
            {modelTree.map((providerNode) => (
              <ProviderGroup
                key={providerNode.value}
                node={providerNode}
                expanded={expandedProviders.has(providerNode.value)}
                onToggle={() => toggleProvider(providerNode.value)}
                onSelect={handleSelectModel}
                expandedSubs={expandedSubGroups}
                onToggleSub={toggleSubGroup}
              />
            ))}
          </div>
        )}
      </div>
      </div>{/* end left side */}

      {/* Right side — context info (when sidebar collapsed) + settings */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {sidebarCollapsed && (() => {
          const budget = tokenInfo.contextBudget || 200_000;
          const used = tokenInfo.totalTokens || 0;
          const pct = budget > 0 ? ((used / budget) * 100).toFixed(1) : "0.0";
          return (
            <span style={{ fontSize: 11, color: theme.muted, letterSpacing: "0.01em" }}>
              Context: {pct}%{"  "}{formatTokens(used)} / {formatTokens(budget)}
            </span>
          );
        })()}
        <button
          type="button"
          onClick={() => openSettings()}
          title="Settings"
          style={{
            width: 26,
            height: 26,
            border: "none",
            borderRadius: 4,
            background: "transparent",
            color: theme.muted,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            transition: "color 100ms ease, background 100ms ease",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = theme.secondary; e.currentTarget.style.background = theme.elevated; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = theme.muted; e.currentTarget.style.background = "transparent"; }}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="8" cy="8" r="2" />
            <path d="M13.5 8a5.5 5.5 0 0 0-.08-.82l1.3-1.02a.3.3 0 0 0 .07-.39l-1.23-2.13a.3.3 0 0 0-.37-.13l-1.53.62a5.2 5.2 0 0 0-1.42-.82L9.93 1.6a.3.3 0 0 0-.3-.26H7.17a.3.3 0 0 0-.3.26l-.23 1.64a5.2 5.2 0 0 0-1.42.82L3.7 3.44a.3.3 0 0 0-.37.13L2.1 5.7a.3.3 0 0 0 .07.39l1.3 1.02A5.5 5.5 0 0 0 3.4 8c0 .28.03.55.08.82L2.18 9.84a.3.3 0 0 0-.07.39l1.23 2.13c.08.13.24.18.37.13l1.53-.62c.44.33.91.6 1.42.82l.23 1.64c.03.15.16.26.3.26h2.46c.14 0 .27-.11.3-.26l.23-1.64c.51-.22.98-.49 1.42-.82l1.53.62c.13.05.29 0 .37-.13l1.23-2.13a.3.3 0 0 0-.07-.39l-1.3-1.02c.05-.27.08-.54.08-.82z" />
          </svg>
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helper: check if a tree node or its descendants contain the current model
// ---------------------------------------------------------------------------

function nodeContainsCurrent(node: ModelTreeNode): boolean {
  if (node.isCurrent) return true;
  if (node.children) return node.children.some(nodeContainsCurrent);
  return false;
}

// ---------------------------------------------------------------------------
// Provider group (top-level entry in the model picker)
// ---------------------------------------------------------------------------

function ProviderGroup({
  node,
  expanded,
  onToggle,
  onSelect,
  expandedSubs,
  onToggleSub,
}: {
  node: ModelTreeNode;
  expanded: boolean;
  onToggle: () => void;
  onSelect: (value: string, label: string) => void;
  expandedSubs: Set<string>;
  onToggleSub: (value: string) => void;
}): React.ReactElement {
  const hasChildren = node.children && node.children.length > 0;
  const brandKey = (node.brandKey || node.providerId || node.value).toLowerCase();
  const info = PROVIDER_INFO[brandKey] || { label: node.brandLabel || node.label, color: theme.muted };
  const containsCurrent = nodeContainsCurrent(node);
  const allKeysMissing = node.keyMissing || (node.children?.every((c) => c.keyMissing) ?? false);

  return (
    <div>
      {/* Provider header */}
      <div
        onClick={hasChildren ? onToggle : undefined}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "7px 14px 5px",
          cursor: hasChildren ? "pointer" : "default",
          fontFamily: mono,
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: theme.muted,
          transition: "background 80ms ease",
        }}
        onMouseEnter={(e) => { if (hasChildren) e.currentTarget.style.background = "rgba(255,255,255,0.02)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
      >
        {hasChildren && (
          <span style={{ fontSize: 7, flexShrink: 0, color: theme.muted, width: 8 }}>
            {expanded ? "\u25BC" : "\u25B6"}
          </span>
        )}
        <span style={{ width: 8, height: 8, borderRadius: "50%", backgroundColor: info.color, flexShrink: 0 }} />
        <span style={{ flex: 1 }}>{info.label || node.label}</span>
        {containsCurrent && (
          <span style={{ fontSize: 9, color: theme.accent, fontWeight: 500, letterSpacing: 0 }}>active</span>
        )}
        {allKeysMissing && (
          <span style={{ fontSize: 9, color: theme.warning, fontWeight: 500, letterSpacing: 0 }} title={node.keyHint || "API key not configured"}>
            no key
          </span>
        )}
      </div>

      {/* Children (models or sub-groups) */}
      {expanded && node.children && (
        <div>
          {node.children.map((child) => {
            if (child.children && child.children.length > 0) {
              // Sub-group (e.g., OpenRouter vendor groups, or grouped provider sub-providers)
              return (
                <SubGroup
                  key={child.value}
                  node={child}
                  expanded={expandedSubs.has(child.value)}
                  onToggle={() => onToggleSub(child.value)}
                  onSelect={onSelect}
                  expandedSubs={expandedSubs}
                  onToggleSub={onToggleSub}
                />
              );
            }
            // Leaf model
            return (
              <ModelItem
                key={child.value}
                node={child}
                depth={1}
                onSelect={onSelect}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-group (second level: OpenRouter vendors or grouped provider sub-providers)
// ---------------------------------------------------------------------------

function SubGroup({
  node,
  expanded,
  onToggle,
  onSelect,
  expandedSubs,
  onToggleSub,
}: {
  node: ModelTreeNode;
  expanded: boolean;
  onToggle: () => void;
  onSelect: (value: string, label: string) => void;
  expandedSubs: Set<string>;
  onToggleSub: (value: string) => void;
}): React.ReactElement {
  const containsCurrent = nodeContainsCurrent(node);

  return (
    <div>
      <div
        onClick={onToggle}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "5px 14px 5px 36px",
          cursor: "pointer",
          fontFamily: mono,
          fontSize: 11,
          color: theme.secondary,
          transition: "background 80ms ease",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.03)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
      >
        <span style={{ fontSize: 7, flexShrink: 0, color: theme.muted, width: 8 }}>
          {expanded ? "\u25BC" : "\u25B6"}
        </span>
        <span style={{ flex: 1, fontWeight: 500 }}>{node.label}</span>
        {containsCurrent && (
          <span style={{ fontSize: 9, color: theme.accent, fontWeight: 500 }}>active</span>
        )}
        {node.keyMissing && (
          <span style={{ fontSize: 9, color: theme.warning, fontWeight: 500 }} title={node.keyHint || ""}>
            no key
          </span>
        )}
        <span style={{ fontSize: 10, color: theme.muted }}>
          {node.children?.length ?? 0}
        </span>
      </div>

      {expanded && node.children && (
        <div>
          {node.children.map((child) => {
            if (child.children && child.children.length > 0) {
              // Third level (for deeply nested structures)
              return (
                <SubGroup
                  key={child.value}
                  node={child}
                  expanded={expandedSubs.has(child.value)}
                  onToggle={() => onToggleSub(child.value)}
                  onSelect={onSelect}
                  expandedSubs={expandedSubs}
                  onToggleSub={onToggleSub}
                />
              );
            }
            return (
              <ModelItem
                key={child.value}
                node={child}
                depth={2}
                onSelect={onSelect}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Model item (leaf node — clickable to switch model)
// ---------------------------------------------------------------------------

function ModelItem({
  node,
  depth,
  onSelect,
}: {
  node: ModelTreeNode;
  depth: number;
  onSelect: (value: string, label: string) => void;
}): React.ReactElement {
  const [hovered, setHovered] = useState(false);
  const { openSettings } = useUiPrefs();
  const paddingLeft = 36 + depth * 16;

  const mainLabel = node.label;
  const note = node.note ?? null;
  const detailedLabel = note ? `${mainLabel} (${note})` : mainLabel;

  return (
    <div
      onClick={() => {
        if (node.keyMissing) {
          // Jump to settings Models tab for this provider
          const providerId = node.value.includes(":") ? node.value.split(":")[0] : node.value;
          openSettings("models", providerId);
        } else {
          onSelect(node.value, detailedLabel);
        }
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: `5px 14px 5px ${paddingLeft}px`,
        cursor: "pointer",
        background: node.isCurrent ? theme.accentDim : hovered ? "rgba(255,255,255,0.04)" : "transparent",
        color: node.isCurrent ? theme.accent : node.keyMissing ? theme.muted : theme.text,
        fontSize: 13,
        fontWeight: node.isCurrent ? 500 : 400,
        transition: "background 80ms ease",
        gap: 8,
      }}
    >
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {mainLabel}
        {note && <span style={{ color: theme.muted, fontSize: 11, marginLeft: 6 }}>({note})</span>}
      </span>
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
        {node.keyMissing && (
          <span
            style={{
              fontSize: 9,
              fontFamily: mono,
              color: theme.warning,
              padding: "1px 5px",
              borderRadius: 3,
              border: `1px solid ${theme.warning}30`,
              backgroundColor: `${theme.warning}10`,
              whiteSpace: "nowrap",
            }}
            title={node.keyHint || "API key not configured"}
          >
            no key
          </span>
        )}
        {node.isCurrent && (
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke={theme.accent} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <polyline points="2,8 6,12 14,4" />
          </svg>
        )}
      </div>
    </div>
  );
}
