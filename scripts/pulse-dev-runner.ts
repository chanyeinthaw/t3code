#!/usr/bin/env node
import { runDevRunnerCli } from "./dev-runner.ts";
import { PULSE_DEV_HOME } from "./lib/pulse-dev-home.ts";

runDevRunnerCli(PULSE_DEV_HOME);
