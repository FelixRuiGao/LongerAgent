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
  const attachments = entry.userAttachments;

  return (
    <box
      flexDirection="column"
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      width="100%"
    >
      <box
        flexDirection="column"
        borderStyle="rounded"
        borderColor={colors.border}
        backgroundColor={colors.userBg}
        paddingLeft={1}
        paddingRight={1}
        width="100%"
      >
        <box flexDirection="row" width="100%">
          <box flexGrow={1} flexShrink={1}>
            <text fg={colors.text} bold content={text} />
          </box>
          {queued ? (
            <text fg={colors.dim} content=" queued" />
          ) : null}
        </box>
        {attachments && attachments.length > 0 ? (
          <box flexDirection="column">
            {attachments.map((file, idx) => (
              <text key={idx} fg={colors.dim} content={`📎 ${file}`} />
            ))}
          </box>
        ) : null}
      </box>
    </box>
  );
}

export const UserEntry = React.memo(
  UserEntryInner,
  (prev, next) => prev.entry === next.entry && prev.colors === next.colors,
);
