/**
 * Shared argument-validation helpers for tool executors.
 *
 * Extracted from Session so that standalone manager classes
 * (BackgroundShellManager, etc.) can validate tool arguments
 * without depending on the Session instance.
 */

import { ToolResult } from "../providers/base.js";

export function toolArgError(toolName: string, message: string): ToolResult {
  return new ToolResult({ content: `Error: invalid arguments for ${toolName}: ${message}` });
}

export function argOptionalString(
  toolName: string,
  args: Record<string, unknown>,
  key: string,
): string | undefined | ToolResult {
  const value = args[key];
  if (value == null) return undefined;
  if (typeof value !== "string") {
    return toolArgError(toolName, `'${key}' must be a string.`);
  }
  return value;
}

export function argRequiredString(
  toolName: string,
  args: Record<string, unknown>,
  key: string,
  opts?: { nonEmpty?: boolean },
): string | ToolResult {
  const value = args[key];
  if (typeof value !== "string") {
    return toolArgError(toolName, `'${key}' must be a string.`);
  }
  if (opts?.nonEmpty && !value.trim()) {
    return toolArgError(toolName, `'${key}' must be a non-empty string.`);
  }
  return value;
}

export function argRequiredStringArray(
  toolName: string,
  args: Record<string, unknown>,
  key: string,
): string[] | ToolResult {
  const value = args[key];
  if (!Array.isArray(value)) {
    return toolArgError(toolName, `'${key}' must be an array of strings.`);
  }
  for (let i = 0; i < value.length; i++) {
    if (typeof value[i] !== "string") {
      return toolArgError(toolName, `'${key}[${i}]' must be a string.`);
    }
  }
  return value as string[];
}

export function argOptionalInteger(
  toolName: string,
  args: Record<string, unknown>,
  key: string,
): number | undefined | ToolResult {
  const value = args[key];
  if (value == null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    return toolArgError(toolName, `'${key}' must be an integer.`);
  }
  return value;
}
