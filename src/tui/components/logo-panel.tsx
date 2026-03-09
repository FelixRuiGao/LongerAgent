/**
 * ASCII logo panel at top of the TUI.
 */

import React from "react";
import { Box, Text } from "ink";
import { createRequire } from "node:module";
import { theme } from "../theme.js";

const require = createRequire(import.meta.url);
const pkg = require("../../../package.json") as { version: string };

const LOGO = `\
╦  ╔═╗╔╗╔╔═╗╔═╗╦═╗  ╔═╗╔═╗╔═╗╔╗╔╔╦╗
║  ║ ║║║║║ ╦║╣ ╠╦╝  ╠═╣║ ╦║╣ ║║║ ║
╩═╝╚═╝╝╚╝╚═╝╚═╝╩╚═  ╩ ╩╚═╝╚═╝╝╚╝ ╩`;

export interface LogoPanelProps {
  cwd?: string;
}

export function LogoPanel({ cwd }: LogoPanelProps): React.ReactElement {
  return (
    <Box
      borderStyle="round"
      borderColor={theme.accent}
      paddingX={1}
      flexDirection="column"
      flexShrink={0}
    >
      <Text color={theme.accent}>{LOGO}</Text>
      <Text dimColor>v{pkg.version} · {cwd || process.cwd()}</Text>
    </Box>
  );
}
