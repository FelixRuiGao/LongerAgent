import type { ConversationEntry } from "../../src/tui/types.js";

export interface ReconciledConversationEntry {
  id: string;
  entry: ConversationEntry;
  contentVersion: number;
}
