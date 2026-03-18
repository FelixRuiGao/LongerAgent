import { CodeRenderable, MarkdownRenderable } from "@opentui/core";
import type { ColorInput } from "@opentui/core";
import type { MarkedToken, Tokens } from "marked";

const PATCH_FLAG = Symbol.for("longeragent.opentui.markdown.patch.v1");

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

  proto.createCodeRenderable = function createCodeRenderablePatched(
    token: Tokens.Code,
    id: string,
    marginBottom: number = 0,
  ) {
    const defaultForeground = this.getDefaultForeground?.();
    return new CodeRenderable(this.ctx, {
      id,
      content: token.text,
      filetype: token.lang || undefined,
      syntaxStyle: this._syntaxStyle as any,
      conceal: this._concealCode,
      drawUnstyledText: !(this._streaming && this._concealCode),
      streaming: this._streaming,
      treeSitterClient: this._treeSitterClient as any,
      width: "100%",
      ...(defaultForeground ? { fg: defaultForeground } : {}),
      marginBottom,
    });
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
    renderable: InstanceType<typeof CodeRenderable>,
    token: Tokens.Code,
    marginBottom: number,
  ): void {
    renderable.content = token.text;
    renderable.filetype = token.lang || undefined;
    renderable.syntaxStyle = this._syntaxStyle as any;
    renderable.conceal = this._concealCode;
    renderable.drawUnstyledText = !(this._streaming && this._concealCode);
    renderable.streaming = this._streaming;
    const defaultForeground = this.getDefaultForeground?.();
    if (defaultForeground) {
      renderable.fg = defaultForeground;
    }
    renderable.marginBottom = marginBottom;
  };
}
