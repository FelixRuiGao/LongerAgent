export interface SessionCapabilities {
  includeSpawnTool: boolean;
  includeKillTool: boolean;
  includeCheckStatusTool: boolean;
  includeAwaitEventTool: boolean;
  includeShowContextTool: boolean;
  includeSummarizeTool: boolean;
  includeAskTool: boolean;
  includeSkillTools: boolean;
}

export const ROOT_SESSION_CAPABILITIES: SessionCapabilities = {
  includeSpawnTool: true,
  includeKillTool: true,
  includeCheckStatusTool: true,
  includeAwaitEventTool: true,
  includeShowContextTool: true,
  includeSummarizeTool: true,
  includeAskTool: true,
  includeSkillTools: true,
};

export const CHILD_SESSION_CAPABILITIES: SessionCapabilities = {
  includeSpawnTool: false,
  includeKillTool: false,
  includeCheckStatusTool: false,
  includeAwaitEventTool: true,
  includeShowContextTool: false,
  includeSummarizeTool: false,
  includeAskTool: false,
  includeSkillTools: false,
};
