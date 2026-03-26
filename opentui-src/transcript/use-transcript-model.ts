import { useCallback, useEffect, useRef, useState } from "react";

import { projectToTuiEntries } from "../../src/log-projection.js";
import type { LogEntry } from "../../src/log-entry.js";
import type { ChildSessionSnapshot } from "../../src/session-tree-types.js";
import type { Session as TuiSession } from "../../src/tui/types.js";

import { reconcileEntries } from "./reconcile.js";
import type { ReconciledConversationEntry } from "./types.js";

export interface ActiveTranscriptSource {
  sourceKey: string;
  logRevision: number;
  log: readonly LogEntry[];
}

interface UseTranscriptModelOptions {
  session: TuiSession;
  selectedChildId: string | null;
  childSessions: readonly ChildSessionSnapshot[];
}

export interface TranscriptSyncState {
  session: TuiSession;
  sourceKey: string;
  logRevision: number;
}

export function getActiveTranscriptSource(
  session: TuiSession,
  selectedChildId: string | null,
  childSessions: readonly ChildSessionSnapshot[],
): ActiveTranscriptSource {
  if (selectedChildId) {
    const childLog = session.getChildSessionLog?.(selectedChildId) ?? null;
    const childSnapshot = childSessions.find((snapshot) => snapshot.id === selectedChildId) ?? null;
    if (childLog) {
      return {
        sourceKey: `child:${selectedChildId}`,
        logRevision: childSnapshot?.logRevision ?? 0,
        log: childLog,
      };
    }
  }

  return {
    sourceKey: "root",
    logRevision: session.getLogRevision?.() ?? 0,
    log: session.log ?? [],
  };
}

export function projectTranscriptEntries(log: readonly LogEntry[]): ReconciledConversationEntry[] {
  return reconcileEntries([], projectToTuiEntries([...log] as LogEntry[]));
}

export function shouldSyncTranscript(
  previous: TranscriptSyncState,
  nextSession: TuiSession,
  nextSource: ActiveTranscriptSource,
): boolean {
  return !(
    previous.session === nextSession
    && previous.sourceKey === nextSource.sourceKey
    && previous.logRevision === nextSource.logRevision
  );
}

export function useTranscriptModel(
  { session, selectedChildId, childSessions }: UseTranscriptModelOptions,
): ReconciledConversationEntry[] {
  const selectedChildIdRef = useRef(selectedChildId);
  const childSessionsRef = useRef(childSessions);
  selectedChildIdRef.current = selectedChildId;
  childSessionsRef.current = childSessions;

  const initialSource = getActiveTranscriptSource(session, selectedChildId, childSessions);
  const [items, setItems] = useState<ReconciledConversationEntry[]>(
    () => projectTranscriptEntries(initialSource.log),
  );
  const syncStateRef = useRef<TranscriptSyncState>({
    session,
    sourceKey: initialSource.sourceKey,
    logRevision: initialSource.logRevision,
  });

  const syncTranscript = useCallback(() => {
    const source = getActiveTranscriptSource(
      session,
      selectedChildIdRef.current,
      childSessionsRef.current,
    );
    const previous = syncStateRef.current;
    if (!shouldSyncTranscript(previous, session, source)) {
      return;
    }

    const nextEntries = projectToTuiEntries([...(source.log ?? [])] as LogEntry[]);
    setItems((current) => reconcileEntries(current, nextEntries));
    syncStateRef.current = {
      session,
      sourceKey: source.sourceKey,
      logRevision: source.logRevision,
    };
  }, [session]);

  useEffect(() => {
    syncTranscript();
  }, [childSessions, selectedChildId, syncTranscript]);

  useEffect(() => {
    const unsubscribe = typeof session.subscribeLog === "function"
      ? session.subscribeLog(syncTranscript)
      : undefined;
    const poller = setInterval(syncTranscript, 250);
    return () => {
      if (unsubscribe) unsubscribe();
      clearInterval(poller);
    };
  }, [session, syncTranscript]);

  return items;
}
