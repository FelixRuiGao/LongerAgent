export type ComposerTokenKind = "file" | "paste" | "image";

export interface ComposerTokenMetadata {
  kind: ComposerTokenKind;
  label: string;
  submitText: string;
  path?: string;
  index?: number;
  lineCount?: number;
  imageId?: string;
}

export interface ComposerTokenSnapshot extends ComposerTokenMetadata {
  id: number;
  start: number;
  end: number;
}

export interface TextDiffRange {
  startJs: number;
  endBeforeJs: number;
  endAfterJs: number;
  removedText: string;
  insertedText: string;
  startOffset: number;
  endAfterOffset: number;
}

export interface FileReferenceQuery {
  prefix: string;
  startOffset: number;
  endOffset: number;
}

export interface DisplaySpan {
  text: string;
  startOffset: number;
  endOffset: number;
}

function isFullWidthCodePoint(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3040 && cp <= 0x33bf) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7af) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff01 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x2fffd) ||
    (cp >= 0x30000 && cp <= 0x3fffd)
  );
}

function charDisplayWidth(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  return isFullWidthCodePoint(cp) ? 2 : 1;
}

export function displayWidthWithNewlines(text: string): number {
  let width = 0;
  for (const ch of text) {
    width += ch === "\n" ? 1 : charDisplayWidth(ch);
  }
  return width;
}

export function getTextDiffRange(before: string, after: string): TextDiffRange | null {
  if (before === after) return null;

  let startJs = 0;
  const maxPrefix = Math.min(before.length, after.length);
  while (startJs < maxPrefix && before[startJs] === after[startJs]) {
    startJs += 1;
  }

  let beforeTail = before.length;
  let afterTail = after.length;
  while (
    beforeTail > startJs &&
    afterTail > startJs &&
    before[beforeTail - 1] === after[afterTail - 1]
  ) {
    beforeTail -= 1;
    afterTail -= 1;
  }

  return {
    startJs,
    endBeforeJs: beforeTail,
    endAfterJs: afterTail,
    removedText: before.slice(startJs, beforeTail),
    insertedText: after.slice(startJs, afterTail),
    startOffset: displayWidthWithNewlines(after.slice(0, startJs)),
    endAfterOffset: displayWidthWithNewlines(after.slice(0, afterTail)),
  };
}

export function buildFileReferenceLabel(candidate: string): string {
  return candidate.includes(" ") ? `@"${candidate}"` : `@${candidate}`;
}

export function sliceTextByOffset(text: string, startOffset: number, endOffset: number): string {
  if (endOffset <= startOffset) return "";

  let offset = 0;
  let started = false;
  let output = "";

  for (const ch of text) {
    const width = ch === "\n" ? 1 : charDisplayWidth(ch);
    const nextOffset = offset + width;

    if (!started && nextOffset > startOffset) {
      started = true;
    }

    if (started) {
      if (offset >= endOffset) break;
      output += ch;
    }

    offset = nextOffset;
    if (offset >= endOffset && started) break;
  }

  return output;
}

export function findFileReferenceQuery(text: string, cursorOffset: number): FileReferenceQuery | null {
  const beforeCursor = sliceTextByOffset(text, 0, cursorOffset);
  const atIdx = beforeCursor.lastIndexOf("@");
  if (atIdx < 0) return null;

  const beforeAt = atIdx === 0 ? "" : beforeCursor[atIdx - 1] ?? "";
  if (atIdx !== 0 && beforeAt !== " " && beforeAt !== "\t" && beforeAt !== "\n") {
    return null;
  }

  const prefix = beforeCursor.slice(atIdx + 1);
  if (/\s/.test(prefix)) return null;

  const afterCursor = text.slice(beforeCursor.length);
  const tokenSuffix = afterCursor.match(/^[^\s]*/)?.[0] ?? "";
  const startOffset = displayWidthWithNewlines(beforeCursor.slice(0, atIdx));
  const endOffset = cursorOffset + displayWidthWithNewlines(tokenSuffix);

  return {
    prefix,
    startOffset,
    endOffset,
  };
}

export function getDisplaySpanEndingAtOffset(text: string, endOffset: number): DisplaySpan | null {
  let offset = 0;
  for (const ch of text) {
    const width = ch === "\n" ? 1 : charDisplayWidth(ch);
    const nextOffset = offset + width;
    if (nextOffset === endOffset) {
      return {
        text: ch,
        startOffset: offset,
        endOffset: nextOffset,
      };
    }
    offset = nextOffset;
  }
  return null;
}

export function getDisplaySpanStartingAtOffset(text: string, startOffset: number): DisplaySpan | null {
  let offset = 0;
  for (const ch of text) {
    const width = ch === "\n" ? 1 : charDisplayWidth(ch);
    const nextOffset = offset + width;
    if (offset === startOffset) {
      return {
        text: ch,
        startOffset: offset,
        endOffset: nextOffset,
      };
    }
    offset = nextOffset;
  }
  return null;
}

export function serializeVisibleTextWithTokens(
  visibleText: string,
  tokens: Array<Pick<ComposerTokenSnapshot, "start" | "end" | "submitText">>,
): string {
  if (tokens.length === 0) return visibleText;

  const sortedTokens = [...tokens].sort((a, b) => a.start - b.start);
  const totalOffset = displayWidthWithNewlines(visibleText);
  let cursor = 0;
  let output = "";

  for (const token of sortedTokens) {
    if (token.start > cursor) {
      output += sliceTextByOffset(visibleText, cursor, token.start);
    }
    output += token.submitText;
    cursor = token.end;
  }

  if (cursor < totalOffset) {
    output += sliceTextByOffset(visibleText, cursor, totalOffset);
  }

  return output;
}
