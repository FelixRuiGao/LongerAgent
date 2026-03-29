const TOOL_NAME_PAD = 10;

export function padToolName(name: string): string {
  return name.length >= TOOL_NAME_PAD
    ? name
    : name + " ".repeat(TOOL_NAME_PAD - name.length);
}

export function formatElapsed(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}m ${s}s`;
}
