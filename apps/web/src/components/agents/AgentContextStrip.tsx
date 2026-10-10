import { resolveEnvironmentMachineKind, type EnvironmentId } from "@t3tools/contracts";
import { useEnvironment } from "../../state/environments";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";

/** Agents use a fixed environment workspace; the strip only hosts composer controls and its label. */
export function AgentContextStrip({
  environmentId,
  composerControlsHostRef,
  contextStripVisible,
}: {
  environmentId: EnvironmentId;
  composerControlsHostRef: (element: HTMLDivElement | null) => void;
  contextStripVisible: boolean;
}) {
  const environment = useEnvironment(environmentId);
  return (
    <div className="flex min-w-0 items-center gap-3 px-3 py-1.5">
      {contextStripVisible ? (
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <EnvironmentMachineIcon
            kind={resolveEnvironmentMachineKind(environment?.serverConfig ?? null)}
            className="size-3.5 shrink-0"
          />
          <span className="truncate">{environment?.label ?? "Unavailable environment"}</span>
        </div>
      ) : null}
      <div
        ref={composerControlsHostRef}
        data-chat-resting-composer-controls-host="true"
        className="flex min-w-0 flex-1 items-center justify-start overflow-x-clip overflow-y-visible"
      />
    </div>
  );
}
