import { useEffect, useRef, useState } from "react";

// Phase-specific spinner presets — each visually distinct at a glance.
export const THINKING_SPINNER_FRAMES = ["◌", "○", "⊙", "●", "⊙", "○"] as const;
export const THINKING_SPINNER_INTERVAL = 600;

export const TOOL_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
export const TOOL_SPINNER_INTERVAL = 80;

export const DECODING_SPINNER_FRAMES = ["〡", "〢", "〣"] as const;
export const DECODING_SPINNER_INTERVAL = 400;

export const PREFILL_SPINNER_FRAMES = ["░", "▒", "▓", "▒"] as const;
export const PREFILL_SPINNER_INTERVAL = 600;

export const AWAITING_SPINNER_FRAMES = ["◐", "◓", "◑", "◒"] as const;
export const AWAITING_SPINNER_INTERVAL = 700;

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
