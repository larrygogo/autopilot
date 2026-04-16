import { homedir } from "os";
import { join } from "path";

export const VERSION = "1.0.0";
export const AUTOPILOT_HOME = process.env.AUTOPILOT_HOME || join(homedir(), ".autopilot");
