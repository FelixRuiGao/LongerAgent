/**
 * MCP server configuration loader.
 *
 * Loads MCP server definitions from ~/.longeragent/mcp.json.
 * Format matches the mcp_servers section of the old config.yaml but in JSON.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { MCPServerConfig } from "./config.js";

function resolveEnv(value: string): string {
  if (typeof value === "string" && value.startsWith("${") && value.endsWith("}")) {
    const envName = value.slice(2, -1);
    const resolved = process.env[envName];
    if (resolved === undefined) {
      throw new Error(`Environment variable '${envName}' is not set`);
    }
    return resolved;
  }
  return value;
}

/**
 * Load MCP server configurations from mcp.json in the given directory.
 * Returns empty array if the file doesn't exist.
 */
export function loadMcpServers(homeDir: string): MCPServerConfig[] {
  const mcpPath = join(homeDir, "mcp.json");
  if (!existsSync(mcpPath)) return [];

  let raw: Record<string, Record<string, unknown>>;
  try {
    const content = readFileSync(mcpPath, "utf-8");
    raw = JSON.parse(content) as Record<string, Record<string, unknown>>;
  } catch {
    return [];
  }

  const servers: MCPServerConfig[] = [];
  for (const [name, cfg] of Object.entries(raw)) {
    if (!cfg || typeof cfg !== "object") continue;
    const env: Record<string, string> = {};
    const rawEnv = cfg["env"] as Record<string, string> | undefined;
    if (rawEnv) {
      for (const [k, v] of Object.entries(rawEnv)) {
        env[k] = resolveEnv(String(v));
      }
    }
    servers.push({
      name,
      transport: (cfg["transport"] as "stdio" | "sse") ?? "stdio",
      command: (cfg["command"] as string) ?? "",
      args: (cfg["args"] as string[]) ?? [],
      url: (cfg["url"] as string) ?? "",
      env,
      envAllowlist: Array.isArray(cfg["env_allowlist"])
        ? (cfg["env_allowlist"] as unknown[]).map((v) => String(v))
        : undefined,
      sensitiveTools: Array.isArray(cfg["sensitive_tools"])
        ? (cfg["sensitive_tools"] as unknown[]).map((v) => String(v))
        : undefined,
    });
  }
  return servers;
}
