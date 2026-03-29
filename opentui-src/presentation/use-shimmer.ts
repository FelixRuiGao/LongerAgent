import { useEffect, useRef, useState } from "react";

import { RGBA } from "../forked/core/lib/RGBA.js";
import { StyledText } from "../forked/core/lib/styled-text.js";
import type { TextChunk } from "../forked/core/text-buffer.js";

const SHIMMER_WINDOW = 5;
const SHIMMER_INTERVAL = 60;
const SHIMMER_BASE_BRIGHTNESS = 0.4;
const SHIMMER_PEAK_BRIGHTNESS = 1.0;

function gaussian(x: number, sigma: number): number {
  return Math.exp(-(x * x) / (2 * sigma * sigma));
}

function modulateColor(base: RGBA, brightness: number): RGBA {
  return RGBA.fromValues(
    Math.min(1, base.r * brightness),
    Math.min(1, base.g * brightness),
    Math.min(1, base.b * brightness),
    base.a,
  );
}

export function useShimmer(
  text: string,
  baseColor: RGBA,
  active: boolean,
): StyledText {
  const [position, setPosition] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const textLen = text.length;

  useEffect(() => {
    if (!active || textLen === 0) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      setPosition(0);
      return;
    }

    intervalRef.current = setInterval(() => {
      setPosition((prev) => (prev + 1) % (textLen + SHIMMER_WINDOW));
    }, SHIMMER_INTERVAL);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [active, textLen]);

  if (!active || textLen === 0) {
    const chunk: TextChunk = { __isChunk: true, text, fg: baseColor };
    return new StyledText([chunk]);
  }

  const sigma = SHIMMER_WINDOW / 2;
  const chunks: TextChunk[] = [];

  for (let i = 0; i < textLen; i++) {
    const distance = Math.abs(i - position);
    const factor = gaussian(distance, sigma);
    const brightness = SHIMMER_BASE_BRIGHTNESS +
      (SHIMMER_PEAK_BRIGHTNESS - SHIMMER_BASE_BRIGHTNESS) * factor;
    const color = modulateColor(baseColor, brightness);

    chunks.push({
      __isChunk: true,
      text: text[i],
      fg: color,
    });
  }

  return new StyledText(chunks);
}
