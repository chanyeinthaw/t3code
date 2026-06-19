import {
  EnvironmentId,
  PreviewAutomationClickInput,
  PreviewAutomationEvaluateInput,
  PreviewAutomationNavigateInput,
  PreviewAutomationOpenInput,
  type PreviewAutomationOperation,
  PreviewAutomationPressInput,
  PreviewAutomationScrollInput,
  PreviewAutomationTypeInput,
  PreviewAutomationWaitForInput,
  type ProviderInstanceId,
  type ThreadId,
} from "@pulse/contracts";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as PreviewAutomationBroker from "../../mcp/PreviewAutomationBroker.ts";
import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import {
  compactPreviewAutomationSnapshotForToolResult,
  safePreviewAutomationJsonText,
  type PreviewAutomationSnapshotToolView,
} from "../../mcp/PreviewAutomationSnapshotArtifacts.ts";

const PULSE_CAPABILITY_TOOL_NAME = "pulse_capability";
const PULSE_EXECUTE_TOOL_NAME = "pulse_execute";

export const PULSE_PI_TOOL_NAMES = [PULSE_CAPABILITY_TOOL_NAME, PULSE_EXECUTE_TOOL_NAME] as const;

const PULSE_BROWSER_TOOL_GUIDELINES = [
  "Use pulse_capability to discover Pulse-native capabilities before using external browser automation.",
  "For browser work in Pulse, prefer pulse_execute preview operations: first run preview.status, call preview.open if no automation-capable preview is attached, then use preview.snapshot before preview.click/type/press/scroll/evaluate/waitFor.",
  "Do not switch to standalone Playwright, Chrome, global browser skills, or agent-browser unless pulse_execute reports the Pulse preview is unsupported/unavailable or the user explicitly asks for another browser.",
];

const JsonObjectSchema = {
  type: "object",
  additionalProperties: true,
} as const;

const PulseCapabilityParameters = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description:
        "Search text such as browser, preview, screenshot, click, navigate, or recording.",
    },
    capability: {
      type: "string",
      description: "Optional exact capability id. Currently supported: preview.",
    },
  },
  additionalProperties: false,
} as const;

const PulseExecuteParameters = {
  type: "object",
  properties: {
    operation: {
      type: "string",
      enum: [
        "preview.status",
        "preview.open",
        "preview.navigate",
        "preview.snapshot",
        "preview.click",
        "preview.type",
        "preview.press",
        "preview.scroll",
        "preview.evaluate",
        "preview.waitFor",
        "preview.recordingStart",
        "preview.recordingStop",
      ],
      description:
        "Pulse operation to execute. Use pulse_capability for operation details and expected input.",
    },
    input: {
      ...JsonObjectSchema,
      description: "Operation-specific input. Omit or pass {} for operations that take no input.",
    },
  },
  required: ["operation"],
  additionalProperties: false,
} as const;

type PulseCapabilityParams = {
  readonly query?: string;
  readonly capability?: string;
};

type PulseExecuteParams = {
  readonly operation: string;
  readonly input?: unknown;
};

interface PulseCapabilityOperationDescription {
  readonly operation: string;
  readonly summary: string;
  readonly input: string;
  readonly returns: string;
}

const PREVIEW_OPERATIONS: ReadonlyArray<PulseCapabilityOperationDescription> = [
  {
    operation: "preview.status",
    summary: "Report whether this thread has an automation-capable collaborative browser preview.",
    input: "{}",
    returns: "Availability, visibility, active tab id, URL, title, and loading state.",
  },
  {
    operation: "preview.open",
    summary:
      "Show and initialize the browser preview for this thread, optionally navigating to a URL.",
    input: "{ url?: string, show?: boolean, reuseExistingTab?: boolean }",
    returns: "Updated preview status.",
  },
  {
    operation: "preview.navigate",
    summary: "Navigate the active preview tab and optionally wait for load readiness.",
    input:
      "{ url?: string, target?: {kind:'url',url:string} | {kind:'environment-port',port:number,protocol?:'http'|'https',path?:string}, readiness?: 'load'|'domContentLoaded'|'none', timeoutMs?: number }",
    returns: "Updated preview status.",
  },
  {
    operation: "preview.snapshot",
    summary:
      "Inspect the current page before interacting. Includes visible text, semantic interactive elements, console/network failures, action history, and a screenshot image.",
    input: "{}",
    returns:
      "Truncated structured page snapshot plus screenshot image. The full snapshot is saved to browser-artifacts and the artifact path is included in the result.",
  },
  {
    operation: "preview.click",
    summary:
      "Click one page target. Prefer locator/selector from preview.snapshot over coordinates.",
    input: "{ locator?: string, selector?: string, x?: number, y?: number, timeoutMs?: number }",
    returns: "null on success.",
  },
  {
    operation: "preview.type",
    summary: "Insert literal text into one input. Can clear existing text first.",
    input:
      "{ text: string, locator?: string, selector?: string, clear?: boolean, timeoutMs?: number }",
    returns: "null on success.",
  },
  {
    operation: "preview.press",
    summary: "Press one keyboard key in the active page, targeting current focus.",
    input: "{ key: string, modifiers?: Array<'Alt'|'Control'|'Meta'|'Shift'> }",
    returns: "null on success.",
  },
  {
    operation: "preview.scroll",
    summary: "Scroll the viewport or a target container by CSS pixels.",
    input: "{ deltaX?: number, deltaY?: number, locator?: string, selector?: string }",
    returns: "null on success.",
  },
  {
    operation: "preview.evaluate",
    summary:
      "Evaluate JavaScript in the page main frame. Prefer semantic tools; use this for inspection or interactions those tools cannot express.",
    input: "{ expression: string }",
    returns: "Serializable JavaScript result up to the preview limit.",
  },
  {
    operation: "preview.waitFor",
    summary: "Wait for locator/selector/text/URL conditions to match.",
    input:
      "{ locator?: string, selector?: string, text?: string, urlIncludes?: string, timeoutMs?: number }",
    returns: "null on success.",
  },
  {
    operation: "preview.recordingStart",
    summary: "Start recording the active collaborative browser tab.",
    input: "{}",
    returns: "Recording status.",
  },
  {
    operation: "preview.recordingStop",
    summary: "Stop the active browser recording and save it as a local evidence artifact.",
    input: "{}",
    returns: "Recording artifact path and metadata.",
  },
];

const operationAliases = new Map<string, PreviewAutomationOperation>([
  ["preview.status", "status"],
  ["preview.open", "open"],
  ["preview.navigate", "navigate"],
  ["preview.snapshot", "snapshot"],
  ["preview.click", "click"],
  ["preview.type", "type"],
  ["preview.press", "press"],
  ["preview.scroll", "scroll"],
  ["preview.evaluate", "evaluate"],
  ["preview.waitFor", "waitFor"],
  ["preview.recordingStart", "recordingStart"],
  ["preview.recordingStop", "recordingStop"],
]);

const decodeOpenInput = Schema.decodeUnknownSync(PreviewAutomationOpenInput);
const decodeNavigateInput = Schema.decodeUnknownSync(PreviewAutomationNavigateInput);
const decodeClickInput = Schema.decodeUnknownSync(PreviewAutomationClickInput);
const decodeTypeInput = Schema.decodeUnknownSync(PreviewAutomationTypeInput);
const decodePressInput = Schema.decodeUnknownSync(PreviewAutomationPressInput);
const decodeScrollInput = Schema.decodeUnknownSync(PreviewAutomationScrollInput);
const decodeEvaluateInput = Schema.decodeUnknownSync(PreviewAutomationEvaluateInput);
const decodeWaitForInput = Schema.decodeUnknownSync(PreviewAutomationWaitForInput);

function normalizeOperationInput(operation: PreviewAutomationOperation, input: unknown): unknown {
  const rawInput = input ?? {};
  switch (operation) {
    case "status":
    case "recordingStart":
    case "recordingStop":
      return {};
    case "snapshot":
      return {};
    case "open": {
      const decoded = decodeOpenInput(rawInput);
      return {
        ...decoded,
        show: decoded.show ?? true,
        reuseExistingTab: decoded.reuseExistingTab ?? true,
      };
    }
    case "navigate":
      return decodeNavigateInput(rawInput);
    case "click":
      return decodeClickInput(rawInput);
    case "type":
      return decodeTypeInput(rawInput);
    case "press":
      return decodePressInput(rawInput);
    case "scroll":
      return decodeScrollInput(rawInput);
    case "evaluate":
      return decodeEvaluateInput(rawInput);
    case "waitFor":
      return decodeWaitForInput(rawInput);
  }
}

function operationTimeout(
  operation: PreviewAutomationOperation,
  input: unknown,
): number | undefined {
  if (!input || typeof input !== "object") return undefined;
  if (!["navigate", "click", "type", "waitFor"].includes(operation)) return undefined;
  const timeoutMs = (input as { readonly timeoutMs?: unknown }).timeoutMs;
  return typeof timeoutMs === "number" ? timeoutMs : undefined;
}

function capabilityResult(query: string | undefined, capability: string | undefined): unknown {
  const normalizedQuery = query?.trim().toLowerCase() ?? "";
  const normalizedCapability = capability?.trim().toLowerCase();
  const includePreview =
    !normalizedCapability ||
    normalizedCapability === "preview" ||
    ["browser", "preview", "screenshot", "navigate", "click", "type", "recording"].some((term) =>
      normalizedQuery.includes(term),
    );

  return {
    capabilities: includePreview
      ? [
          {
            id: "preview",
            title: "Pulse collaborative browser",
            summary:
              "Control the user-visible desktop preview browser scoped to this Pulse thread.",
            recommendedWorkflow: [
              "Call pulse_execute with operation='preview.status' first.",
              "If no automation-capable preview is attached, call operation='preview.open'.",
              "Call operation='preview.snapshot' before interacting so you can use semantic locators/selectors instead of coordinates.",
              "Prefer preview.click/type/press/scroll/waitFor over preview.evaluate for normal interactions.",
            ],
            operations: PREVIEW_OPERATIONS,
          },
        ]
      : [],
  };
}

function contentFromResult(
  result: unknown,
  snapshotView?: PreviewAutomationSnapshotToolView,
): AgentToolResult<Record<string, unknown>>["content"] {
  if (result && typeof result === "object") {
    const snapshot = result as {
      readonly screenshot?: {
        readonly data?: unknown;
        readonly mimeType?: unknown;
        readonly width?: unknown;
        readonly height?: unknown;
      };
    };
    if (snapshot.screenshot && typeof snapshot.screenshot.data === "string") {
      const metadata = snapshotView?.value ?? result;
      return [
        {
          type: "text",
          text: `${safePreviewAutomationJsonText(metadata)}\n\nInline snapshot output is truncated to avoid overflowing the model context. The complete snapshot JSON${snapshotView?.artifact ? ` was saved at ${snapshotView.artifact.artifactPath}` : " could not be saved"}. Read fullSnapshotArtifact.artifactPath if you need the full accessibility tree or untruncated snapshot data.`,
        },
        {
          type: "image",
          data: snapshot.screenshot.data,
          mimeType:
            typeof snapshot.screenshot.mimeType === "string"
              ? snapshot.screenshot.mimeType
              : "image/png",
        },
      ];
    }
  }
  return [{ type: "text", text: safePreviewAutomationJsonText(result) }];
}

interface MakePiPulseToolsInput {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerSessionId: string;
  readonly makeSnapshotToolView?:
    | ((snapshot: unknown) => Promise<PreviewAutomationSnapshotToolView>)
    | undefined;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly broker?: PreviewAutomationBroker.PreviewAutomationBrokerShape | undefined;
}

export function makePiPulseTools(input: MakePiPulseToolsInput): ToolDefinition[] {
  const scope: McpInvocationContext.McpInvocationScope = {
    environmentId: input.environmentId,
    threadId: input.threadId,
    providerSessionId: input.providerSessionId,
    providerInstanceId: input.providerInstanceId,
    capabilities: new Set(["preview"]),
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
  };

  const capabilityTool: ToolDefinition = {
    name: PULSE_CAPABILITY_TOOL_NAME,
    label: "Pulse Capability",
    description: "Search Pulse-native capabilities available to this Pi session.",
    promptSnippet: "Search Pulse-native capabilities such as the collaborative browser preview",
    promptGuidelines: PULSE_BROWSER_TOOL_GUIDELINES,
    parameters: PulseCapabilityParameters as never,
    async execute(_toolCallId, params) {
      const typedParams = params as PulseCapabilityParams;
      const result = capabilityResult(typedParams.query, typedParams.capability);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: { result },
      };
    },
  };

  const executeTool: ToolDefinition = {
    name: PULSE_EXECUTE_TOOL_NAME,
    label: "Pulse Execute",
    description: "Execute an allowlisted Pulse-native operation discovered via pulse_capability.",
    promptSnippet: "Execute Pulse-native operations discovered via pulse_capability",
    promptGuidelines: PULSE_BROWSER_TOOL_GUIDELINES,
    parameters: PulseExecuteParameters as never,
    async execute(_toolCallId, params) {
      const typedParams = params as PulseExecuteParams;
      const operation = operationAliases.get(typedParams.operation);
      if (!operation) {
        return {
          content: [
            {
              type: "text",
              text: `Unknown Pulse operation '${typedParams.operation}'. Call pulse_capability to list supported operations.`,
            },
          ],
          details: { operation: typedParams.operation, error: "unknown_operation" },
        };
      }

      const broker = input.broker ?? PreviewAutomationBroker.getActivePreviewAutomationBroker();
      if (!broker) {
        return {
          content: [
            {
              type: "text",
              text: "Pulse preview automation is unavailable because no active browser broker is running.",
            },
          ],
          details: { operation: typedParams.operation, error: "preview_broker_unavailable" },
        };
      }

      const normalizedInput = normalizeOperationInput(operation, typedParams.input);
      const timeoutMs = operationTimeout(operation, normalizedInput);
      const invokeInput = {
        scope,
        operation,
        input: normalizedInput,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      };
      try {
        const result = await Effect.runPromise(
          broker
            .invoke(invokeInput)
            .pipe(Effect.provideService(McpInvocationContext.McpInvocationContext, scope)),
        );
        const snapshotView =
          operation === "snapshot"
            ? input.makeSnapshotToolView
              ? await input.makeSnapshotToolView(result)
              : {
                  artifact: null,
                  truncated: true,
                  value: compactPreviewAutomationSnapshotForToolResult(result, null),
                }
            : undefined;
        return {
          content: contentFromResult(result, snapshotView),
          details: {
            operation: typedParams.operation,
            input: normalizedInput as Record<string, unknown>,
            result: snapshotView?.value ?? result,
          },
        };
      } catch (cause) {
        const baseMessage = cause instanceof Error ? cause.message : String(cause);
        const isOwnerMissing =
          typeof cause === "object" &&
          cause !== null &&
          "_tag" in cause &&
          (cause._tag === "PreviewAutomationNoFocusedOwnerError" ||
            cause._tag === "PreviewAutomationUnsupportedClientError");
        const message = isOwnerMissing
          ? `${baseMessage} Make sure the Pulse desktop preview panel is open for this thread and that you are running the Pulse desktop app (browser-only builds cannot host the preview automation bridge).`
          : baseMessage;
        return {
          content: [
            {
              type: "text",
              text: `Pulse execute failed for '${typedParams.operation}': ${message}`,
            },
          ],
          details: {
            operation: typedParams.operation,
            input: normalizedInput as Record<string, unknown>,
            error: baseMessage,
            cause,
          },
        };
      }
    },
  };

  return [capabilityTool, executeTool];
}
