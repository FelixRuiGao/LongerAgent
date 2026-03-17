/**
 * Preload script — runs in the renderer's isolated context.
 *
 * Exposes a typed `window.api` object via contextBridge,
 * providing invoke() for request/response IPC and on()/off()
 * for event subscriptions.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

contextBridge.exposeInMainWorld("api", {
  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    return ipcRenderer.invoke(channel, ...args);
  },

  on(
    channel: string,
    callback: (...args: unknown[]) => void,
  ): () => void {
    const handler = (_event: IpcRendererEvent, ...args: unknown[]) => {
      callback(...args);
    };
    ipcRenderer.on(channel, handler);
    return () => {
      ipcRenderer.removeListener(channel, handler);
    };
  },

  off(channel: string, callback: (...args: unknown[]) => void): void {
    ipcRenderer.removeListener(channel, callback);
  },
});
