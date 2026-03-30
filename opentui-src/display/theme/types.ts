import type { SyntaxStyle } from "@opentui/core";
import type { ToolCategory } from "../../presentation/types.js";

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends readonly (infer U)[]
    ? readonly U[]
    : T[K] extends Record<string, unknown>
      ? DeepPartial<T[K]>
      : T[K];
};

export interface DisplayThemeColorTokens {
  background: string;
  panel: string;
  userBg: string;
  border: string;
  separator: string;
  scrollbarTrack: string;
  text: string;
  dim: string;
  muted: string;
  accent: string;
  orange: string;
  red: string;
  magenta: string;
  purple: string;
  yellow: string;
  green: string;
  cyan: string;
  thinking: string;
  toolTime: string;
  readyStatus: string;
  thinkingStatus: string;
  workingStatus: string;
  generatingStatus: string;
  waitingStatus: string;
  closingStatus: string;
  errorStatus: string;
}

export interface DisplayThemeSpacingTokens {
  screenPaddingX: number;
  screenPaddingY: number;
  screenGap: number;
  sectionGap: number;
  contentInset: number;
  surfacePaddingX: number;
  surfacePaddingY: number;
  inlineResultIndent: number;
}

export interface DisplayThemeLayoutTokens {
  inputMaxVisibleLines: number;
  pickerVisibleRatio: number;
  pickerMinVisible: number;
  sidebarMinWidth: number;
  sidebarMaxWidth: number;
  sidebarCollapsedWidth: number;
  minTerminalWidthForSidebar: number;
  minTerminalWidthForLogoHeader: number;
  minTerminalHeightForLogoHeader: number;
}

export interface DisplayThemeBrandingTokens {
  appVersion: string;
  logoLines: readonly string[];
  logoGradient: readonly string[];
  sidebarWordmark: string;
  sidebarGradientIndices: readonly number[];
}

export interface DisplayThemeMarkdownTokens {
  codeBorder: string;
  codeBorderHover: string;
  codeLabelForeground: string;
  codeCopyForeground: string;
  codeCopyFlash: string;
  codeForeground: string;
  syntax: {
    keyword: string;
    string: string;
    function: string;
    type: string;
    number: string;
    comment: string;
    operator: string;
    literal: string;
    variable: string;
    headingPrimary: string;
    headingSecondary: string;
    raw: string;
  };
  hljs: Record<string, string>;
}

export interface DisplayThemePresentationTokens {
  categoryColors: Record<ToolCategory, string>;
  thinkingColor: string;
  successColor: string;
  errorColor: string;
  toolNameColor: string;
  modelProviderColors: Record<string, string>;
}

export interface DisplayThemeTokens {
  colors: DisplayThemeColorTokens;
  spacing: DisplayThemeSpacingTokens;
  layout: DisplayThemeLayoutTokens;
  branding: DisplayThemeBrandingTokens;
  markdown: DisplayThemeMarkdownTokens;
  presentation: DisplayThemePresentationTokens;
}

export interface DisplayTheme {
  tokens: DisplayThemeTokens;
  colors: DisplayThemeColorTokens;
  spacing: DisplayThemeSpacingTokens;
  layout: DisplayThemeLayoutTokens;
  branding: DisplayThemeBrandingTokens;
  markdown: DisplayThemeMarkdownTokens;
  presentation: DisplayThemePresentationTokens;
  markdownStyle: SyntaxStyle;
}
