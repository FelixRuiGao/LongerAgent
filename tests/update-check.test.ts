import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkForUpdates } from "../src/update-check.js";

describe("checkForUpdates", () => {
  const originalHome = process.env["HOME"];
  const originalFetch = globalThis.fetch;
  let tempHome: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "fermi-update-check-"));
    process.env["HOME"] = tempHome;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalFetch) {
      globalThis.fetch = originalFetch;
    } else {
      delete (globalThis as { fetch?: typeof fetch }).fetch;
    }
    if (originalHome === undefined) {
      delete process.env["HOME"];
    } else {
      process.env["HOME"] = originalHome;
    }
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("prints a cached notice synchronously when available", () => {
    const cacheDir = join(tempHome, ".fermi");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, ".update-check.json"), JSON.stringify({
      lastCheck: Date.now(),
      latestVersion: "0.2.0",
      notice: "Breaking change",
    }));

    const showUpdateNotice = checkForUpdates("0.1.0");
    showUpdateNotice();

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("Update available: 0.1.0 → 0.2.0"));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("Breaking change"));
  });

  it("does not print asynchronously after the caller already rendered startup output", async () => {
    let resolveFetch!: (value: {
      ok: boolean;
      json: () => Promise<{ version: string }>;
    }) => void;
    const pendingFetch = new Promise<{
      ok: boolean;
      json: () => Promise<{ version: string }>;
    }>((resolve) => {
      resolveFetch = resolve;
    });
    globalThis.fetch = vi.fn(async () => await pendingFetch) as typeof fetch;

    const showUpdateNotice = checkForUpdates("0.1.0");
    showUpdateNotice();

    expect(console.log).not.toHaveBeenCalled();

    resolveFetch({
      ok: true,
      json: async () => ({ version: "0.2.0" }),
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(console.log).not.toHaveBeenCalled();
  });
});
