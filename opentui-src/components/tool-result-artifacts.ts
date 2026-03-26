import { extname } from "node:path";

import { RGBA, StyledText } from "@opentui/core";
import type { TextChunk } from "../forked/core/text-buffer.js";
import { highlightToChunks } from "../forked/patch-opentui-markdown.js";

import type { ConversationEntry } from "../../src/tui/types.js";
import type { ConversationPalette } from "./conversation-types.js";

// Extension → highlight.js language name.
// Covers all 191 hljs v10.7.3 built-in languages that have standard file extensions.
// Languages without file extensions (REPLs, log formats, protocol specs, meta-languages)
// are omitted — they cannot be inferred from a file path.
const DIFF_LANGUAGE_BY_EXTENSION: Record<string, string> = {
  // A
  ".abnf": "abnf",
  ".ada": "ada",
  ".adb": "ada",
  ".adoc": "asciidoc",
  ".ado": "stata",
  ".ads": "ada",
  ".ahk": "autohotkey",
  ".aj": "aspectj",
  ".applescript": "applescript",
  ".arcade": "arcade",
  ".as": "actionscript",
  ".asciidoc": "asciidoc",
  ".asm": "x86asm",
  ".au3": "autoit",
  ".awk": "awk",
  // B
  ".bas": "basic",
  ".bash": "bash",
  ".bat": "dos",
  ".bf": "brainfuck",
  ".bnf": "bnf",
  ".bsl": "1c",
  // C
  ".c": "c",
  ".cal": "cal",
  ".capnp": "capnproto",
  ".cc": "cpp",
  ".ceylon": "ceylon",
  ".cfg": "ini",
  ".cjs": "javascript",
  ".clj": "clojure",
  ".cljc": "clojure",
  ".cljs": "clojure",
  ".cls": "latex",
  ".cmake": "cmake",
  ".cmd": "dos",
  ".coffee": "coffeescript",
  ".cos": "cos",
  ".cpp": "cpp",
  ".cr": "crystal",
  ".crm": "crmsh",
  ".cs": "csharp",
  ".css": "css",
  ".cts": "typescript",
  ".cxx": "cpp",
  // D
  ".d": "d",
  ".dart": "dart",
  ".dcl": "clean",
  ".diff": "diff",
  ".do": "stata",
  ".dockerfile": "dockerfile",
  ".dpr": "delphi",
  ".dts": "dts",
  ".dtsi": "dts",
  ".dust": "dust",
  // E
  ".ebnf": "ebnf",
  ".el": "lisp",
  ".elm": "elm",
  ".erb": "erb",
  ".erl": "erlang",
  ".ex": "elixir",
  ".exs": "elixir",
  // F
  ".f": "fortran",
  ".f03": "fortran",
  ".f08": "fortran",
  ".f90": "fortran",
  ".f95": "fortran",
  ".feature": "gherkin",
  ".flix": "flix",
  ".frag": "glsl",
  ".fs": "fsharp",
  ".fsi": "fsharp",
  ".fsx": "fsharp",
  // G
  ".gcode": "gcode",
  ".gemspec": "ruby",
  ".glsl": "glsl",
  ".gml": "gml",
  ".gms": "gams",
  ".go": "go",
  ".golo": "golo",
  ".gradle": "gradle",
  ".groovy": "groovy",
  ".gss": "gauss",
  ".gvy": "groovy",
  // H
  ".h": "c",
  ".haml": "haml",
  ".handlebars": "handlebars",
  ".hbs": "handlebars",
  ".hpp": "cpp",
  ".hrl": "erlang",
  ".hs": "haskell",
  ".hsp": "hsp",
  ".htaccess": "apache",
  ".htm": "xml",
  ".html": "xml",
  ".hx": "haxe",
  ".hxx": "cpp",
  ".hy": "hy",
  // I
  ".i7x": "inform7",
  ".icl": "clean",
  ".ini": "ini",
  ".ino": "arduino",
  // J
  ".java": "java",
  ".jl": "julia",
  ".js": "javascript",
  ".json": "json",
  ".jsx": "javascript",
  // K
  ".kt": "kotlin",
  ".kts": "kotlin",
  // L
  ".lasso": "lasso",
  ".ldif": "ldif",
  ".leaf": "leaf",
  ".less": "less",
  ".lhs": "haskell",
  ".lisp": "lisp",
  ".ll": "llvm",
  ".ls": "livescript",
  ".lsl": "lsl",
  ".lsp": "lisp",
  ".lua": "lua",
  // M
  ".m": "objectivec",
  ".mac": "maxima",
  ".markdown": "markdown",
  ".md": "markdown",
  ".mel": "mel",
  ".miz": "mizar",
  ".mjs": "javascript",
  ".mk": "makefile",
  ".ml": "ocaml",
  ".mli": "ocaml",
  ".mm": "objectivec",
  ".monkey": "monkey",
  ".moon": "moonscript",
  ".mts": "typescript",
  // N
  ".nb": "mathematica",
  ".nc": "gcode",
  ".ni": "inform7",
  ".nim": "nim",
  ".nix": "nix",
  ".nsh": "nsis",
  ".nsi": "nsis",
  // O
  ".os": "1c",
  // P
  ".pas": "delphi",
  ".patch": "diff",
  ".pb": "purebasic",
  ".pde": "processing",
  ".pf": "pf",
  ".php": "php",
  ".phtml": "php",
  ".pl": "perl",
  ".plist": "xml",
  ".pm": "perl",
  ".pony": "pony",
  ".pp": "puppet",
  ".pro": "prolog",
  ".properties": "properties",
  ".proto": "protobuf",
  ".ps1": "powershell",
  ".psd1": "powershell",
  ".psm1": "powershell",
  ".py": "python",
  ".pyw": "python",
  // Q
  ".q": "q",
  ".qml": "qml",
  // R
  ".r": "r",
  ".rake": "ruby",
  ".rb": "ruby",
  ".re": "reasonml",
  ".rei": "reasonml",
  ".rib": "rib",
  ".rs": "rust",
  ".rsc": "routeros",
  ".rsl": "rsl",
  // S
  ".sas": "sas",
  ".sc": "scala",
  ".scala": "scala",
  ".scad": "openscad",
  ".sci": "scilab",
  ".scm": "scheme",
  ".scpt": "applescript",
  ".scss": "scss",
  ".sh": "bash",
  ".smali": "smali",
  ".sml": "sml",
  ".sqf": "sqf",
  ".sql": "sql",
  ".ss": "scheme",
  ".st": "smalltalk",
  ".stan": "stan",
  ".step": "step21",
  ".stp": "step21",
  ".styl": "stylus",
  ".sv": "verilog",
  ".svg": "xml",
  ".swift": "swift",
  ".sty": "latex",
  // T
  ".tcl": "tcl",
  ".tex": "latex",
  ".thrift": "thrift",
  ".toml": "ini",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".twig": "twig",
  ".txt": "plaintext",
  // V
  ".v": "verilog",
  ".vala": "vala",
  ".vb": "vbnet",
  ".vbs": "vbscript",
  ".vert": "glsl",
  ".vhd": "vhdl",
  ".vhdl": "vhdl",
  ".vim": "vim",
  // W
  ".wl": "mathematica",
  ".wsdl": "xml",
  // X
  ".xl": "xl",
  ".xml": "xml",
  ".xq": "xquery",
  ".xquery": "xquery",
  ".xqy": "xquery",
  ".xsd": "xml",
  ".xsl": "xml",
  // Y
  ".yaml": "yaml",
  ".yml": "yaml",
  // Z
  ".zep": "zephir",
  ".zsh": "bash",
};

type ToolMetadata = Record<string, unknown>;

interface ToolResultArtifactOptions {
  text: string;
  dim?: boolean;
  toolMetadata?: ToolMetadata;
  colors: ConversationPalette;
}

export interface ToolResultLineArtifact {
  content: StyledText;
  rowBackgroundColor?: string;
}

function createChunk(
  text: string,
  options: {
    fg?: RGBA;
    bg?: RGBA;
    attributes?: number;
  } = {},
): TextChunk {
  return {
    __isChunk: true,
    text,
    fg: options.fg,
    bg: options.bg,
    attributes: options.attributes,
  };
}

function parseDiffPreviewKind(toolMetadata?: ToolMetadata): string | null {
  const preview = toolMetadata?.["tui_preview"];
  if (!preview || typeof preview !== "object") return null;
  const kind = (preview as Record<string, unknown>)["kind"];
  return typeof kind === "string" ? kind : null;
}

function inferDiffLanguage(toolMetadata?: ToolMetadata): string | undefined {
  const pathValue = typeof toolMetadata?.["path"] === "string"
    ? toolMetadata["path"] as string
    : null;
  if (pathValue) {
    return DIFF_LANGUAGE_BY_EXTENSION[extname(pathValue).toLowerCase()];
  }

  const paths = Array.isArray(toolMetadata?.["paths"]) ? toolMetadata["paths"] as unknown[] : null;
  if (paths && paths.length === 1 && typeof paths[0] === "string") {
    return DIFF_LANGUAGE_BY_EXTENSION[extname(paths[0]).toLowerCase()];
  }

  return undefined;
}

function parsePreviewLine(line: string): { prefix: string; raw: string } {
  const numberedLineMatch = line.match(/^(\s*\d+\s)([+\- ].*)$/);
  if (numberedLineMatch) {
    return {
      prefix: numberedLineMatch[1],
      raw: numberedLineMatch[2],
    };
  }

  const blankPrefixMatch = line.match(/^(\s+)(@@.*|--- .*|\+\+\+ .*|\.\.\..*)$/);
  if (blankPrefixMatch) {
    return {
      prefix: blankPrefixMatch[1],
      raw: blankPrefixMatch[2],
    };
  }

  return { prefix: "", raw: line };
}

function isLikelyDiffPreview(text: string): boolean {
  return /(?:^|\n)\s*\d+\s[+\- ]/.test(text)
    || /(?:^|\n)\s+@@ /.test(text)
    || /(?:^|\n)\s+--- /.test(text)
    || /(?:^|\n)\s+\+\+\s/.test(text);
}

// Diff context brightness factors for syntax-highlighted code.
// Visual hierarchy: additions (brightest) > deletions > context (dimmest).
const DIFF_BRIGHTNESS_ADDITION = 1.30;
const DIFF_BRIGHTNESS_DELETION = 1.30;
const DIFF_BRIGHTNESS_CONTEXT = 0.45;

// Comment/meta colors from the HLJS map — exempt from diff brightness adjustment.
// Comments should stay at their base dim level regardless of diff context.
const HLJS_COMMENT_COLORS = [
  RGBA.fromHex("#5a5565"),  // hljs-comment, hljs-quote
  RGBA.fromHex("#636a76"),  // hljs-doctag, hljs-meta
];

function isCommentColor(color: RGBA | undefined): boolean {
  if (!color) return false;
  return HLJS_COMMENT_COLORS.some((c) => c.equals(color));
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

function adjustBrightness(color: RGBA | undefined, factor: number): RGBA | undefined {
  if (!color || factor === 1) return color;
  if (color.isAnsi256()) return color;
  if (factor >= 1) {
    // Blend toward white: ch + (1 - ch) * (factor - 1)
    const t = factor - 1;
    return RGBA.fromValues(
      clamp01(color.r + (1 - color.r) * t),
      clamp01(color.g + (1 - color.g) * t),
      clamp01(color.b + (1 - color.b) * t),
      color.a,
    );
  }
  // Scale toward black: ch * factor
  return RGBA.fromValues(
    color.r * factor,
    color.g * factor,
    color.b * factor,
    color.a,
  );
}

function cloneChunksWithBaseStyle(
  chunks: TextChunk[],
  options: { fallbackFg?: RGBA; brightness?: number },
): TextChunk[] {
  const b = options.brightness ?? 1;
  return chunks.map((chunk) => {
    const fg = chunk.fg ?? options.fallbackFg;
    return {
      ...chunk,
      fg: isCommentColor(chunk.fg) ? fg : adjustBrightness(fg, b),
      bg: undefined,
    };
  });
}

function buildPlainToolResultArtifacts(
  { text, dim, colors }: Pick<ToolResultArtifactOptions, "text" | "dim" | "colors">,
): ToolResultLineArtifact[] {
  const fg = RGBA.fromHex(dim ? colors.dim : colors.text);
  return text.split("\n").map((line) => ({
    content: new StyledText([createChunk(line || " ", { fg })]),
  }));
}

function buildDiffLineArtifact(
  line: string,
  colors: ConversationPalette,
  language: string | undefined,
): ToolResultLineArtifact | null {
  const { prefix, raw } = parsePreviewLine(line);

  const dimFg = RGBA.fromHex(colors.dim);
  const textFg = RGBA.fromHex(colors.text);
  const greenFg = RGBA.fromHex(colors.green);
  const redFg = RGBA.fromHex(colors.red);
  const additionBg = "#285438";
  const deletionBg = "#6a3232";

  const chunks: TextChunk[] = [];

  if (raw.startsWith("@@")) {
    return null;
  }

  if (raw.startsWith("...")) {
    if (prefix) {
      chunks.push(createChunk(prefix, { fg: dimFg }));
    }
    chunks.push(createChunk(raw, { fg: dimFg }));
    return { content: new StyledText(chunks) };
  }

  if (raw.startsWith("+++ ") || raw.startsWith("--- ")) {
    if (prefix) {
      chunks.push(createChunk(prefix, { fg: dimFg }));
    }
    chunks.push(createChunk(raw, { fg: dimFg }));
    return { content: new StyledText(chunks) };
  }

  const marker = raw[0] ?? "";
  const payload = raw.length > 0 ? raw.slice(1) : raw;

  if (marker === "+" || marker === "-") {
    const isAddition = marker === "+";
    const markerFg = isAddition ? greenFg : redFg;
    const rowBackgroundColor = isAddition ? additionBg : deletionBg;
    const brightness = isAddition ? DIFF_BRIGHTNESS_ADDITION : DIFF_BRIGHTNESS_DELETION;
    if (prefix) {
      chunks.push(createChunk(prefix, { fg: markerFg }));
    }
    chunks.push(createChunk(marker, { fg: markerFg }));

    const highlightedPayload = language ? highlightToChunks(payload, language) : null;
    if (highlightedPayload && highlightedPayload.length > 0) {
      chunks.push(...cloneChunksWithBaseStyle(highlightedPayload, { fallbackFg: markerFg, brightness }));
    } else {
      chunks.push(createChunk(payload || " ", { fg: adjustBrightness(markerFg, brightness)! }));
    }
    return {
      content: new StyledText(chunks),
      rowBackgroundColor,
    };
  }

  if (prefix) {
    chunks.push(createChunk(prefix, { fg: dimFg }));
  }
  if (marker === " ") {
    chunks.push(createChunk(marker, { fg: dimFg }));
    const highlightedPayload = language ? highlightToChunks(payload, language) : null;
    if (highlightedPayload && highlightedPayload.length > 0) {
      chunks.push(...cloneChunksWithBaseStyle(highlightedPayload, { fallbackFg: textFg, brightness: DIFF_BRIGHTNESS_CONTEXT }));
    } else {
      chunks.push(createChunk(payload || " ", { fg: adjustBrightness(textFg, DIFF_BRIGHTNESS_CONTEXT)! }));
    }
    return { content: new StyledText(chunks) };
  }

  chunks.push(createChunk(raw || " ", { fg: textFg }));
  return { content: new StyledText(chunks) };
}

function buildDiffToolResultArtifacts(
  { text, colors, toolMetadata }: Pick<ToolResultArtifactOptions, "text" | "colors" | "toolMetadata">,
): ToolResultLineArtifact[] {
  const lines = text.split("\n");
  const language = inferDiffLanguage(toolMetadata);

  return lines
    .map((line) => buildDiffLineArtifact(line, colors, language))
    .filter((artifact): artifact is ToolResultLineArtifact => artifact !== null);
}

export function buildToolResultArtifacts(
  options: ToolResultArtifactOptions,
): ToolResultLineArtifact[] {
  if (options.dim) {
    return buildPlainToolResultArtifacts(options);
  }

  const previewKind = parseDiffPreviewKind(options.toolMetadata);
  if (previewKind === "diff" || isLikelyDiffPreview(options.text)) {
    return buildDiffToolResultArtifacts(options);
  }

  return buildPlainToolResultArtifacts(options);
}

export function getToolResultMetadata(
  entry: ConversationEntry,
): ToolMetadata | undefined {
  const metadata = entry.meta?.toolMetadata;
  return metadata && typeof metadata === "object"
    ? metadata as ToolMetadata
    : undefined;
}

export function inferToolResultLanguage(
  entry: ConversationEntry,
): string | undefined {
  return inferDiffLanguage(getToolResultMetadata(entry));
}
