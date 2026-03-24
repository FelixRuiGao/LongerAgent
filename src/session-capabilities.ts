export interface SessionCapabilities {
  includeSpawnTool: boolean;
  includeKillTool: boolean;
  includeCheckStatusTool: boolean;
  includeWaitTool: boolean;
  includeShowContextTool: boolean;
  includeSummarizeContextTool: boolean;
  includeAskTool: boolean;
  includePlanTool: boolean;
  includeSkillTools: boolean;
  includeReloadSkillsTool: boolean;
}

export const ROOT_SESSION_CAPABILITIES: SessionCapabilities = {
  includeSpawnTool: true,
  includeKillTool: true,
  includeCheckStatusTool: true,
  includeWaitTool: true,
  includeShowContextTool: true,
  includeSummarizeContextTool: true,
  includeAskTool: true,
  // Plan is intentionally soft-disabled at the runtime surface for now.
  includePlanTool: false,
  includeSkillTools: true,
  includeReloadSkillsTool: true,
};

export const CHILD_SESSION_CAPABILITIES: SessionCapabilities = {
  includeSpawnTool: false,
  includeKillTool: false,
  includeCheckStatusTool: false,
  includeWaitTool: false,
  includeShowContextTool: false,
  includeSummarizeContextTool: false,
  includeAskTool: false,
  includePlanTool: false,
  includeSkillTools: false,
  includeReloadSkillsTool: false,
};
