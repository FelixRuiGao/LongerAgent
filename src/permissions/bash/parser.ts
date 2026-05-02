/**
 * Tree-sitter-based bash command parser.
 *
 * Parses bash commands into structured segments for permission classification.
 * Unsupported constructs (subshell, heredoc, command substitution, redirection)
 * are flagged explicitly — the classifier can escalate them to "ask".
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { Language, Parser, type Node as TreeNode } from "web-tree-sitter";
import type {
  BashConnector,
  BashParseResult,
  BashToken,
  BashTokenKind,
  BashUnsupportedReason,
  ParsedBashCommand,
  ParsedBashSegment,
  UnsupportedBashScript,
} from "./types.js";

const require = createRequire(import.meta.url);

const DEFAULT_TIMEOUT_MS = 50;

// Singleton parser initialization
let parserInit: Promise<Parser> | null = null;

function resolveWebTreeSitterWasmPath(): string {
  return require.resolve("web-tree-sitter/tree-sitter.wasm");
}

function resolveTreeSitterBashWasmPath(): string {
  return join(dirname(require.resolve("tree-sitter-bash/package.json")), "tree-sitter-bash.wasm");
}

async function initializeParser(): Promise<Parser> {
  await Parser.init({
    locateFile() {
      return resolveWebTreeSitterWasmPath();
    },
  });
  const language = await Language.load(resolveTreeSitterBashWasmPath());
  const parser = new Parser();
  parser.setLanguage(language);
  return parser;
}

export async function getParser(): Promise<Parser> {
  if (parserInit) return parserInit;
  parserInit = initializeParser();
  return parserInit;
}

/**
 * Parse a bash command string into structured segments.
 */
export async function parseBashCommand(
  command: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<BashParseResult> {
  const parser = await getParser();
  const startedAt = performance.now();
  const tree = parser.parse(command);
  if (tree === null) {
    return unsupported("parse_error", "Shell parsing failed and requires manual approval.");
  }
  const elapsedMs = performance.now() - startedAt;
  if (elapsedMs > timeoutMs) {
    return unsupported("timeout", "Shell parsing took too long and requires manual approval.");
  }
  if (tree.rootNode.hasError) {
    return unsupported("parse_error", "Shell parsing failed and requires manual approval.");
  }

  const segments: ParsedBashSegment[] = [];
  const state = { connectorBefore: null as BashConnector | null };
  const walked = walkNode(tree.rootNode, state, segments);
  if (walked !== undefined) {
    return walked;
  }

  return { kind: "ok", segments };
}

// ------------------------------------------------------------------
// AST walking
// ------------------------------------------------------------------

function walkNode(
  node: TreeNode,
  state: { connectorBefore: BashConnector | null },
  segments: ParsedBashSegment[],
): void | UnsupportedBashScript {
  switch (node.type) {
    case "program":
    case "list":
      return walkSequential(node, state, segments);
    case "command":
      return appendCommandSegment(node, "command", state, segments);
    case "pipeline":
      return appendCommandSegment(node, "pipeline", state, segments);
    case "redirected_statement":
    case "file_redirect":
      return unsupported("redirection", "Shell redirection requires manual approval.", node);
    case "heredoc_redirect":
    case "heredoc_start":
    case "heredoc_body":
    case "heredoc_end":
      return unsupported("heredoc", "Shell heredoc syntax requires manual approval.", node);
    case "subshell":
      return unsupported("subshell", "Shell subshell syntax requires manual approval.", node);
    case "process_substitution":
      return unsupported("process_substitution", "Shell process substitution requires manual approval.", node);
    case "command_substitution":
      return unsupported(
        node.text.startsWith("`") ? "backticks" : "command_substitution",
        "Shell command substitution requires manual approval.",
        node,
      );
    case "variable_assignment":
      return unsupported("variable_assignment_prefix", "Shell variable assignment prefixes require manual approval.", node);
    default:
      if (node.isNamed) {
        return unsupported("unsupported_node", `Unsupported shell node: ${node.type}`, node);
      }
      return;
  }
}

function walkSequential(
  node: TreeNode,
  state: { connectorBefore: BashConnector | null },
  segments: ParsedBashSegment[],
): void | UnsupportedBashScript {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (!child.isNamed) {
      const connector = parseConnector(child.type);
      if (connector) state.connectorBefore = connector;
      continue;
    }
    const result = walkNode(child, state, segments);
    if (result) return result;
  }
}

function appendCommandSegment(
  node: TreeNode,
  operator: "command" | "pipeline",
  state: { connectorBefore: BashConnector | null },
  segments: ParsedBashSegment[],
): void | UnsupportedBashScript {
  const commands: ParsedBashCommand[] = [];
  if (operator === "command") {
    const command = tokenizeCommandNode(node);
    if (isUnsupported(command)) return command;
    commands.push(command);
  } else {
    for (const child of namedChildren(node)) {
      const command = tokenizeCommandNode(child);
      if (isUnsupported(command)) return command;
      commands.push(command);
    }
  }

  segments.push({
    index: segments.length,
    text: node.text,
    operator,
    connectorBefore: state.connectorBefore,
    commands,
  });
  state.connectorBefore = null;
}

// ------------------------------------------------------------------
// Command tokenization
// ------------------------------------------------------------------

function tokenizeCommandNode(node: TreeNode): ParsedBashCommand | UnsupportedBashScript {
  const tokens: BashToken[] = [];
  let nameToken: BashToken | null = null;

  for (const child of namedChildren(node)) {
    if (child.type === "variable_assignment") {
      return unsupported("variable_assignment_prefix", "Shell variable assignment prefixes require manual approval.", child);
    }

    const forbidden = findForbiddenNode(child);
    if (forbidden) return forbidden;

    if (child.type === "command_name") {
      nameToken = tokenizeNode(firstNamedChild(child) ?? child);
      continue;
    }

    tokens.push(tokenizeNode(child));
  }

  if (nameToken === null) {
    return unsupported("unsupported_node", "Shell command is missing a command name.", node);
  }

  return { text: node.text, name: nameToken.value, nameToken, argv: tokens };
}

function tokenizeNode(node: TreeNode): BashToken {
  switch (node.type) {
    case "word":
      return { text: node.text, value: node.text, kind: "literal", quoted: false };
    case "raw_string":
      return { text: node.text, value: node.text.slice(1, -1), kind: "literal", quoted: true };
    case "string":
      return tokenizeString(node);
    case "simple_expansion":
    case "expansion":
      return tokenizeExpansion(node);
    case "concatenation":
      return tokenizeConcatenation(node);
    default:
      return { text: node.text, value: node.text, kind: "unresolved_expression", quoted: false };
  }
}

function tokenizeString(node: TreeNode): BashToken {
  const named = namedChildren(node);
  if (named.some((child) => child.type !== "string_content")) {
    return { text: node.text, value: node.text, kind: "unresolved_expression", quoted: true };
  }
  return {
    text: node.text,
    value: named.map((child) => child.text).join(""),
    kind: "literal",
    quoted: true,
  };
}

function tokenizeExpansion(node: TreeNode): BashToken {
  const isHome = node.text === "$HOME" || node.text === "${HOME}";
  return {
    text: node.text,
    value: node.text,
    kind: isHome ? "home_reference" : "unresolved_expression",
    quoted: false,
  };
}

function tokenizeConcatenation(node: TreeNode): BashToken {
  const parts = namedChildren(node).map(tokenizeNode);
  const unresolved = parts.some((p) => p.kind === "unresolved_expression");
  if (unresolved) {
    return { text: node.text, value: node.text, kind: "unresolved_expression", quoted: parts.some((p) => p.quoted) };
  }
  return {
    text: node.text,
    value: parts.map((p) => p.value).join(""),
    kind: parts.some((p) => p.kind === "home_reference") ? "home_reference" : "literal",
    quoted: parts.some((p) => p.quoted),
  };
}

// ------------------------------------------------------------------
// Forbidden node detection
// ------------------------------------------------------------------

function findForbiddenNode(node: TreeNode): UnsupportedBashScript | null {
  switch (node.type) {
    case "command_substitution":
      return unsupported(
        node.text.startsWith("`") ? "backticks" : "command_substitution",
        "Shell command substitution requires manual approval.",
        node,
      );
    case "process_substitution":
      return unsupported("process_substitution", "Shell process substitution requires manual approval.", node);
    case "redirected_statement":
    case "file_redirect":
      return unsupported("redirection", "Shell redirection requires manual approval.", node);
    case "heredoc_redirect":
    case "heredoc_start":
    case "heredoc_body":
    case "heredoc_end":
      return unsupported("heredoc", "Shell heredoc syntax requires manual approval.", node);
    case "subshell":
      return unsupported("subshell", "Shell subshell syntax requires manual approval.", node);
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) {
      const forbidden = findForbiddenNode(child);
      if (forbidden) return forbidden;
    }
  }
  return null;
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function parseConnector(type: string): BashConnector | null {
  if (type === "&&" || type === "||" || type === ";" || type === "|") return type;
  return null;
}

function unsupported(
  reason: BashUnsupportedReason,
  message: string,
  node?: TreeNode,
  text?: string,
): UnsupportedBashScript {
  return { kind: "unsupported", reason, message, nodeType: node?.type, text: text ?? node?.text };
}

function isUnsupported(value: ParsedBashCommand | UnsupportedBashScript): value is UnsupportedBashScript {
  return "kind" in value && value.kind === "unsupported";
}

function firstNamedChild(node: TreeNode): TreeNode | null {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.isNamed) return child;
  }
  return null;
}

function namedChildren(node: TreeNode): TreeNode[] {
  const children: TreeNode[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.isNamed) children.push(child);
  }
  return children;
}
