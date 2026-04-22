/**
 * Image compression / resizing.
 *
 * Uses macOS `sips` (scriptable image processing system) — no npm dependencies.
 * Constraints:
 *   - Long edge ≤ 2000 px
 *   - File size  ≤ 4.5 MB
 */

import { execFile } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const MAX_LONG_EDGE = 2000;
const MAX_SIZE_BYTES = 4.5 * 1024 * 1024; // 4.5 MB

export interface ProcessedImage {
  base64: string;
  mediaType: "image/png" | "image/jpeg";
  width: number;
  height: number;
  sizeBytes: number;
}

interface SipsDimensions {
  width: number;
  height: number;
}

async function sipsGetDimensions(filePath: string): Promise<SipsDimensions> {
  const { stdout } = await execFileAsync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", filePath], {
    timeout: 5000,
  });
  const wMatch = stdout.match(/pixelWidth:\s*(\d+)/);
  const hMatch = stdout.match(/pixelHeight:\s*(\d+)/);
  return {
    width: wMatch ? parseInt(wMatch[1], 10) : 0,
    height: hMatch ? parseInt(hMatch[1], 10) : 0,
  };
}

async function sipsResize(filePath: string, outPath: string, maxEdge: number): Promise<void> {
  await execFileAsync("sips", [
    "--resampleHeightWidthMax", String(maxEdge),
    filePath,
    "--out", outPath,
  ], { timeout: 10000 });
}

async function sipsToJpeg(filePath: string, outPath: string, quality: number): Promise<void> {
  await execFileAsync("sips", [
    "-s", "format", "jpeg",
    "-s", "formatOptions", String(Math.round(quality * 100)),
    filePath,
    "--out", outPath,
  ], { timeout: 10000 });
}

/**
 * Process an image buffer: resize if too large, compress if too heavy.
 *
 * macOS only — throws on other platforms.
 */
export async function processImage(
  inputBuffer: Buffer,
  inputMediaType: string,
): Promise<ProcessedImage> {
  if (process.platform !== "darwin") {
    throw new Error("Image processing requires macOS (sips).");
  }

  const ext = inputMediaType === "image/jpeg" ? ".jpg"
    : inputMediaType === "image/tiff" ? ".tiff"
    : ".png";

  const tmpBase = join(tmpdir(), `la-imgproc-${process.pid}-${Date.now()}`);
  const srcPath = `${tmpBase}-src${ext}`;
  const resizedPath = `${tmpBase}-resized.png`;
  const jpegPath = `${tmpBase}-compressed.jpg`;

  const tempFiles = [srcPath, resizedPath, jpegPath];

  try {
    writeFileSync(srcPath, inputBuffer);

    // 1. Get dimensions
    const dims = await sipsGetDimensions(srcPath);
    const longEdge = Math.max(dims.width, dims.height);

    // 2. Resize if long edge exceeds limit
    let currentPath = srcPath;
    let currentWidth = dims.width;
    let currentHeight = dims.height;

    if (longEdge > MAX_LONG_EDGE) {
      await sipsResize(srcPath, resizedPath, MAX_LONG_EDGE);
      currentPath = resizedPath;
      const newDims = await sipsGetDimensions(resizedPath);
      currentWidth = newDims.width;
      currentHeight = newDims.height;
    }

    // 3. Check size — if already within limits, return as PNG
    let currentBuffer = readFileSync(currentPath);
    if (currentBuffer.length <= MAX_SIZE_BYTES) {
      const mediaType = currentPath.endsWith(".jpg") ? "image/jpeg" as const : "image/png" as const;
      return {
        base64: currentBuffer.toString("base64"),
        mediaType,
        width: currentWidth,
        height: currentHeight,
        sizeBytes: currentBuffer.length,
      };
    }

    // 4. Convert to JPEG with decreasing quality until under size limit
    const qualities = [0.90, 0.85, 0.80, 0.70, 0.60];
    for (const q of qualities) {
      await sipsToJpeg(currentPath, jpegPath, q);
      currentBuffer = readFileSync(jpegPath);
      if (currentBuffer.length <= MAX_SIZE_BYTES) {
        const jpegDims = await sipsGetDimensions(jpegPath);
        return {
          base64: currentBuffer.toString("base64"),
          mediaType: "image/jpeg",
          width: jpegDims.width,
          height: jpegDims.height,
          sizeBytes: currentBuffer.length,
        };
      }
    }

    // 5. Last resort: return the lowest quality JPEG even if over limit
    const finalDims = await sipsGetDimensions(jpegPath);
    return {
      base64: currentBuffer.toString("base64"),
      mediaType: "image/jpeg",
      width: finalDims.width,
      height: finalDims.height,
      sizeBytes: currentBuffer.length,
    };
  } finally {
    for (const f of tempFiles) {
      try {
        if (existsSync(f)) unlinkSync(f);
      } catch {
        // ignore cleanup errors
      }
    }
  }
}
