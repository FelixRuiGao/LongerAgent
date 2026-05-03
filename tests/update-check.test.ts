import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { checkForUpdates } from "../src/update-check.js";

describe("checkForUpdates", () => {
  const originalFetch = globalThis.fetch;
  let tempHome: string;
  let tempFermiHome: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "fermi-update-check-"));
    tempFermiHome = join(tempHome, ".fermi");
    spyOn(console, "log").mockImplementation(() => {});
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

  it("prints a cached notice synchronously when available", () => {
    mkdirSync(tempFermiHome, { recursive: true });
    writeFileSync(join(tempFermiHome, ".update-check.json"), JSON.stringify({
      lastCheck: Date.now(),
      latestVersion: "0.2.0",
      notice: "Breaking change",
    }));

    const showUpdateNotice = checkForUpdates("0.1.0", tempFermiHome);
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
    globalThis.fetch = mock(async () => await pendingFetch) as typeof fetch;

    const showUpdateNotice = checkForUpdates("0.1.0", tempFermiHome);
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
