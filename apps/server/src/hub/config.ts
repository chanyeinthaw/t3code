import type { ServerConfig } from "../config.ts";

/** Hub credentials have their own identity and database, independent of execution state. */
export function hubAuthConfig(config: ServerConfig["Service"]): ServerConfig["Service"] {
  const stateDir = `${config.stateDir}/hub`;
  return {
    ...config,
    stateDir,
    dbPath: `${stateDir}/statev2.sqlite`,
    secretsDir: `${stateDir}/secrets`,
    environmentIdPath: `${stateDir}/environment-id`,
    serverRuntimeStatePath: `${stateDir}/server-runtime.json`,
    noAuth: false,
  };
}
