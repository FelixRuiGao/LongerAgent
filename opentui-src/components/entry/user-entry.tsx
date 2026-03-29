/** @jsxImportSource @opentui/react */

import React from "react";

import type { PresentationEntry } from "../../presentation/types.js";
import type { ConversationPalette } from "../conversation-types.js";

interface UserEntryProps {
  entry: PresentationEntry;
  colors: ConversationPalette;
}

function UserEntryInner(
  { entry, colors }: UserEntryProps,
): React.ReactElement {
  const text = entry.userText ?? "";
  const queued = entry.userQueued ?? false;

  return (
    <box>
      <box height={1} />
      <box backgroundColor={colors.userBg} paddingLeft={1} paddingRight={1} paddingTop={1} paddingBottom={1}>
        <text fg={colors.text} bold content={text} wrapMode="word" width="100%" />
        {queued ? <text fg={colors.orange} content=" [queued]" /> : null}
      </box>
      <box height={1} />
    </box>
  );
}

export const UserEntry = React.memo(
  UserEntryInner,
  (prev, next) => prev.entry === next.entry && prev.colors === next.colors,
);
