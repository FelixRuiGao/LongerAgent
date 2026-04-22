/**
 * System clipboard image reader.
 *
 * Uses macOS-native tools (osascript + AppKit) to detect and export
 * clipboard image data to a temporary file. No npm dependencies.
 */

import { execFile } from "node:child_process";
import { readFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ClipboardImageResult {
  buffer: Buffer;
  mediaType: "image/png" | "image/jpeg" | "image/tiff";
}

// AppleScript that checks clipboard for image data and writes to a temp file.
// Returns the UTI type on success, empty string if no image.
function buildExportScript(outPath: string): string {
  return `
use framework "AppKit"
set pb to current application's NSPasteboard's generalPasteboard()
set types to {"public.png", "public.tiff", "public.jpeg"}
repeat with t in types
  set d to pb's dataForType:t
  if d is not missing value then
    d's writeToFile:"${outPath}" atomically:true
    return t as text
  end if
end repeat
return ""
`;
}

const UTI_TO_MEDIA_TYPE: Record<string, ClipboardImageResult["mediaType"]> = {
  "public.png": "image/png",
  "public.tiff": "image/tiff",
  "public.jpeg": "image/jpeg",
};

/**
 * Read an image from the system clipboard.
 * Returns null if the clipboard does not contain image data.
 *
 * macOS only — returns null on other platforms.
 */
export async function readClipboardImage(): Promise<ClipboardImageResult | null> {
  if (process.platform !== "darwin") return null;

  const tempPath = join(tmpdir(), `la-clipboard-${process.pid}-${Date.now()}.img`);

  try {
    const { stdout } = await execFileAsync("osascript", ["-e", buildExportScript(tempPath)], {
      timeout: 5000,
    });

    const uti = stdout.trim();
    if (!uti || !UTI_TO_MEDIA_TYPE[uti]) return null;

    if (!existsSync(tempPath)) return null;

    const buffer = readFileSync(tempPath);
    if (buffer.length === 0) return null;

    return {
      buffer,
      mediaType: UTI_TO_MEDIA_TYPE[uti],
    };
  } catch {
    return null;
  } finally {
    try {
      if (existsSync(tempPath)) unlinkSync(tempPath);
    } catch {
      // ignore cleanup errors
    }
  }
}
