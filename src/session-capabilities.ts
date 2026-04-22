export interface SessionCapabilities {
  includeSpawnTool: boolean;
  includeKillTool: boolean;
  includeCheckStatusTool: boolean;
  includeWaitTool: boolean;
  includeShowContextTool: boolean;
  includeDistillContextTool: boolean;
  includeAskTool: boolean;
  includeSkillTools: boolean;
}

export const ROOT_SESSION_CAPABILITIES: SessionCapabilities = {
  includeSpawnTool: true,
  includeKillTool: true,
  includeCheckStatusTool: true,
  includeWaitTool: true,
  includeShowContextTool: true,
  includeDistillContextTool: true,
  includeAskTool: true,
  includeSkillTools: true,
};

export const CHILD_SESSION_CAPABILITIES: SessionCapabilities = {
  includeSpawnTool: false,
  includeKillTool: false,
  includeCheckStatusTool: false,
  includeWaitTool: true,
  includeShowContextTool: false,
  includeDistillContextTool: false,
  includeAskTool: false,
  includeSkillTools: false,
};
