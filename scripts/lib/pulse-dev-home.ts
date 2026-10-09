import type { DevRunnerHome } from "../dev-runner.ts";

export const PULSE_DEV_HOME = {
  environmentVariable: "PULSE_HOME",
  directoryName: ".pulse",
} as const satisfies DevRunnerHome;
