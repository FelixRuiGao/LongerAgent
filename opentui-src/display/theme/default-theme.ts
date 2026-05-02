import { RGBA, SyntaxStyle } from "@opentui/core";

import type {
  DeepPartial,
  DisplayTheme,
  DisplayThemeColorTokens,
  DisplayThemeTokens,
} from "./types.js";

const DEFAULT_DISPLAY_TOKENS: DisplayThemeTokens = {
  colors: {
    background: "transparent",
    panel: "transparent",
    userBg: "#322e3e",
    border: "#2a2630",
    separator: "#2a2630",
    scrollbarTrack: "#2a263044",
    text: "#d0d6e0",
    dim: "#636a76",
    muted: "#454a54",
    accent: "#8ab4f8",
    orange: "#fb8500",
    red: "#f85656",
    magenta: "#e81860",
    purple: "#a010a0",
    yellow: "#e8c468",
    green: "#8cc252",
    cyan: "#86ded4",
    thinking: "#5c626e",
    toolTime: "#8a8078",
    readyStatus: "#fb8500",
    thinkingStatus: "#6e4890",
    workingStatus: "#8ab4f8",
    generatingStatus: "#ffb703",
    waitingStatus: "#e8c468",
    closingStatus: "#4d4843",
    errorStatus: "#f05030",
  },
  spacing: {
    screenPaddingX: 0,
    screenPaddingY: 0,
    screenGap: 1,
    sectionGap: 1,
    contentInset: 2,
    surfacePaddingX: 1,
    surfacePaddingY: 0,
    inlineResultIndent: 4,
  },
  layout: {
    inputMaxVisibleLines: 10,
    pickerVisibleRatio: 0.4,
    pickerMinVisible: 5,
    sidebarMinWidth: 30,
    sidebarMaxWidth: 50,
    sidebarCollapsedWidth: 4,
    minTerminalWidthForSidebar: 120,
    minTerminalWidthForLogoHeader: 72,
    minTerminalHeightForLogoHeader: 28,
  },
  branding: {
    appVersion: "v0.1.3",
    logoLines: [
      "░██████████░██████████ ░█████████  ░███     ░███ ░██████",
      "░██        ░██         ░██     ░██ ░████   ░████   ░██  ",
      "░██        ░██         ░██     ░██ ░██░██ ░██░██   ░██  ",
      "░█████████ ░█████████  ░█████████  ░██ ░████ ░██   ░██  ",
      "░██        ░██         ░██   ░██   ░██  ░██  ░██   ░██  ",
      "░██        ░██         ░██    ░██  ░██       ░██   ░██  ",
      "░██        ░██████████ ░██     ░██ ░██       ░██ ░██████",
    ],
    logoGradient: ["#8ab4f8", "#7b9bf0", "#7a80e6", "#8a65dd", "#a050d0", "#b838b8", "#9020a0"],
    sidebarWordmark: "FERMI",
    sidebarGradientIndices: [0, 1, 3, 5, 6],
  },
  markdown: {
    codeBorder: "#2a2630",
    codeBorderHover: "#504860",
    codeLabelForeground: "#636a76",
    codeCopyForeground: "#454a54",
    codeCopyFlash: "#8ab4f8",
    codeForeground: "#a0a8b4",
    syntax: {
      keyword: "#e0a050",
      string: "#8aad6a",
      function: "#d0a0d0",
      type: "#e8c468",
      number: "#d08770",
      comment: "#5a5565",
      operator: "#9098a8",
      literal: "#6aa8a0",
      variable: "#b0b8c4",
      headingPrimary: "#f09418",
      headingSecondary: "#eca903",
      raw: "#b4a0ec",
    },
    hljs: {
      "hljs-keyword": "#e0a050",
      "hljs-built_in": "#6aa8a0",
      "hljs-type": "#e8c468",
      "hljs-literal": "#6aa8a0",
      "hljs-number": "#d08770",
      "hljs-string": "#8aad6a",
      "hljs-subst": "#b0b8c4",
      "hljs-symbol": "#d08770",
      "hljs-class": "#e8c468",
      "hljs-function": "#d0a0d0",
      "hljs-title": "#d0a0d0",
      "hljs-title.function_": "#d0a0d0",
      "hljs-title.class_": "#e8c468",
      "hljs-params": "#b0b8c4",
      "hljs-comment": "#5a5565",
      "hljs-doctag": "#636a76",
      "hljs-meta": "#636a76",
      "hljs-meta-keyword": "#e0a050",
      "hljs-meta-string": "#8aad6a",
      "hljs-section": "#ffb703",
      "hljs-tag": "#e0a050",
      "hljs-name": "#e81860",
      "hljs-attr": "#e8c468",
      "hljs-attribute": "#e8c468",
      "hljs-variable": "#b0b8c4",
      "hljs-bullet": "#d08770",
      "hljs-code": "#a0a8b4",
      "hljs-formula": "#d08770",
      "hljs-link": "#6aa8a0",
      "hljs-quote": "#5a5565",
      "hljs-selector-tag": "#e81860",
      "hljs-selector-id": "#e8c468",
      "hljs-selector-class": "#d0a0d0",
      "hljs-selector-attr": "#e8c468",
      "hljs-selector-pseudo": "#d0a0d0",
      "hljs-template-tag": "#e0a050",
      "hljs-template-variable": "#e81860",
      "hljs-addition": "#8aad6a",
      "hljs-deletion": "#f05030",
      "hljs-regexp": "#d08770",
    },
  },
  presentation: {
    categoryColors: {
      observe: "#86ded4",
      modify: "#e8c468",
      orchestrate: "#b4a0ec",
    },
    thinkingColor: "#5a7eb0",
    successColor: "#2e9e53",
    errorColor: "#f85656",
    toolNameColor: "#8ab4f8",
    modelProviderColors: {
      openai: "#10a37f",
      "openai-codex": "#10a37f",
      kimi: "#38bdf8",
      "kimi-cn": "#38bdf8",
      "kimi-code": "#38bdf8",
      minimax: "#f472b6",
      "minimax-cn": "#f472b6",
      glm: "#818cf8",
      "glm-intl": "#818cf8",
      "glm-code": "#818cf8",
      "glm-intl-code": "#818cf8",
      openrouter: "#c084fc",
      lmstudio: "#9ca3af",
      omlx: "#9ca3af",
      ollama: "#9ca3af",
      anthropic: "#e6c3a5",
    },
  },
};

function mergeNested<T extends object>(base: T, overrides?: DeepPartial<T>): T {
  if (!overrides) return { ...base };
  const baseRecord = base as Record<string, unknown>;
  const overridesRecord = overrides as Record<string, unknown>;
  const result: Record<string, unknown> = { ...baseRecord };

  for (const key of Object.keys(overridesRecord)) {
    const overrideValue = overridesRecord[key];
    if (overrideValue === undefined) continue;
    const baseValue = baseRecord[key];

    if (
      baseValue &&
      overrideValue &&
      typeof baseValue === "object" &&
      typeof overrideValue === "object" &&
      !Array.isArray(baseValue) &&
      !Array.isArray(overrideValue)
    ) {
      result[key as string] = mergeNested(
        baseValue as Record<string, unknown>,
        overrideValue as DeepPartial<Record<string, unknown>>,
      );
      continue;
    }

    result[key as string] = overrideValue;
  }

  return result as T;
}

function buildMarkdownStyle(colors: DisplayThemeColorTokens, tokens: DisplayThemeTokens["markdown"]): SyntaxStyle {
  const kw = RGBA.fromHex(tokens.syntax.keyword);
  const str = RGBA.fromHex(tokens.syntax.string);
  const fn = RGBA.fromHex(tokens.syntax.function);
  const typ = RGBA.fromHex(tokens.syntax.type);
  const num = RGBA.fromHex(tokens.syntax.number);
  const cmt = RGBA.fromHex(tokens.syntax.comment);
  const op = RGBA.fromHex(tokens.syntax.operator);
  const lit = RGBA.fromHex(tokens.syntax.literal);

  return SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromHex(colors.text) },
    conceal: { fg: RGBA.fromHex(colors.dim) },
    "markup.heading": { fg: RGBA.fromHex(tokens.syntax.headingPrimary), bold: true },
    "markup.heading.1": { fg: RGBA.fromHex(tokens.syntax.headingPrimary), bold: true },
    "markup.heading.2": { fg: RGBA.fromHex(tokens.syntax.headingSecondary), bold: true },
    "markup.heading.3": { fg: RGBA.fromHex(colors.text), bold: true },
    "markup.heading.4": { fg: RGBA.fromHex(colors.text), bold: true },
    "markup.heading.5": { fg: RGBA.fromHex(colors.text), bold: true },
    "markup.heading.6": { fg: RGBA.fromHex(colors.text), bold: true },
    "markup.heading.table": { fg: RGBA.fromHex(colors.cyan), bold: true },
    "markup.strong": { fg: RGBA.fromHex(colors.text), bold: true },
    "markup.italic": { fg: RGBA.fromHex(colors.text), italic: true },
    "markup.raw": { fg: RGBA.fromHex(tokens.syntax.raw) },
    "markup.raw.block": { fg: RGBA.fromHex(tokens.syntax.raw) },
    "markup.link": { fg: RGBA.fromHex(colors.cyan) },
    "markup.link.label": { fg: RGBA.fromHex(colors.cyan), underline: true },
    "markup.link.url": { fg: RGBA.fromHex(colors.cyan), underline: true },
    "markup.quote": { fg: RGBA.fromHex(colors.dim), italic: true },
    "markup.list": { fg: RGBA.fromHex(colors.text) },
    keyword: { fg: kw, bold: true },
    "keyword.return": { fg: kw, bold: true },
    "keyword.function": { fg: kw, bold: true },
    "keyword.import": { fg: kw, bold: true },
    "keyword.operator": { fg: op },
    "keyword.conditional": { fg: kw, bold: true },
    "keyword.repeat": { fg: kw, bold: true },
    "keyword.exception": { fg: kw, bold: true },
    string: { fg: str },
    "string.special": { fg: str },
    "string.escape": { fg: num },
    comment: { fg: cmt, italic: true },
    "comment.line": { fg: cmt, italic: true },
    "comment.block": { fg: cmt, italic: true },
    function: { fg: fn },
    "function.call": { fg: fn },
    "function.method": { fg: fn },
    "function.builtin": { fg: fn },
    method: { fg: fn },
    variable: { fg: RGBA.fromHex(tokens.syntax.variable) },
    "variable.builtin": { fg: lit },
    "variable.parameter": { fg: RGBA.fromHex(tokens.syntax.variable) },
    type: { fg: typ },
    "type.builtin": { fg: typ },
    constructor: { fg: typ },
    number: { fg: num },
    "number.float": { fg: num },
    constant: { fg: lit },
    "constant.builtin": { fg: lit },
    boolean: { fg: lit },
    operator: { fg: op },
    punctuation: { fg: op },
    "punctuation.bracket": { fg: op },
    "punctuation.delimiter": { fg: op },
    "punctuation.special": { fg: op },
    property: { fg: RGBA.fromHex(tokens.syntax.variable) },
    attribute: { fg: typ },
    tag: { fg: kw },
    label: { fg: RGBA.fromHex(colors.accent) },
  });
}

export function createDisplayTheme(overrides?: DeepPartial<DisplayThemeTokens>): DisplayTheme {
  const tokens = mergeNested(DEFAULT_DISPLAY_TOKENS, overrides);
  return {
    tokens,
    colors: tokens.colors,
    spacing: tokens.spacing,
    layout: tokens.layout,
    branding: tokens.branding,
    markdown: tokens.markdown,
    presentation: tokens.presentation,
    markdownStyle: buildMarkdownStyle(tokens.colors, tokens.markdown),
  };
}

export const DEFAULT_DISPLAY_THEME = createDisplayTheme();
