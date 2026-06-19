import { getTerminalLabel } from "@pulse/shared/terminalLabels";
import type { TerminalSummary } from "@pulse/contracts";

export function buildOwnerScopedTerminalLabels(input: {
  terminalIds: ReadonlyArray<string>;
  summaryByTerminalId?: ReadonlyMap<string, Pick<TerminalSummary, "label"> | null | undefined>;
}): Map<string, string> {
  const labels = new Map<string, string>();
  const seen = new Set<string>();
  let nextIndex = 1;

  for (const terminalId of input.terminalIds) {
    const normalizedTerminalId = terminalId.trim();
    if (normalizedTerminalId.length === 0 || seen.has(normalizedTerminalId)) continue;
    seen.add(normalizedTerminalId);

    const summaryLabel = input.summaryByTerminalId?.get(normalizedTerminalId)?.label?.trim();
    if (summaryLabel && summaryLabel.length > 0 && summaryLabel !== normalizedTerminalId) {
      labels.set(normalizedTerminalId, summaryLabel);
      continue;
    }

    labels.set(normalizedTerminalId, `Terminal ${nextIndex}`);
    nextIndex += 1;
  }

  return labels;
}

export function fallbackTerminalLabel(terminalId: string): string {
  return getTerminalLabel(terminalId);
}
