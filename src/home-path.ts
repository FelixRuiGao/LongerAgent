import { homedir } from "node:os";
import { join } from "node:path";

export const VIGIL_HOME_DIR = ".vigil";

export function getVigilHomeDir(): string {
  return join(homedir(), VIGIL_HOME_DIR);
}
