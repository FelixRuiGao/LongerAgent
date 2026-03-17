/**
 * Electron app entry point.
 *
 * Creates the main BrowserWindow, wires up IPC bridges,
 * and handles app lifecycle events.
 */

import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { join } from "node:path";
import { readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { setupMenu } from "./menu.js";
import { setupSessionBridge } from "./session-bridge.js";
import { setupStoreBridge } from "./store-bridge.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const IS_DEV = Boolean(process.env.GUI_DEV);

let mainWindow: BrowserWindow | null = null;

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 700,
    minHeight: 500,
    backgroundColor: "#131314",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    show: false,
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.on("closed", () => {
    mainWindow = null;
  });

  return win;
}

app.whenReady().then(async () => {
  mainWindow = createWindow();

  setupMenu(mainWindow);

  // Register ALL IPC handlers BEFORE loading the page
  await setupSessionBridge(mainWindow).catch((err) => {
    console.error("[GUI] Session bridge setup failed (UI will still load):", err);
  });
  setupStoreBridge(mainWindow);

  // Open external URLs
  ipcMain.handle("shell:openExternal", async (_event, url: string) => {
    if (url.startsWith("https://")) {
      await shell.openExternal(url);
    }
  });

  // File tree handler — list directory contents
  ipcMain.handle("fs:listDir", async (_event, dirPath: string) => {
    try {
      const entries = readdirSync(dirPath, { withFileTypes: true });
      const IGNORED = new Set(["node_modules", ".git", ".next", "dist", "build", "__pycache__", ".cache", ".DS_Store", "coverage"]);
      return entries
        .filter((e) => !IGNORED.has(e.name) && !e.name.startsWith("."))
        .sort((a, b) => {
          // Directories first, then alphabetical
          if (a.isDirectory() && !b.isDirectory()) return -1;
          if (!a.isDirectory() && b.isDirectory()) return 1;
          return a.name.localeCompare(b.name);
        })
        .map((e) => ({
          name: e.name,
          isDir: e.isDirectory(),
          path: join(dirPath, e.name),
        }))
        .slice(0, 200); // Limit to prevent overwhelming the UI
    } catch {
      return [];
    }
  });

  // File dialog handler
  ipcMain.handle("dialog:openFile", async () => {
    if (!mainWindow) return undefined;
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openFile", "multiSelections"],
    });
    if (result.canceled) return undefined;
    return result.filePaths;
  });

  // Folder dialog handler — opens a project folder
  ipcMain.handle("dialog:openFolder", async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const folderPath = result.filePaths[0];

    // Import registry and create a new session for this folder
    const { getRegistry } = await import("./session-bridge.js");
    const registry = getRegistry();
    if (registry) {
      const managed = registry.create(folderPath);
      registry.setForeground(managed.id);
      // Refresh sidebar
      mainWindow.webContents.send("sidebar:refresh");
    }
    return folderPath;
  });

  console.log("[GUI] All IPC handlers registered. Loading renderer...");

  // Forward renderer console to main process terminal (before loading page)
  mainWindow.webContents.on("console-message", (_event, level, message) => {
    console.log(`[Renderer:${level}]`, message);
  });

  if (IS_DEV) {
    await mainWindow.loadURL("http://localhost:5173");
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    const rendererPath = join(__dirname, "dist-renderer", "index.html");
    console.log("[GUI] Loading renderer from:", rendererPath);
    await mainWindow.loadFile(rendererPath);
  }

  // Set window title with project directory (resolve from dist-main/ to project root)
  const projectRoot = join(__dirname, "..", "..");
  const dirName = projectRoot.split("/").pop() || projectRoot;
  mainWindow.setTitle(`LongerAgent \u2014 ${dirName}`);

  mainWindow.show();
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("activate", async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    mainWindow = createWindow();

    setupMenu(mainWindow);
    await setupSessionBridge(mainWindow).catch((err) => {
      console.error("Failed to re-setup session bridge:", err);
    });
    setupStoreBridge(mainWindow);

    if (IS_DEV) {
      await mainWindow.loadURL("http://localhost:5173");
    } else {
      const rendererPath = join(__dirname, "dist-renderer", "index.html");
      await mainWindow.loadFile(rendererPath);
    }
    mainWindow.show();
  }
});
