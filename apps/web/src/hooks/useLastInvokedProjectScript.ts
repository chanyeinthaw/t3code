import { ProjectId } from "@pulse/contracts";
import * as Schema from "effect/Schema";

import { useLocalStorage } from "./useLocalStorage";

export const LAST_INVOKED_SCRIPT_BY_PROJECT_KEY = "pulse:last-invoked-script-by-project";

export const LastInvokedScriptByProjectSchema = Schema.Record(ProjectId, Schema.String);

export function useLastInvokedProjectScript() {
  return useLocalStorage(LAST_INVOKED_SCRIPT_BY_PROJECT_KEY, {}, LastInvokedScriptByProjectSchema);
}
