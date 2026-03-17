/**
 * Minimal syntax highlighter for code blocks.
 * Supports common languages with token-based coloring.
 * No external dependencies — just regex-based tokenization.
 */

import { theme } from "../theme";

interface Token {
  type: "keyword" | "string" | "comment" | "number" | "operator" | "function" | "type" | "property" | "punctuation" | "text";
  value: string;
}

const COLORS: Record<Token["type"], string> = {
  keyword: "#C678DD",    // Purple
  string: "#98C379",     // Green
  comment: "#5C6370",    // Gray
  number: "#D19A66",     // Orange
  operator: "#56B6C2",   // Cyan
  function: "#61AFEF",   // Blue
  type: "#E5C07B",       // Yellow
  property: "#E06C75",   // Red-pink
  punctuation: theme.muted,
  text: theme.text,
};

// Language keyword sets
const JS_KEYWORDS = new Set([
  "const", "let", "var", "function", "return", "if", "else", "for", "while",
  "do", "switch", "case", "break", "continue", "new", "delete", "typeof",
  "instanceof", "in", "of", "try", "catch", "finally", "throw", "class",
  "extends", "super", "this", "import", "export", "from", "default", "as",
  "async", "await", "yield", "void", "null", "undefined", "true", "false",
  "static", "get", "set", "interface", "type", "enum", "implements",
  "public", "private", "protected", "readonly", "abstract", "declare",
  "namespace", "module",
]);

const PYTHON_KEYWORDS = new Set([
  "def", "class", "if", "elif", "else", "for", "while", "return", "import",
  "from", "as", "try", "except", "finally", "raise", "with", "yield",
  "lambda", "pass", "break", "continue", "and", "or", "not", "in", "is",
  "True", "False", "None", "self", "global", "nonlocal", "assert", "del",
  "async", "await",
]);

const RUST_KEYWORDS = new Set([
  "fn", "let", "mut", "const", "if", "else", "for", "while", "loop",
  "match", "return", "struct", "enum", "impl", "trait", "pub", "use",
  "mod", "crate", "self", "super", "where", "async", "await", "move",
  "ref", "type", "as", "in", "true", "false", "unsafe", "extern",
  "static", "dyn", "Box", "Vec", "String", "Option", "Result", "Some",
  "None", "Ok", "Err",
]);

const GO_KEYWORDS = new Set([
  "func", "var", "const", "if", "else", "for", "range", "return",
  "package", "import", "type", "struct", "interface", "map", "chan",
  "go", "defer", "select", "case", "switch", "default", "break",
  "continue", "fallthrough", "nil", "true", "false", "make", "new",
  "append", "len", "cap", "error", "string", "int", "bool", "byte",
]);

const SHELL_KEYWORDS = new Set([
  "if", "then", "else", "elif", "fi", "for", "while", "do", "done",
  "case", "esac", "function", "return", "exit", "echo", "export",
  "source", "alias", "unalias", "set", "unset", "readonly", "local",
  "cd", "ls", "grep", "sed", "awk", "cat", "mkdir", "rm", "cp", "mv",
  "chmod", "chown", "curl", "wget", "git", "npm", "pnpm", "yarn",
  "docker", "sudo", "apt", "brew", "pip", "python", "node",
]);

function getKeywords(lang: string): Set<string> {
  const l = lang.toLowerCase();
  if (["js", "javascript", "jsx", "ts", "typescript", "tsx"].includes(l)) return JS_KEYWORDS;
  if (["py", "python"].includes(l)) return PYTHON_KEYWORDS;
  if (["rs", "rust"].includes(l)) return RUST_KEYWORDS;
  if (["go", "golang"].includes(l)) return GO_KEYWORDS;
  if (["sh", "bash", "zsh", "shell", "fish"].includes(l)) return SHELL_KEYWORDS;
  // Default: merge common keywords
  return JS_KEYWORDS;
}

function isShellLang(lang: string): boolean {
  return ["sh", "bash", "zsh", "shell", "fish", ""].includes(lang.toLowerCase());
}

function tokenize(code: string, lang: string): Token[] {
  const keywords = getKeywords(lang);
  const tokens: Token[] = [];
  let i = 0;

  while (i < code.length) {
    // Single-line comment
    if (code[i] === "/" && code[i + 1] === "/") {
      const end = code.indexOf("\n", i);
      const value = end === -1 ? code.slice(i) : code.slice(i, end);
      tokens.push({ type: "comment", value });
      i += value.length;
      continue;
    }
    // Hash comment (Python, shell)
    if (code[i] === "#" && (["py", "python", "sh", "bash", "zsh", "shell", "fish", "rb", "ruby", "yaml", "yml", "toml"].includes(lang.toLowerCase()) || !lang)) {
      const end = code.indexOf("\n", i);
      const value = end === -1 ? code.slice(i) : code.slice(i, end);
      tokens.push({ type: "comment", value });
      i += value.length;
      continue;
    }
    // Multi-line comment
    if (code[i] === "/" && code[i + 1] === "*") {
      const end = code.indexOf("*/", i + 2);
      const value = end === -1 ? code.slice(i) : code.slice(i, end + 2);
      tokens.push({ type: "comment", value });
      i += value.length;
      continue;
    }
    // String (double quote)
    if (code[i] === '"') {
      let j = i + 1;
      while (j < code.length && code[j] !== '"') {
        if (code[j] === "\\") j++;
        j++;
      }
      const value = code.slice(i, j + 1);
      tokens.push({ type: "string", value });
      i = j + 1;
      continue;
    }
    // String (single quote)
    if (code[i] === "'") {
      let j = i + 1;
      while (j < code.length && code[j] !== "'") {
        if (code[j] === "\\") j++;
        j++;
      }
      const value = code.slice(i, j + 1);
      tokens.push({ type: "string", value });
      i = j + 1;
      continue;
    }
    // Template literal
    if (code[i] === "`") {
      let j = i + 1;
      while (j < code.length && code[j] !== "`") {
        if (code[j] === "\\") j++;
        j++;
      }
      const value = code.slice(i, j + 1);
      tokens.push({ type: "string", value });
      i = j + 1;
      continue;
    }
    // Numbers
    if (/\d/.test(code[i]) && (i === 0 || !/\w/.test(code[i - 1]))) {
      let j = i;
      while (j < code.length && /[\d.xXbBoOeE_a-fA-F]/.test(code[j])) j++;
      tokens.push({ type: "number", value: code.slice(i, j) });
      i = j;
      continue;
    }
    // Words (keywords, identifiers)
    if (/[a-zA-Z_$]/.test(code[i])) {
      let j = i;
      while (j < code.length && /[\w$]/.test(code[j])) j++;
      const word = code.slice(i, j);
      if (keywords.has(word)) {
        tokens.push({ type: "keyword", value: word });
      } else if (/^[A-Z]/.test(word)) {
        tokens.push({ type: "type", value: word });
      } else if (j < code.length && code[j] === "(") {
        tokens.push({ type: "function", value: word });
      } else {
        tokens.push({ type: "text", value: word });
      }
      i = j;
      continue;
    }
    // Operators
    if ("+-*/%=<>!&|^~?:".includes(code[i])) {
      let j = i + 1;
      while (j < code.length && "+-*/%=<>!&|^~?:".includes(code[j])) j++;
      tokens.push({ type: "operator", value: code.slice(i, j) });
      i = j;
      continue;
    }
    // Punctuation
    if ("(){}[],.;@".includes(code[i])) {
      tokens.push({ type: "punctuation", value: code[i] });
      i++;
      continue;
    }
    // Whitespace and other
    tokens.push({ type: "text", value: code[i] });
    i++;
  }

  return tokens;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function highlightCode(code: string, lang: string): string {
  const tokens = tokenize(code, lang);
  return tokens
    .map((t) => {
      const escaped = escapeHtml(t.value);
      if (t.type === "text") return escaped;
      return `<span style="color:${COLORS[t.type]}">${escaped}</span>`;
    })
    .join("");
}
