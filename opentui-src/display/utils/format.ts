import type { DisplayThemeLayoutTokens } from "../theme/index.js";

export function formatCompactTokens(value: number | undefined): string {
  const safeValue = value ?? 0;
  if (safeValue >= 1_000_000) {
    const compact = safeValue / 1_000_000;
    return `${compact >= 100 ? compact.toFixed(0) : compact.toFixed(1)}M`;
  }
  if (safeValue >= 100_000) {
    return `${(safeValue / 1_000).toFixed(0)}k`;
  }
  if (safeValue >= 1_000) {
    return `${(safeValue / 1_000).toFixed(1)}k`;
  }
  return `${safeValue}`;
}

export function formatCompactTokensShort(value: number | undefined): string {
  if (value == null || value === 0) return "0";
  if (value < 1000) return String(value);
  return `${(value / 1000).toFixed(1)}k`;
}

export function formatTokens(value: number | undefined): string {
  return (value ?? 0).toLocaleString("en-US");
}

export function formatUsagePercent(contextTokens: number, contextLimit?: number): string {
  if (!contextLimit || contextLimit <= 0) return "0.0%";
  return `${((contextTokens / contextLimit) * 100).toFixed(1)}%`;
}

function getUsageBlockSize(contextLimit?: number): number {
  if (!contextLimit || contextLimit <= 0) return 5_000;
  return contextLimit >= 400_000 ? 20_000 : 5_000;
}

export function getUsageBarRows(
  contextTokens: number,
  contextLimit?: number,
  blocksPerRow = 20,
): Array<{ filled: string; empty: string }> {
  const safeBlocksPerRow = Math.max(1, blocksPerRow);
  const blockSize = getUsageBlockSize(contextLimit);
  const totalBlocks = contextLimit && contextLimit > 0
    ? Math.max(1, Math.ceil(contextLimit / blockSize))
    : safeBlocksPerRow;
  const filledBlocks = Math.max(0, Math.min(totalBlocks, Math.round((contextTokens ?? 0) / blockSize)));
  const rowCount = Math.max(1, Math.ceil(totalBlocks / safeBlocksPerRow));

  return Array.from({ length: rowCount }, (_, rowIndex) => {
    const rowStart = rowIndex * safeBlocksPerRow;
    const rowTotal = Math.min(safeBlocksPerRow, totalBlocks - rowStart);
    const rowFilled = Math.max(0, Math.min(rowTotal, filledBlocks - rowStart));
    const emptyCount = Math.max(0, rowTotal - rowFilled);
    return {
      filled: Array.from({ length: rowFilled }, () => "▆").join(" "),
      empty: Array.from({ length: emptyCount }, () => "▆").join(" "),
    };
  });
}

export function formatExpiryRemaining(expiresAt: Date): string {
  const ms = expiresAt.getTime() - Date.now();
  if (ms <= 0) return "expired";
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 48) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remainHours = hours % 24;
  return remainHours > 0 ? `${days}d ${remainHours}h` : `${days}d`;
}

export function shortenPath(fullPath: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  return home && fullPath.startsWith(home) ? "~" + fullPath.slice(home.length) : fullPath;
}

export function truncateToWidth(text: string, maxWidth: number): string {
  const textWidth = Bun.stringWidth(text);
  if (textWidth <= maxWidth) return text;
  const target = maxWidth - 3;
  if (target <= 0) return "...".slice(0, maxWidth);
  let width = 0;
  let index = 0;
  for (const ch of text) {
    const chWidth = Bun.stringWidth(ch) || 1;
    if (width + chWidth > target) return text.slice(0, index) + "...";
    width += chWidth;
    index += ch.length;
  }
  return text;
}

export function countWrappedDisplayLines(text: string, contentWidth: number): number {
  const safeWidth = Math.max(1, contentWidth);
  const lines = text.split("\n");
  return lines.reduce((sum, line) => {
    const width = Math.max(1, Bun.stringWidth(line || " "));
    return sum + Math.max(1, Math.ceil(width / safeWidth));
  }, 0);
}

export function shouldShowSidebar(terminalWidth: number, layout: DisplayThemeLayoutTokens): boolean {
  return terminalWidth >= layout.minTerminalWidthForSidebar;
}
