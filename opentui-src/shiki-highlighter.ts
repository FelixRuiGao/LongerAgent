/**
 * Shiki-based syntax highlighter — optional replacement for highlight.js.
 *
 * Provides VS Code–quality TextMate grammar highlighting with vivid theme colors.
 * Uses async initialization (grammar loading) but fully synchronous tokenization
 * after init.
 *
 * Usage:
 *   await initShikiHighlighter();           // call once at startup
 *   const chunks = shikiHighlightToChunks(code, "typescript");  // sync
 *
 * When not initialized (or init failed), all functions return null so the
 * caller can fall back to highlight.js.
 */

import { RGBA, type TextChunk } from "./core/index.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Shiki theme to use. */
export const SHIKI_THEME = "catppuccin-mocha";

/**
 * Languages to pre-load at init.  Covers the most common file types a coding
 * agent encounters.  Additional languages are loaded on-demand via
 * `ensureLanguage()`.
 */
const PRELOAD_LANGS = [
  "typescript", "tsx", "javascript", "jsx",
  "python", "rust", "go", "c", "cpp",
  "java", "kotlin", "scala", "swift", "dart",
  "ruby", "elixir", "perl", "php", "lua",
  "bash", "powershell", "fish",
  "json", "jsonc", "yaml", "toml", "xml", "html", "css", "scss",
  "sql", "graphql", "markdown",
  "dockerfile", "makefile", "diff",
  "zig", "haskell", "ocaml", "r",
  "vim", "ini",
];

// ---------------------------------------------------------------------------
// Language alias map (highlight.js name → Shiki name)
// ---------------------------------------------------------------------------

const LANG_ALIAS: Record<string, string> = {
  "objectivec": "objective-c",
  "dos": "batch",
  "delphi": "pascal",
  "vbnet": "vb",
};

function resolveLang(lang: string): string {
  return LANG_ALIAS[lang] ?? lang;
}

// ---------------------------------------------------------------------------
// Singleton state
// ---------------------------------------------------------------------------

let highlighter: ShikiHighlighter | null = null;
let initPromise: Promise<void> | null = null;

/** Minimal interface — we only use codeToTokens + loadLanguage. */
interface ShikiHighlighter {
  codeToTokens: (code: string, options: {
    lang: string;
    theme: string;
  }) => {
    tokens: Array<Array<{ content: string; color?: string; fontStyle?: number }>>;
    fg?: string;
    bg?: string;
  };
  getLoadedLanguages: () => string[];
  loadLanguage: (...langs: unknown[]) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize the Shiki highlighter singleton.  Safe to call multiple times —
 * subsequent calls return the same promise.
 */
export async function initShikiHighlighter(): Promise<void> {
  if (highlighter) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      const shiki = await import("shiki");
      const h = await shiki.createHighlighter({
        themes: [SHIKI_THEME],
        langs: PRELOAD_LANGS,
      });
      highlighter = h as unknown as ShikiHighlighter;
    } catch (err) {
      // Swallow — caller will fall back to hljs.
      highlighter = null;
    }
  })();

  return initPromise;
}

/** Whether the Shiki highlighter is ready for synchronous use. */
export function isShikiReady(): boolean {
  return highlighter !== null;
}

/**
 * Ensure a language grammar is loaded.  Returns `true` if the language is
 * available after the call (already loaded or successfully loaded now).
 */
async function ensureLanguage(lang: string): Promise<boolean> {
  if (!highlighter) return false;
  const loaded = highlighter.getLoadedLanguages();
  if (loaded.includes(lang)) return true;
  try {
    await highlighter.loadLanguage(lang as any);
    return true;
  } catch {
    return false;
  }
}

/**
 * Synchronous tokenization.  Returns `TextChunk[]` with fg colors from the
 * Shiki theme, or `null` if Shiki is not initialized / language unavailable.
 *
 * Signature mirrors `highlightToChunks()` from patch-opentui-markdown.ts so
 * it can be used as a drop-in replacement.
 */
export function shikiHighlightToChunks(
  code: string,
  lang: string | undefined,
): TextChunk[] | null {
  if (!highlighter || !lang) return null;

  const resolved = resolveLang(lang);

  // Only attempt languages we've already loaded (sync path — no await).
  const loaded = highlighter.getLoadedLanguages();
  if (!loaded.includes(resolved)) {
    // Fire-and-forget: load for next time.
    ensureLanguage(resolved);
    return null;
  }

  try {
    const result = highlighter.codeToTokens(code, {
      lang: resolved,
      theme: SHIKI_THEME,
    });

    // result.tokens is line-based — each outer entry is a line of tokens
    // with line breaks stripped by Shiki.  Flatten into a single chunk
    // array, inserting a "\n" chunk between lines to preserve line breaks.
    const chunks: TextChunk[] = [];
    for (let i = 0; i < result.tokens.length; i++) {
      const line = result.tokens[i];
      for (const token of line) {
        chunks.push({
          __isChunk: true,
          text: token.content,
          fg: token.color ? RGBA.fromHex(token.color) : undefined,
        });
      }
      if (i < result.tokens.length - 1) {
        chunks.push({ __isChunk: true, text: "\n" });
      }
    }
    return chunks.length > 0 ? chunks : null;
  } catch {
    return null;
  }
}
