/** @jsxImportSource @opentui/react */

import React from "react";

interface SectionHeaderProps {
  label: string;
  color: string;
  bold?: boolean;
  paddingLeft?: number;
  paddingBottom?: number;
}

export function SectionHeader({
  label,
  color,
  bold = true,
  paddingLeft = 0,
  paddingBottom = 0,
}: SectionHeaderProps): React.ReactElement {
  return (
    <box paddingLeft={paddingLeft} paddingBottom={paddingBottom}>
      <text fg={color} bold={bold} content={label} />
    </box>
  );
}
