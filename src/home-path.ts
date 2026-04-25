import { homedir } from "node:os";
import { join } from "node:path";

export const FERMI_HOME_DIR = ".fermi";

export function getFermiHomeDir(): string {
  return join(homedir(), FERMI_HOME_DIR);
}
