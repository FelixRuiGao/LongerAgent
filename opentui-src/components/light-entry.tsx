/** @jsxImportSource @opentui/react */

import React, { useEffect, useState } from "react";

import type { ConversationEntryItemProps } from "./conversation-types.js";

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function LiveTimer(
  { startedAt, color }: { startedAt: number; color: string },
): React.ReactElement {
  const [, setTick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setTick((current) => current + 1), 100);
    return () => clearInterval(timer);
  }, []);

  const elapsed = Date.now() - startedAt;
  return <text fg={color} content={` (${formatElapsed(elapsed)})`} flexShrink={0} />;
}

function LightEntryInner(
  { item, colors }: ConversationEntryItemProps,
): React.ReactElement {
  const { entry } = item;

  switch (entry.kind) {
    case "user":
      return (
        <box>
          <box height={1} />
          <box backgroundColor={colors.userBg} paddingLeft={1} paddingRight={1} paddingTop={1} paddingBottom={1}>
            <text fg={colors.text} bold content={entry.text} wrapMode="word" width="100%" />
            {entry.queued ? <text fg={colors.orange} content=" [queued]" /> : null}
          </box>
          <box height={1} />
        </box>
      );
    case "tool_call": {
      const trimmed = entry.text.trim();
      const firstSpace = trimmed.indexOf(" ");
      const parsedToolName = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
      const toolName = typeof entry.meta?.toolName === "string" ? entry.meta.toolName : parsedToolName;
      const restSource = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1);
      const rest = restSource.replace(/\s+/g, " ").trim();
      const isLive = entry.elapsedMs === undefined && entry.startedAt !== undefined;
      const timeDisplay = entry.elapsedMs !== undefined ? formatElapsed(entry.elapsedMs) : null;
      return (
        <box flexDirection="row" width="100%" paddingLeft={2} paddingTop={1}>
          <text fg={colors.cyan} content={toolName} flexShrink={0} />
          {isLive ? <LiveTimer startedAt={entry.startedAt!} color={colors.dim} /> : null}
          {timeDisplay ? <text fg={colors.toolTime} content={` (${timeDisplay})`} flexShrink={0} /> : null}
          {rest ? (
            <text
              fg={colors.muted}
              content={` ${rest}`}
              wrapMode="char"
              flexGrow={1}
              flexShrink={1}
            />
          ) : null}
        </box>
      );
    }
    case "progress":
      return (
        <box paddingLeft={2}>
          <text fg={colors.muted} content={entry.text} />
        </box>
      );
    case "status":
    case "compact_mark":
      return (
        <box paddingLeft={2} paddingTop={1}>
          <text fg={colors.orange} content={entry.text} />
        </box>
      );
    case "error":
      return (
        <box paddingLeft={2} paddingTop={1}>
          <text fg={colors.red} bold content={`[!] ${entry.text}`} />
        </box>
      );
    case "sub_agent_rollup":
      return (
        <box flexDirection="column" paddingLeft={2}>
          <text fg={colors.dim} content={entry.text} />
        </box>
      );
    case "sub_agent_done":
      return (
        <box paddingLeft={2}>
          <text fg={colors.dim} content={entry.text} />
        </box>
      );
    case "interrupted_marker":
      return (
        <box paddingLeft={2}>
          <text fg={colors.orange} content={entry.text} />
        </box>
      );
    default:
      return <box />;
  }
}

export const LightEntry = React.memo(
  LightEntryInner,
  (previous, next) => previous.item === next.item && previous.colors === next.colors,
);
