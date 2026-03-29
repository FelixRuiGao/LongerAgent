import type { RefObject } from "react";
import type { SyntaxStyle, ScrollBoxRenderable } from "@opentui/core";

import type { PresentationEntry } from "../presentation/types.js";

export interface ConversationPalette {
  accent: string;
  border: string;
  cyan: string;
  dim: string;
  green: string;
  muted: string;
  orange: string;
  red: string;
  text: string;
  thinking?: string;
  thinkingStatus?: string;
  toolTime: string;
  userBg: string;
  yellow: string;
}

/** Props for the new presentation-layer entry renderers. */
export interface PresentationEntryItemProps {
  entry: PresentationEntry;
  colors: ConversationPalette;
  contentWidth: number;
  markdownMode: "rendered" | "raw";
  markdownStyle: SyntaxStyle;
  onEntryClick?: (entry: PresentationEntry) => void;
}

export interface PresentationPanelProps {
  items: readonly PresentationEntry[];
  colors: ConversationPalette;
  contentWidth: number;
  markdownMode: "rendered" | "raw";
  markdownStyle: SyntaxStyle;
  processing: boolean;
  scrollRef: RefObject<ScrollBoxRenderable | null>;
  selectedChildId: string | null;
  showLogoInScroll: boolean;
  onEntryClick?: (entry: PresentationEntry) => void;
}
