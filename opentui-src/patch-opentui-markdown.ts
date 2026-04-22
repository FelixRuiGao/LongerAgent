// @ts-nocheck
import {
  BoxRenderable,
  CodeRenderable,
  MarkdownRenderable,
  RGBA,
  StyledText,
  TextRenderable,
} from "./core/index.js";
import type { ColorInput, TextChunk } from "./core/index.js";
import type { MarkedToken, Tokens } from "marked";
import { execSync } from "node:child_process";
import {
  isVigilMarkdownPatchDisabled,
  writeVigilOpenTuiDiag,
} from "./core/lib/diagnostic.js";
import { DEFAULT_DISPLAY_THEME } from "./display/theme/index.js";
import { isShikiReady, shikiHighlightToChunks } from "./shiki-highlighter.js";

/**
 * When `true`, `highlightToChunks` uses Shiki (TextMate grammars, VS Code
 * themes) instead of highlight.js.  Requires `initShikiHighlighter()` to
 * have been called at startup.
 *
 * Set to `false` (default) to keep the original highlight.js path.
 */
export let useShikiHighlighter = true;

/** Toggle Shiki on/off at runtime. */
export function setUseShikiHighlighter(value: boolean): void {
  useShikiHighlighter = value;
}

const PATCH_FLAG = Symbol.for("vigil.opentui.markdown.patch.v4");
const INNER_TEXT = Symbol.for("vigil.codeblock.text");
const LABEL_REF = Symbol.for("vigil.codeblock.label");
const COPY_REF = Symbol.for("vigil.codeblock.copy");
const CODE_CONTENT = Symbol.for("vigil.codeblock.rawcontent");

let CODE_BORDER: string;
let CODE_BORDER_HOVER: string;
let CODE_LABEL_FG: string;
let CODE_COPY_FG: string;
let CODE_COPY_FLASH: string;
let CODE_FG: InstanceType<typeof RGBA>;
let HLJS: Record<string, RGBA>;
let _initialized = false;

function ensureInit(): void {
  if (_initialized) return;
  _initialized = true;

  CODE_BORDER = DEFAULT_DISPLAY_THEME.markdown.codeBorder;
  CODE_BORDER_HOVER = DEFAULT_DISPLAY_THEME.markdown.codeBorderHover;
  CODE_LABEL_FG = DEFAULT_DISPLAY_THEME.markdown.codeLabelForeground;
  CODE_COPY_FG = DEFAULT_DISPLAY_THEME.markdown.codeCopyForeground;
  CODE_COPY_FLASH = DEFAULT_DISPLAY_THEME.markdown.codeCopyFlash;
  CODE_FG = RGBA.fromHex(DEFAULT_DISPLAY_THEME.markdown.codeForeground);
  HLJS = Object.fromEntries(
    Object.entries(DEFAULT_DISPLAY_THEME.markdown.hljs).map(([key, value]) => [key, RGBA.fromHex(value)]),
  ) as Record<string, RGBA>;

  _applyPrototypePatches();
}

// ── highlight.js integration ────────────────────────────────────────────────

let hljs: any = null;
let hljsLoadAttempted = false;

function getHljs(): any {
  if (hljsLoadAttempted) return hljs;
  hljsLoadAttempted = true;
  try {
    // pnpm strict mode: resolve highlight.js through marked-terminal's dependency chain
    const { createRequire } = require("module");
    const req = createRequire(require.resolve("marked-terminal"));
    hljs = req("highlight.js");
  } catch {
    try {
      hljs = require("highlight.js");
    } catch {
      // not available
    }
  }
  return hljs;
}

function unescapeHtml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/");
}

/**
 * Parse highlight.js HTML into TextChunk[] with fg colors.
 */
function hljsHtmlToChunks(html: string): TextChunk[] {
  const chunks: TextChunk[] = [];
  const colorStack: (RGBA | undefined)[] = [CODE_FG];

  let pos = 0;
  while (pos < html.length) {
    const nextTag = html.indexOf("<", pos);
    if (nextTag === -1) {
      // Remaining text
      const text = unescapeHtml(html.slice(pos));
      if (text) chunks.push({ __isChunk: true, text, fg: colorStack[colorStack.length - 1] });
      break;
    }

    // Text before tag
    if (nextTag > pos) {
      const text = unescapeHtml(html.slice(pos, nextTag));
      if (text) chunks.push({ __isChunk: true, text, fg: colorStack[colorStack.length - 1] });
    }

    if (html.startsWith("</", nextTag)) {
      // Closing tag
      const tagEnd = html.indexOf(">", nextTag);
      if (tagEnd === -1) break;
      if (colorStack.length > 1) colorStack.pop();
      pos = tagEnd + 1;
    } else {
      // Opening tag
      const tagEnd = html.indexOf(">", nextTag);
      if (tagEnd === -1) break;
      const tag = html.slice(nextTag, tagEnd + 1);
      const classMatch = tag.match(/class="([^"]+)"/);
      let color: RGBA | undefined = CODE_FG;
      if (classMatch) {
        const classes = classMatch[1].split(/\s+/);
        for (const cls of classes) {
          if (HLJS[cls]) { color = HLJS[cls]; break; }
        }
      }
      colorStack.push(color);
      pos = tagEnd + 1;
    }
  }

  return chunks;
}

export function highlightToChunks(code: string, lang: string | undefined): TextChunk[] | null {
  ensureInit();
  // ── Shiki path (opt-in) ──────────────────────────────────────────────────
  if (useShikiHighlighter && isShikiReady()) {
    const shikiResult = shikiHighlightToChunks(code, lang);
    if (shikiResult) return shikiResult;
    // Language not loaded yet or unsupported — fall through to hljs.
  }

  // ── highlight.js path (default) ──────────────────────────────────────────
  // Only highlight when an explicit, known language is given.  No auto-detect:
  // blocks without a language tag (```...```) render as plain text so we don't
  // mis-colorize prose, shell output, or random pasted content.
  const h = getHljs();
  if (!h) return null;
  if (!lang || !h.getLanguage(lang)) return null;

  try {
    const result = h.highlight(code, { language: lang, ignoreIllegals: true });
    return hljsHtmlToChunks(result.value);
  } catch {
    return null;
  }
}

// ── Markdown prototype patches ──────────────────────────────────────────────

type MarkdownRenderablePatched = InstanceType<typeof MarkdownRenderable> & {
  _syntaxStyle: unknown;
  _conceal: boolean;
  _concealCode: boolean;
  _streaming: boolean;
  _treeSitterClient?: unknown;
  _linkifyMarkdownChunks?: unknown;
  getStyle?: (group: string) => { fg?: ColorInput } | undefined;
  createMarkdownBlockToken: (raw: string) => MarkedToken;
  shouldRenderSeparately: (token: MarkedToken) => boolean;
};

type WrappedBox = InstanceType<typeof BoxRenderable> & {
  [INNER_TEXT]?: InstanceType<typeof TextRenderable>;
  [LABEL_REF]?: InstanceType<typeof TextRenderable>;
  [COPY_REF]?: InstanceType<typeof TextRenderable>;
  [CODE_CONTENT]?: string;
};

function _applyPrototypePatches(): void {
  const proto = MarkdownRenderable.prototype as MarkdownRenderablePatched & Record<PropertyKey, unknown>;

  if (isVigilMarkdownPatchDisabled()) {
  writeVigilOpenTuiDiag("markdown.patch", {
    applied: false,
    reason: "disabled-by-env",
  });
} else if (!proto[PATCH_FLAG]) {
  proto[PATCH_FLAG] = true;
  writeVigilOpenTuiDiag("markdown.patch", {
    applied: true,
    version: "v4",
  });

  proto.getInterBlockMargin = function getInterBlockMarginPatched(): number {
    return 0;
  };

  proto.normalizeMarkdownBlockRaw = function normalizeMarkdownBlockRawPatched(raw: string): string {
    return raw;
  };

  proto.buildRenderableTokens = function buildRenderableTokensPatched(tokens: MarkedToken[]): MarkedToken[] {
    const renderTokens: MarkedToken[] = [];
    let markdownRaw = "";

    const flushMarkdownRaw = (): void => {
      if (markdownRaw.length === 0) return;
      const normalizedRaw = this.normalizeMarkdownBlockRaw(markdownRaw);
      if (normalizedRaw.length > 0) {
        renderTokens.push(this.createMarkdownBlockToken(normalizedRaw));
      }
      markdownRaw = "";
    };

    for (const token of tokens) {
      if (token.type === "space") {
        markdownRaw += token.raw;
        continue;
      }

      if (this.shouldRenderSeparately(token)) {
        flushMarkdownRaw();
        renderTokens.push(token);
        continue;
      }

      markdownRaw += token.raw;
    }

    flushMarkdownRaw();
    return renderTokens;
  };

  proto.getDefaultForeground = function getDefaultForegroundPatched(): ColorInput | undefined {
    return this.getStyle?.("default")?.fg;
  };

  proto.createMarkdownCodeRenderable = function createMarkdownCodeRenderablePatched(
    content: string,
    id: string,
    marginBottom: number = 0,
  ) {
    return new CodeRenderable(this.ctx, {
      id,
      content,
      filetype: "markdown",
      syntaxStyle: this._syntaxStyle as any,
      conceal: this._conceal,
      drawUnstyledText: false,
      streaming: true,
      onChunks: this._linkifyMarkdownChunks as any,
      treeSitterClient: this._treeSitterClient as any,
      width: "100%",
      marginBottom,
    });
  };

  // ── Code block: TextRenderable with hljs-colored StyledText ──

  function createStyledCode(code: string, lang: string | undefined): StyledText {
    const chunks = highlightToChunks(code, lang);
    if (chunks && chunks.length > 0) return new StyledText(chunks);
    // Fallback: single chunk with code fg
    return new StyledText([{ __isChunk: true, text: code, fg: CODE_FG }]);
  }

  function buildCodeBlockWrapper(
    ctx: any,
    codeText: InstanceType<typeof TextRenderable>,
    rawContent: string,
    lang: string,
    marginBottom: number,
  ): WrappedBox {
    const wrapper = new BoxRenderable(ctx, {
      flexDirection: "column",
      width: "100%",
      border: true,
      borderColor: CODE_BORDER,
      borderStyle: "rounded",
      marginBottom,
    }) as WrappedBox;

    const header = new BoxRenderable(ctx, {
      flexDirection: "row",
      width: "100%",
      paddingLeft: 1,
      paddingRight: 1,
    });

    const labelText = new TextRenderable(ctx, {
      content: lang.toUpperCase(),
      fg: CODE_LABEL_FG,
    });

    const spacer = new BoxRenderable(ctx, { flexGrow: 1 });

    const copyText = new TextRenderable(ctx, {
      content: "copy",
      fg: CODE_COPY_FG,
    });

    header.add(labelText);
    header.add(spacer);
    header.add(copyText);

    const codeContainer = new BoxRenderable(ctx, {
      paddingLeft: 1,
      paddingRight: 1,
      width: "100%",
    });
    codeContainer.add(codeText);

    wrapper.add(header);
    wrapper.add(codeContainer);

    wrapper[INNER_TEXT] = codeText;
    wrapper[LABEL_REF] = labelText;
    wrapper[COPY_REF] = copyText;
    wrapper[CODE_CONTENT] = rawContent;

    wrapper.onMouseOver = () => {
      wrapper.borderColor = CODE_BORDER_HOVER;
      copyText.fg = CODE_LABEL_FG;
    };
    wrapper.onMouseOut = () => {
      wrapper.borderColor = CODE_BORDER;
      copyText.fg = CODE_COPY_FG;
    };

    wrapper.onMouseDown = () => {
      const raw = wrapper[CODE_CONTENT];
      if (!raw) return;
      try {
        execSync("pbcopy", { input: raw, timeout: 2000 });
        copyText.content = "copied!";
        copyText.fg = CODE_COPY_FLASH;
        setTimeout(() => {
          copyText.content = "copy";
          copyText.fg = CODE_COPY_FG;
        }, 1500);
      } catch {
        // ignore
      }
    };

    return wrapper;
  }

  proto.createCodeRenderable = function createCodeRenderablePatched(
    token: Tokens.Code,
    id: string,
    marginBottom: number = 0,
  ) {
    const styled = createStyledCode(token.text, token.lang);
    const codeText = new TextRenderable(this.ctx, {
      id,
      content: styled,
      fg: CODE_FG,
      width: "100%",
    });

    return buildCodeBlockWrapper(
      this.ctx,
      codeText,
      token.text,
      token.lang || "text",
      marginBottom,
    );
  };

  proto.applyMarkdownCodeRenderable = function applyMarkdownCodeRenderablePatched(
    renderable: InstanceType<typeof CodeRenderable>,
    content: string,
    marginBottom: number,
  ): void {
    renderable.content = content;
    renderable.filetype = "markdown";
    renderable.syntaxStyle = this._syntaxStyle as any;
    renderable.conceal = this._conceal;
    renderable.drawUnstyledText = false;
    renderable.streaming = true;
    renderable.fg = undefined;
    renderable.marginBottom = marginBottom;
  };

  proto.applyCodeBlockRenderable = function applyCodeBlockRenderablePatched(
    renderable: any,
    token: Tokens.Code,
    marginBottom: number,
  ): void {
    const inner: InstanceType<typeof TextRenderable> | undefined = renderable[INNER_TEXT];
    if (inner) {
      const styled = createStyledCode(token.text, token.lang);
      inner.content = styled;
      renderable[CODE_CONTENT] = token.text;
    }

    const label: InstanceType<typeof TextRenderable> | undefined = renderable[LABEL_REF];
    if (label) {
      label.content = (token.lang || "text").toUpperCase();
    }

    renderable.marginBottom = marginBottom;
  };
  }
} // end _applyPrototypePatches
