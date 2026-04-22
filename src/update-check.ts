/**
 * Non-blocking update checker.
 *
 * Checks the npm registry for a newer version at most once per 24 hours.
 * Caches the result in ~/.vigil/.update-check.json.
 *
 * The latest package.json may contain an `updateNotice` string field —
 * if present, it is displayed alongside the version update message.
 * This allows the maintainer to communicate breaking changes, migration
 * instructions, or urgent notices to users on older versions.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getVigilHomeDir } from "./home-path.js";

const CACHE_FILE = ".update-check.json";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const PACKAGE_NAME = "vigil-code";

interface UpdateCache {
  lastCheck: number;
  latestVersion: string;
  /** Optional notice from the latest version's package.json `updateNotice` field. */
  notice?: string;
}

interface RegistryResponse {
  version?: string;
  updateNotice?: string;
}

function cachePath(): string {
  return join(getVigilHomeDir(), CACHE_FILE);
}

function readCache(): UpdateCache | null {
  try {
    const raw = JSON.parse(readFileSync(cachePath(), "utf-8"));
    if (typeof raw.lastCheck === "number" && typeof raw.latestVersion === "string") {
      return raw as UpdateCache;
    }
  } catch { /* ignore */ }
  return null;
}

function writeCache(cache: UpdateCache): void {
  try {
    const dir = getVigilHomeDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(cachePath(), JSON.stringify(cache));
  } catch { /* ignore */ }
}

function compareVersions(current: string, latest: string): boolean {
  const parse = (v: string) => v.replace(/^v/, "").split(".").map(Number);
  const c = parse(current);
  const l = parse(latest);
  for (let i = 0; i < 3; i++) {
    if ((l[i] ?? 0) > (c[i] ?? 0)) return true;
    if ((l[i] ?? 0) < (c[i] ?? 0)) return false;
  }
  return false;
}

/**
 * Check for updates in the background.
 * Returns a function that prints the notice only if it is already known at the
 * time the caller invokes it. This avoids writing to stdout after the Ink UI
 * has taken over the terminal.
 */
export function checkForUpdates(currentVersion: string): () => void {
  let updateMessage: string | null = null;

  // Check cache first
  const cache = readCache();
  if (cache && Date.now() - cache.lastCheck < CHECK_INTERVAL_MS) {
    if (compareVersions(currentVersion, cache.latestVersion)) {
      updateMessage = formatMessage(currentVersion, cache.latestVersion, cache.notice);
    }
    return () => { if (updateMessage) console.log(updateMessage); };
  }

  // Fire and forget — fetch in background
  void fetchLatestVersion()
    .then((result) => {
      if (!result) return;
      writeCache({
        lastCheck: Date.now(),
        latestVersion: result.version,
        notice: result.notice,
      });
      if (compareVersions(currentVersion, result.version)) {
        updateMessage = formatMessage(currentVersion, result.version, result.notice);
      }
    })
    .catch(() => { /* silently ignore network errors */ });

  // Only print if the background fetch already finished before the caller asks.
  return () => { if (updateMessage) console.log(updateMessage); };
}

async function fetchLatestVersion(): Promise<{ version: string; notice?: string } | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const resp = await fetch(`https://registry.npmjs.org/${PACKAGE_NAME}/latest`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return null;
    const data = (await resp.json()) as RegistryResponse;
    if (!data.version) return null;
    return {
      version: data.version,
      notice: typeof data.updateNotice === "string" ? data.updateNotice : undefined,
    };
  } catch {
    return null;
  }
}

function formatMessage(current: string, latest: string, notice?: string): string {
  let msg = `\n  Update available: ${current} → ${latest}\n  Run: npm install -g ${PACKAGE_NAME}\n`;
  if (notice) {
    msg += `\n  Note: ${notice}\n`;
  }
  return msg;
}
