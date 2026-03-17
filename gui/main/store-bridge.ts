/**
 * Store bridge — IPC handlers for session persistence.
 *
 * Uses SessionRegistry for live session awareness.
 */

import { ipcMain, type BrowserWindow } from "electron";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

import { SessionStore } from "../../src/persistence.js";
import { getRegistry } from "./session-bridge.js";

function projectOrderPath(): string {
  const home = process.env.LONGERAGENT_HOME || join(homedir(), ".longeragent");
  return join(home, "project-order.json");
}

let registeredHandlers = false;

export function setupStoreBridge(win: BrowserWindow): void {
  if (registeredHandlers) return;
  registeredHandlers = true;

  // -- store:listSessions --
  // Uses the foreground session's store if available, otherwise a fallback store for cwd.
  ipcMain.handle("store:listSessions", async () => {
    const registry = getRegistry();
    const fg = registry?.getForeground();
    if (fg) return fg.store.listSessions();
    // Fallback: create a temporary store for cwd so sidebar still works
    // even when no session is in foreground
    try {
      const fallback = new SessionStore({ projectPath: process.cwd() });
      return fallback.listSessions();
    } catch { return []; }
  });

  // -- store:listProjects --
  // listProjects() scans ~/.longeragent/projects/ — any SessionStore instance can do it.
  ipcMain.handle("store:listProjects", async () => {
    try {
      const registry = getRegistry();
      const fg = registry?.getForeground();
      const store = fg?.store ?? new SessionStore({ projectPath: process.cwd() });
      if (typeof (store as any).listProjects !== "function") return [];
      return (store as any).listProjects();
    } catch { return []; }
  });

  // -- store:listProjectSessions --
  ipcMain.handle("store:listProjectSessions", async (_event, projectPath: string) => {
    try {
      const tempStore = new SessionStore({ projectPath });
      return tempStore.listSessions();
    } catch {
      return [];
    }
  });

  // -- store:deleteSession --
  ipcMain.handle("store:deleteSession", async (_event, sessionPath: string) => {
    try {
      // If there's a live session for this path, destroy it first
      const registry = getRegistry();
      if (registry) {
        const live = registry.findBySessionDir(sessionPath);
        if (live) {
          await registry.destroy(live.id);
        }
      }

      if (existsSync(sessionPath)) {
        await rm(sessionPath, { recursive: true, force: true });
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // -- store:renameSession --
  ipcMain.handle("store:renameSession", async (_event, sessionPath: string, newTitle: string) => {
    try {
      // Update meta.json
      const metaFile = join(sessionPath, "meta.json");
      if (existsSync(metaFile)) {
        const raw = JSON.parse(readFileSync(metaFile, "utf-8"));
        raw.title = newTitle;
        const tmp = metaFile + ".tmp";
        writeFileSync(tmp, JSON.stringify(raw, null, 2));
        renameSync(tmp, metaFile);
      }

      // Update log.json
      const logFile = join(sessionPath, "log.json");
      if (existsSync(logFile)) {
        const raw = JSON.parse(readFileSync(logFile, "utf-8"));
        raw.title = newTitle;
        const tmp = logFile + ".tmp";
        writeFileSync(tmp, JSON.stringify(raw, null, 2));
        renameSync(tmp, logFile);
      }

      // If there's a live session for this path, update its in-memory title
      const registry = getRegistry();
      if (registry) {
        const live = registry.findBySessionDir(sessionPath);
        if (live && typeof (live.session as any).setTitle === "function") {
          (live.session as any).setTitle(newTitle);
        }
      }

      // Emit sidebar:refresh
      if (!win.isDestroyed()) {
        win.webContents.send("sidebar:refresh");
      }

      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // -- store:getProjectOrder --
  ipcMain.handle("store:getProjectOrder", async () => {
    const p = projectOrderPath();
    if (existsSync(p)) {
      try {
        const raw = JSON.parse(readFileSync(p, "utf-8"));
        if (Array.isArray(raw)) return raw;
      } catch { /* ignore corrupt file */ }
    }
    return [];
  });

  // -- store:setProjectOrder --
  ipcMain.handle("store:setProjectOrder", async (_event, order: string[]) => {
    const p = projectOrderPath();
    const tmp = p + ".tmp";
    writeFileSync(tmp, JSON.stringify(order, null, 2));
    renameSync(tmp, p);
  });

  // -- store:archiveSession --
  ipcMain.handle("store:archiveSession", async (_event, sessionPath: string) => {
    try {
      const metaFile = join(sessionPath, "meta.json");
      if (existsSync(metaFile)) {
        const raw = JSON.parse(readFileSync(metaFile, "utf-8"));
        raw.archived = true;
        const tmp = metaFile + ".tmp";
        writeFileSync(tmp, JSON.stringify(raw, null, 2));
        renameSync(tmp, metaFile);
      }
      // Also destroy any live session for this path
      const registry = getRegistry();
      if (registry) {
        const live = registry.findBySessionDir(sessionPath);
        if (live) await registry.destroy(live.id);
      }
      if (!win.isDestroyed()) win.webContents.send("sidebar:refresh");
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // -- store:unarchiveSession --
  ipcMain.handle("store:unarchiveSession", async (_event, sessionPath: string) => {
    try {
      const metaFile = join(sessionPath, "meta.json");
      if (existsSync(metaFile)) {
        const raw = JSON.parse(readFileSync(metaFile, "utf-8"));
        delete raw.archived;
        const tmp = metaFile + ".tmp";
        writeFileSync(tmp, JSON.stringify(raw, null, 2));
        renameSync(tmp, metaFile);
      }
      if (!win.isDestroyed()) win.webContents.send("sidebar:refresh");
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // -- store:listArchivedSessions --
  ipcMain.handle("store:listArchivedSessions", async (_event, projectPath: string) => {
    try {
      const { readdirSync: rd, statSync: st } = require("node:fs");
      const tempStore = new SessionStore({ projectPath });
      const projectDir = (tempStore as any)._projectDir;
      if (!projectDir || !existsSync(projectDir)) return [];

      const results: Array<{ path: string; created: string; summary: string; title?: string; turns: number }> = [];
      const entries = rd(projectDir).sort().reverse();
      for (const name of entries) {
        if (!name.endsWith("_chat")) continue;
        const d = join(projectDir, name);
        try { if (!st(d).isDirectory()) continue; } catch { continue; }
        const metaFile = join(d, "meta.json");
        if (!existsSync(metaFile)) continue;
        try {
          const raw = JSON.parse(readFileSync(metaFile, "utf-8"));
          if (!raw.archived) continue;
          results.push({
            path: d,
            created: raw.created_at ?? "",
            summary: raw.summary ?? "",
            title: raw.title ?? undefined,
            turns: raw.turn_count ?? 0,
          });
        } catch { continue; }
      }
      return results;
    } catch {
      return [];
    }
  });
}
