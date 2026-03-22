import {
  BoxRenderable,
  CodeRenderable,
  MarkdownRenderable,
  RGBA,
  StyledText,
  TextRenderable,
} from "@opentui/core";
import type { ColorInput, TextChunk } from "@opentui/core";
import type { MarkedToken, Tokens } from "marked";
import { execSync } from "node:child_process";

const PATCH_FLAG = Symbol.for("longeragent.opentui.markdown.patch.v4");
const INNER_TEXT = Symbol.for("longeragent.codeblock.text");
const LABEL_REF = Symbol.for("longeragent.codeblock.label");
const COPY_REF = Symbol.for("longeragent.codeblock.copy");
const CODE_CONTENT = Symbol.for("longeragent.codeblock.rawcontent");

// Colors from the fixed dark palette
const CODE_BORDER = "#2a2630";
const CODE_BORDER_HOVER = "#504860";
const CODE_LABEL_FG = "#636a76";
const CODE_COPY_FG = "#454a54";
const CODE_COPY_FLASH = "#ffb703";
const CODE_FG = RGBA.fromHex("#a0a8b4");

// highlight.js class → RGBA mapping (logo-gradient-derived)
const HLJS: Record<string, RGBA> = {
  "hljs-keyword":          RGBA.fromHex("#e0a050"),
  "hljs-built_in":         RGBA.fromHex("#6aa8a0"),
  "hljs-type":             RGBA.fromHex("#e8c468"),
  "hljs-literal":          RGBA.fromHex("#6aa8a0"),
  "hljs-number":           RGBA.fromHex("#d08770"),
  "hljs-string":           RGBA.fromHex("#8aad6a"),
  "hljs-subst":            RGBA.fromHex("#b0b8c4"),
  "hljs-symbol":           RGBA.fromHex("#d08770"),
  "hljs-class":            RGBA.fromHex("#e8c468"),
  "hljs-function":         RGBA.fromHex("#d0a0d0"),
  "hljs-title":            RGBA.fromHex("#d0a0d0"),
  "hljs-title.function_":  RGBA.fromHex("#d0a0d0"),
  "hljs-title.class_":     RGBA.fromHex("#e8c468"),
  "hljs-params":           RGBA.fromHex("#b0b8c4"),
  "hljs-comment":          RGBA.fromHex("#5a5565"),
  "hljs-doctag":           RGBA.fromHex("#636a76"),
  "hljs-meta":             RGBA.fromHex("#636a76"),
  "hljs-meta-keyword":     RGBA.fromHex("#e0a050"),
  "hljs-meta-string":      RGBA.fromHex("#8aad6a"),
  "hljs-section":          RGBA.fromHex("#ffb703"),
  "hljs-tag":              RGBA.fromHex("#e0a050"),
  "hljs-name":             RGBA.fromHex("#e81860"),
  "hljs-attr":             RGBA.fromHex("#e8c468"),
  "hljs-attribute":        RGBA.fromHex("#e8c468"),
  "hljs-variable":         RGBA.fromHex("#b0b8c4"),
  "hljs-bullet":           RGBA.fromHex("#d08770"),
  "hljs-code":             RGBA.fromHex("#a0a8b4"),
  "hljs-formula":          RGBA.fromHex("#d08770"),
  "hljs-link":             RGBA.fromHex("#6aa8a0"),
  "hljs-quote":            RGBA.fromHex("#5a5565"),
  "hljs-selector-tag":     RGBA.fromHex("#e81860"),
  "hljs-selector-id":      RGBA.fromHex("#e8c468"),
  "hljs-selector-class":   RGBA.fromHex("#d0a0d0"),
  "hljs-selector-attr":    RGBA.fromHex("#e8c468"),
  "hljs-selector-pseudo":  RGBA.fromHex("#d0a0d0"),
  "hljs-template-tag":     RGBA.fromHex("#e0a050"),
  "hljs-template-variable":RGBA.fromHex("#e81860"),
  "hljs-addition":         RGBA.fromHex("#8aad6a"),
  "hljs-deletion":         RGBA.fromHex("#f05030"),
  "hljs-regexp":           RGBA.fromHex("#d08770"),
};

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

function highlightToChunks(code: string, lang: string | undefined): TextChunk[] | null {
  const h = getHljs();
  if (!h) return null;

  try {
    if (lang && h.getLanguage(lang)) {
      const result = h.highlight(code, { language: lang, ignoreIllegals: true });
      return hljsHtmlToChunks(result.value);
    }
    const result = h.highlightAuto(code);
    if (result.relevance > 5) {
      return hljsHtmlToChunks(result.value);
    }
  } catch {
    // fall through
  }
  return null;
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

const proto = MarkdownRenderable.prototype as MarkdownRenderablePatched & Record<PropertyKey, unknown>;

if (!proto[PATCH_FLAG]) {
  proto[PATCH_FLAG] = true;

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
      borderStyle: "single",
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
