import { describe, expect, it } from "vitest";

import { buildToolResultArtifacts, inferToolResultLanguage } from "./tool-result-artifacts.js";

const COLORS = {
  accent: "#ffb703",
  border: "#2a2630",
  cyan: "#9cd4cc",
  dim: "#636a76",
  green: "#73a942",
  muted: "#454a54",
  orange: "#fb8500",
  red: "#f05030",
  text: "#d0d6e0",
  thinking: "#454a54",
  thinkingStatus: "#6e4890",
  toolTime: "#8a8078",
  userBg: "#1f1c26",
  yellow: "#e8c468",
} as const;

describe("tool-result artifacts", () => {
  it("builds diff previews with full-row backgrounds for additions and deletions", () => {
    const artifacts = buildToolResultArtifacts({
      text: " 12 +const answer = 42;\n 13 -const answer = 0;",
      toolMetadata: {
        path: "/tmp/example.ts",
        tui_preview: { kind: "diff" },
      },
      colors: COLORS,
    });

    expect(artifacts[0]?.rowBackgroundColor).toBe("#285438");
    expect(artifacts[1]?.rowBackgroundColor).toBe("#6a3232");
    expect(artifacts[0]?.content.chunks[0]?.text).toContain("12 ");
    expect(artifacts[0]?.content.chunks[0]?.fg?.toString()).toBe(artifacts[0]?.content.chunks[1]?.fg?.toString());
    expect(artifacts[1]?.content.chunks[0]?.fg?.toString()).toBe(artifacts[1]?.content.chunks[1]?.fg?.toString());
  });

  it("omits diff hunk header rows from the rendered preview", () => {
    const artifacts = buildToolResultArtifacts({
      text: "   @@ -61,4 +61,3 @@\n 61 +const answer = 42;",
      toolMetadata: {
        path: "/tmp/example.ts",
        tui_preview: { kind: "diff" },
      },
      colors: COLORS,
    });

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.content.toString()).not.toContain("@@");
  });

  it("syntax-highlights unchanged context rows in diff previews", () => {
    const artifacts = buildToolResultArtifacts({
      text: " 14  const answer = 42;",
      toolMetadata: {
        path: "/tmp/example.ts",
        tui_preview: { kind: "diff" },
      },
      colors: COLORS,
    });

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.content.chunks.length).toBeGreaterThan(2);
  });

  it("keeps dim tool results plain without diff backgrounds", () => {
    const artifacts = buildToolResultArtifacts({
      text: "Spawned 2 sub-agent(s)",
      dim: true,
      colors: COLORS,
    });

    expect(artifacts.every((artifact) => artifact.rowBackgroundColor === undefined)).toBe(true);
  });

  it("infers syntax language from tool metadata path", () => {
    expect(
      inferToolResultLanguage({
        kind: "tool_result",
        text: "",
        meta: { toolMetadata: { path: "/tmp/example.rs" } },
      }),
    ).toBe("rust");
  });
});
