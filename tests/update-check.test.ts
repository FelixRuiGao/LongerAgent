import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { checkForUpdates } from "../src/update-check.js";

describe("checkForUpdates", () => {
  const originalFetch = globalThis.fetch;
  let tempHome: string;
  let tempFermiHome: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "fermi-update-check-"));
    tempFermiHome = join(tempHome, ".fermi");
  });

  afterEach(() => {
    mock.restore();
    if (originalFetch) {
      globalThis.fetch = originalFetch;
    } else {
      delete (globalThis as { fetch?: typeof fetch }).fetch;
    }
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("returns a cached notice synchronously when available", () => {
    mkdirSync(tempFermiHome, { recursive: true });
    writeFileSync(join(tempFermiHome, ".update-check.json"), JSON.stringify({
      lastCheck: Date.now(),
      latestVersion: "0.2.0",
    }));

    const getNotice = checkForUpdates("0.1.0", tempFermiHome);
    const notice = getNotice();

    expect(notice).toContain("0.1.0");
    expect(notice).toContain("0.2.0");
  });

  it("returns null when no update is available from cache", () => {
    mkdirSync(tempFermiHome, { recursive: true });
    writeFileSync(join(tempFermiHome, ".update-check.json"), JSON.stringify({
      lastCheck: Date.now(),
      latestVersion: "0.1.0",
    }));

    const getNotice = checkForUpdates("0.1.0", tempFermiHome);
    expect(getNotice()).toBeNull();
  });

  it("does not return a notice before the background fetch completes", async () => {
    let resolveFetch!: (value: {
      ok: boolean;
      json: () => Promise<{ tag_name: string; assets: { name: string; browser_download_url: string }[] }>;
    }) => void;
    const pendingFetch = new Promise<{
      ok: boolean;
      json: () => Promise<{ tag_name: string; assets: { name: string; browser_download_url: string }[] }>;
    }>((resolve) => {
      resolveFetch = resolve;
    });
    globalThis.fetch = mock(async () => await pendingFetch) as typeof fetch;

    const getNotice = checkForUpdates("0.1.0", tempFermiHome);
    expect(getNotice()).toBeNull();

    resolveFetch({
      ok: true,
      json: async () => ({ tag_name: "v0.2.0", assets: [] }),
    });

    // Let the background promise chain settle
    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(getNotice()).toContain("0.2.0");
  });
});
