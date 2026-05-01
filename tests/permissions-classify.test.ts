import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { classifyToolAsync } from "../src/permissions/index.js";

function makeFixture(): string {
  const root = join(tmpdir(), `fermi-permissions-${process.pid}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "a"), "a\n", "utf-8");
  writeFileSync(join(root, "b"), "b\n", "utf-8");
  mkdirSync(join(root, "target"), { recursive: true });
  mkdirSync(join(root, "out dir"), { recursive: true });
  return root;
}

async function classifyBash(command: string, cwd: string) {
  return classifyToolAsync("bash", { command, cwd });
}

describe("bash permission classification for trackable cp/mv rewind", () => {
  it("keeps a simple single-source copy to a new target reversible", async () => {
    const root = makeFixture();
    try {
      const result = await classifyBash("cp a missing", root);
      expect(result.permissionClass).toBe("write_reversible");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses bash cwd when upgrading cp/mv targets that are existing directories", async () => {
    const root = makeFixture();
    try {
      const result = await classifyBash("cp a target", root);
      expect(result.permissionClass).toBe("write_potent");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("checks later cp/mv segments in compound commands", async () => {
    const root = makeFixture();
    try {
      const cases = [
        "cp a missing && cp b target",
        "cp a missing && mv b target",
        "cp a missing && cp -t target b",
        "cp a missing && cp b c target",
        "cp a missing && cp --parents b target",
      ];

      for (const command of cases) {
        const result = await classifyBash(command, root);
        expect(result.permissionClass, command).toBe("write_potent");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("upgrades unsupported cp target-directory flag forms", async () => {
    const root = makeFixture();
    try {
      const cases = [
        "cp -t target a",
        "cp -rt target a",
        "cp -R -t target a",
        "cp --target-directory=target a",
      ];

      for (const command of cases) {
        const result = await classifyBash(command, root);
        expect(result.permissionClass, command).toBe("write_potent");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
