import { homedir } from "node:os";
import { join } from "node:path";

export const LONGERAGENT_HOME_DIR = ".longeragent";

export function getLongerAgentHomeDir(): string {
  return join(homedir(), LONGERAGENT_HOME_DIR);
}
