import type { ThreadId } from "@pulse/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const MAX_VISIBLE_TEXT_CHARS = 12_000;
const MAX_GENERIC_JSON_CHARS = 60_000;
const MAX_INTERACTIVE_ELEMENTS = 80;
const MAX_CONSOLE_ENTRIES = 40;
const MAX_NETWORK_ENTRIES = 40;
const MAX_ACTION_TIMELINE_EVENTS = 40;

function truncateString(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n… truncated ${value.length - maxChars} chars …`;
}

function takeLimitedArray<T>(values: ReadonlyArray<T>, maxItems: number): ReadonlyArray<T> {
  return values.length <= maxItems ? values : values.slice(0, maxItems);
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 120);
}

function stripScreenshotData(result: unknown): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const record = result as Record<string, unknown>;
  const screenshot = record.screenshot;
  if (!screenshot || typeof screenshot !== "object" || Array.isArray(screenshot)) return result;
  const { data: _data, ...screenshotMetadata } = screenshot as Record<string, unknown>;
  return { ...record, screenshot: screenshotMetadata };
}

export interface PreviewAutomationSnapshotArtifactMetadata {
  readonly artifactPath: string;
  readonly artifactBytes: number;
  readonly relativePath: string;
}

export interface PreviewAutomationSnapshotToolView {
  readonly value: unknown;
  readonly artifact: PreviewAutomationSnapshotArtifactMetadata | null;
  readonly truncated: boolean;
}

export function compactPreviewAutomationSnapshotForToolResult(
  result: unknown,
  artifact: PreviewAutomationSnapshotArtifactMetadata | null,
): unknown {
  const withoutScreenshotData = stripScreenshotData(result);
  if (
    !withoutScreenshotData ||
    typeof withoutScreenshotData !== "object" ||
    Array.isArray(withoutScreenshotData)
  ) {
    return withoutScreenshotData;
  }

  const record = withoutScreenshotData as Record<string, unknown>;
  if (!("interactiveElements" in record) && !("accessibilityTree" in record)) {
    return withoutScreenshotData;
  }

  const accessibilityTreeJson = JSON.stringify(record.accessibilityTree ?? null);
  return {
    ...record,
    ...(typeof record.visibleText === "string"
      ? { visibleText: truncateString(record.visibleText, MAX_VISIBLE_TEXT_CHARS) }
      : {}),
    ...(Array.isArray(record.interactiveElements)
      ? {
          interactiveElements: takeLimitedArray(
            record.interactiveElements,
            MAX_INTERACTIVE_ELEMENTS,
          ),
          interactiveElementsOmitted: Math.max(
            0,
            record.interactiveElements.length - MAX_INTERACTIVE_ELEMENTS,
          ),
        }
      : {}),
    ...(Array.isArray(record.consoleEntries)
      ? {
          consoleEntries: takeLimitedArray(record.consoleEntries, MAX_CONSOLE_ENTRIES),
          consoleEntriesOmitted: Math.max(0, record.consoleEntries.length - MAX_CONSOLE_ENTRIES),
        }
      : {}),
    ...(Array.isArray(record.networkEntries)
      ? {
          networkEntries: takeLimitedArray(record.networkEntries, MAX_NETWORK_ENTRIES),
          networkEntriesOmitted: Math.max(0, record.networkEntries.length - MAX_NETWORK_ENTRIES),
        }
      : {}),
    ...(Array.isArray(record.actionTimeline)
      ? {
          actionTimeline: takeLimitedArray(record.actionTimeline, MAX_ACTION_TIMELINE_EVENTS),
          actionTimelineOmitted: Math.max(
            0,
            record.actionTimeline.length - MAX_ACTION_TIMELINE_EVENTS,
          ),
        }
      : {}),
    accessibilityTree: {
      truncated: true,
      message:
        "Full accessibilityTree omitted from the inline tool result. Read fullSnapshotArtifact.artifactPath for complete data.",
      originalJsonBytes: accessibilityTreeJson.length,
    },
    fullSnapshotArtifact: artifact,
  };
}

export function safePreviewAutomationJsonText(value: unknown): string {
  const text = JSON.stringify(value ?? null, null, 2);
  return truncateString(text, MAX_GENERIC_JSON_CHARS);
}

export const writePreviewAutomationSnapshotArtifact = Effect.fn(function* (input: {
  readonly stateDir: string;
  readonly threadId: ThreadId;
  readonly snapshot: unknown;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const createdAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const fileSafeTimestamp = sanitizePathSegment(createdAt);
  const threadSegment = sanitizePathSegment(input.threadId);
  const artifactDir = path.join(input.stateDir, "browser-artifacts", threadSegment);
  const relativePath = path.join(
    "browser-artifacts",
    threadSegment,
    `${fileSafeTimestamp}-preview-snapshot.json`,
  );
  const artifactPath = path.join(input.stateDir, relativePath);
  // @effect-diagnostics-next-line preferSchemaOverJson:off
  const serialized = JSON.stringify(
    {
      kind: "preview.snapshot",
      createdAt,
      threadId: input.threadId,
      snapshot: input.snapshot,
    },
    null,
    2,
  );

  yield* fileSystem.makeDirectory(artifactDir, { recursive: true });
  yield* fileSystem.writeFileString(artifactPath, `${serialized}\n`);

  return {
    artifactPath,
    artifactBytes: Buffer.byteLength(serialized),
    relativePath,
  } satisfies PreviewAutomationSnapshotArtifactMetadata;
});

export const makePreviewAutomationSnapshotToolView = Effect.fn(function* (input: {
  readonly stateDir: string;
  readonly threadId: ThreadId;
  readonly snapshot: unknown;
}) {
  const artifact = yield* writePreviewAutomationSnapshotArtifact(input).pipe(
    Effect.orElseSucceed(() => null),
  );
  return {
    artifact,
    truncated: true,
    value: compactPreviewAutomationSnapshotForToolResult(input.snapshot, artifact),
  } satisfies PreviewAutomationSnapshotToolView;
});
