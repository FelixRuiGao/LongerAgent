import { useEffect, useRef, useState } from "react";

export const THINKING_SPINNER_FRAMES = ["◌", "○", "◎", "●", "◎", "○"] as const;
export const THINKING_SPINNER_INTERVAL = 150;

export const TOOL_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
export const TOOL_SPINNER_INTERVAL = 80;

export function useSpinner(
  frames: readonly string[],
  intervalMs: number,
  active: boolean,
): string {
  const [frameIndex, setFrameIndex] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!active) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      setFrameIndex(0);
      return;
    }

    intervalRef.current = setInterval(() => {
      setFrameIndex((prev) => (prev + 1) % frames.length);
    }, intervalMs);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [active, frames.length, intervalMs]);

  return frames[frameIndex];
}
