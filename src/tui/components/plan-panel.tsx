import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";

export interface PlanCheckpointUi {
  text: string;
  checked: boolean;
}

export interface PlanPanelProps {
  checkpoints: PlanCheckpointUi[];
  /** When false the pulse animation stops (model idle). */
  active?: boolean;
}

export function PlanPanel({ checkpoints, active = true }: PlanPanelProps): React.ReactElement {
  const done = checkpoints.filter((c) => c.checked).length;
  const total = checkpoints.length;

  // Animate the first unchecked checkpoint: alternate ○/● every 1s,
  // but only while the model is actively working.
  const [pulse, setPulse] = useState(false);
  const firstUncheckedIdx = checkpoints.findIndex((c) => !c.checked);
  useEffect(() => {
    if (!active || firstUncheckedIdx < 0) {
      setPulse(false);
      return;
    }
    const timer = setInterval(() => setPulse((p) => !p), 1000);
    return () => clearInterval(timer);
  }, [firstUncheckedIdx, active]);

  return (
    <Box
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      flexDirection="column"
    >
      <Text bold color="cyan">
        Plan ({done}/{total})
      </Text>
      {checkpoints.map((cp, i) => (
        <Text key={i} dimColor={cp.checked}>
          {cp.checked ? "  ✓ " : i === firstUncheckedIdx && pulse ? "  ● " : "  ○ "}
          {cp.text}
        </Text>
      ))}
    </Box>
  );
}
