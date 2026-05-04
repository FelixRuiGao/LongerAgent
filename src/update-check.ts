/**
 * Update checker and self-updater.
 *
 * Checks GitHub Releases for a newer version at most once per 24 hours.
 * Caches the result in ~/.fermi/.update-check.json.
 *
 * Update flow:
 *   1. Background check finds a new version → downloads tarball to ~/.fermi/staged/
 *   2. TUI shows a hint: "v0.3.0 ready — restart to apply"
 *   3. On next startup, applyStaged() moves staged files into the install dir
 *
 * `fermi update` does the same download synchronously and asks the user to restart.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { getFermiHomeDir } from "./home-path.js";

const GITHUB_REPO = "FelixRuiGao/Fermi";
const CACHE_FILE = ".update-check.json";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

interface UpdateCache {
  lastCheck: number;
  latestVersion: string;
}

interface GitHubRelease {
  tag_name?: string;
  assets?: { name?: string; browser_download_url?: string }[];
}

function homeDir(override?: string): string {
  return override ?? getFermiHomeDir();
}

function cachePath(home: string): string {
  return join(home, CACHE_FILE);
}

function stagedDir(home: string): string {
  return join(home, "staged");
}

function readCache(home: string): UpdateCache | null {
  try {
    const raw = JSON.parse(readFileSync(cachePath(home), "utf-8"));
    if (typeof raw.lastCheck === "number" && typeof raw.latestVersion === "string") {
      return raw as UpdateCache;
    }
  } catch { /* ignore */ }
  return null;
}

function writeCache(cache: UpdateCache, home: string): void {
  try {
    mkdirSync(home, { recursive: true });
    writeFileSync(cachePath(home), JSON.stringify(cache));
  } catch { /* ignore */ }
}

export function compareVersions(current: string, latest: string): boolean {
  const parse = (v: string) => v.replace(/^v/, "").split(".").map(Number);
  const c = parse(current);
  const l = parse(latest);
  for (let i = 0; i < 3; i++) {
    if ((l[i] ?? 0) > (c[i] ?? 0)) return true;
    if ((l[i] ?? 0) < (c[i] ?? 0)) return false;
  }
  return false;
}

function assetName(): string {
  const platform = process.platform;
  const arch = process.arch === "x64" ? "x64" : process.arch;
  return `fermi-${platform}-${arch}.tar.gz`;
}

async function fetchLatestRelease(): Promise<{ version: string; downloadUrl: string | null } | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      signal: controller.signal,
      headers: { Accept: "application/vnd.github.v3+json" },
    });
    clearTimeout(timer);
    if (!resp.ok) return null;
    const data = (await resp.json()) as GitHubRelease;
    const version = data.tag_name?.replace(/^v/, "");
    if (!version) return null;
    const target = assetName();
    const asset = data.assets?.find((a) => a.name === target);
    return { version, downloadUrl: asset?.browser_download_url ?? null };
  } catch {
    return null;
  }
}

async function downloadAndStage(downloadUrl: string, home: string): Promise<void> {
  const staged = stagedDir(home);
  rmSync(staged, { recursive: true, force: true });
  mkdirSync(staged, { recursive: true });

  const resp = await fetch(downloadUrl);
  if (!resp.ok || !resp.body) throw new Error(`Download failed: ${resp.status}`);

  const tarball = join(staged, "update.tar.gz");
  const bytes = new Uint8Array(await resp.arrayBuffer());
  writeFileSync(tarball, bytes);

  const proc = Bun.spawn(["tar", "-xzf", tarball, "-C", staged], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error("Failed to extract update tarball");

  rmSync(tarball);
}

/**
 * Apply a staged update on startup. Moves files from ~/.fermi/staged/ into
 * the directory containing the running executable.
 * Returns the new version string if an update was applied, or null.
 */
export function applyStaged(homeDirOverride?: string): string | null {
  const home = homeDir(homeDirOverride);
  const staged = stagedDir(home);
  if (!existsSync(staged)) return null;

  const entries = readdirSync(staged);
  if (entries.length === 0) {
    rmSync(staged, { recursive: true, force: true });
    return null;
  }

  const installDir = dirname(process.execPath);
  for (const entry of entries) {
    const src = join(staged, entry);
    const dest = join(installDir, entry);
    rmSync(dest, { recursive: true, force: true });
    cpSync(src, dest, { recursive: true });
  }

  const cache = readCache(home);
  const version = cache?.latestVersion ?? null;

  rmSync(staged, { recursive: true, force: true });
  return version;
}

/**
 * Non-blocking background update check.
 * Returns a callback that yields the update message (if any) at call time.
 */
export function checkForUpdates(
  currentVersion: string,
  homeDirOverride?: string,
): () => string | null {
  const home = homeDir(homeDirOverride);
  let updateMessage: string | null = null;

  const cache = readCache(home);
  if (cache && Date.now() - cache.lastCheck < CHECK_INTERVAL_MS) {
    if (compareVersions(currentVersion, cache.latestVersion)) {
      updateMessage = `Update available: ${currentVersion} → ${cache.latestVersion}  Run \`fermi update\` to install.`;
    }
    return () => updateMessage;
  }

  void (async () => {
    try {
      const release = await fetchLatestRelease();
      if (!release) return;
      writeCache({ lastCheck: Date.now(), latestVersion: release.version }, home);
      if (!compareVersions(currentVersion, release.version)) return;
      updateMessage = `Update available: ${currentVersion} → ${release.version}  Run \`fermi update\` to install.`;
      if (release.downloadUrl) {
        await downloadAndStage(release.downloadUrl, home);
        updateMessage = `Fermi ${release.version} downloaded — restart to apply.`;
      }
    } catch { /* silently ignore */ }
  })();

  return () => updateMessage;
}

/**
 * Synchronous-style update for `fermi update` CLI subcommand.
 */
export async function runUpdate(currentVersion: string, homeDirOverride?: string): Promise<void> {
  const home = homeDir(homeDirOverride);
  console.log("Checking for updates...");

  const release = await fetchLatestRelease();
  if (!release) {
    console.log("Could not reach GitHub. Check your network connection.");
    return;
  }

  if (!compareVersions(currentVersion, release.version)) {
    console.log(`Already up to date (${currentVersion}).`);
    return;
  }

  if (!release.downloadUrl) {
    console.log(`Version ${release.version} is available but no binary found for ${process.platform}-${process.arch}.`);
    return;
  }

  console.log(`Downloading ${release.version}...`);
  await downloadAndStage(release.downloadUrl, home);
  writeCache({ lastCheck: Date.now(), latestVersion: release.version }, home);

  // Apply immediately — the old binary keeps running via its fd
  const installDir = dirname(process.execPath);
  const staged = stagedDir(home);
  const entries = readdirSync(staged);
  for (const entry of entries) {
    const src = join(staged, entry);
    const dest = join(installDir, entry);
    rmSync(dest, { recursive: true, force: true });
    renameSync(src, dest);
  }
  rmSync(staged, { recursive: true, force: true });

  console.log(`Updated to ${release.version}. Restart fermi to use the new version.`);
}
