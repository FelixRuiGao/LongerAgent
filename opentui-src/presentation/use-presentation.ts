import { useMemo, useRef } from "react";

import type { ChildSessionSnapshot } from "../../src/session-tree-types.js";
import type { Session as TuiSession } from "../../src/ui/contracts.js";

import { useTranscriptModel } from "../transcript/use-transcript-model.js";
import type { PresentationEntry } from "./types.js";
import { presentationTransform } from "./transform.js";

interface UsePresentationOptions {
  session: TuiSession;
  selectedChildId: string | null;
  childSessions: readonly ChildSessionSnapshot[];
  processing: boolean;
}

export function usePresentationEntries(
  { session, selectedChildId, childSessions, processing }: UsePresentationOptions,
): PresentationEntry[] {
  const reconciledItems = useTranscriptModel({ session, selectedChildId, childSessions });
  const previousRef = useRef<PresentationEntry[]>([]);

  const presentationItems = useMemo(() => {
    const result = presentationTransform(reconciledItems, previousRef.current, processing);
    previousRef.current = result;
    return result;
  }, [reconciledItems, processing]);

  return presentationItems;
}
