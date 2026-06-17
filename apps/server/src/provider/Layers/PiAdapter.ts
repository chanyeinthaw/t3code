import {
  EnvironmentId,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderItemId,
  type ProviderListCommandsResult,
  type ProviderListModelsResult,
  type ProviderListSkillsResult,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  RuntimeItemId,
  ThreadId,
  type ThreadTokenUsageSnapshot,
  TurnId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type {
  AgentSession,
  AgentSessionEvent,
  ModelRegistry,
  Skill as PiSkill,
} from "@earendil-works/pi-coding-agent";
import {
  AuthStorage,
  createAgentSession,
  createAgentSessionServices,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { makePreviewAutomationSnapshotToolView } from "../../mcp/PreviewAutomationSnapshotArtifacts.ts";
import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import type { PiAdapterShape } from "../Services/PiAdapter.ts";
import type { PiSettings } from "@t3tools/contracts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { PI_SLASH_COMMANDS, piSkillToServerProviderSkill } from "./PiProvider.ts";
import { makePiT3Tools, T3_PI_TOOL_NAMES } from "./PiT3Tools.ts";

const PROVIDER = ProviderDriverKind.make("pi");
const DEFAULT_PI_THINKING_LEVEL = "medium";
const PI_THINKING_OPTIONS = [
  { value: "off", label: "Off", description: "No extra reasoning" },
  { value: "minimal", label: "Minimal", description: "Light reasoning" },
  { value: "low", label: "Low", description: "Faster reasoning" },
  { value: "medium", label: "Medium", description: "Balanced reasoning" },
  { value: "high", label: "High", description: "Deeper reasoning" },
  { value: "xhigh", label: "Extra High", description: "Maximum reasoning" },
] as const;

type PiModel = NonNullable<ReturnType<ModelRegistry["find"]>>;

interface PiResumeCursor {
  readonly sessionFile: string;
  readonly sessionId?: string;
}

function extractResumeSessionFile(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["sessionFile", "sessionFilePath", "nativeHandle", "path"]) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate;
    }
  }
  return undefined;
}

function buildPiResumeCursor(sessionManager: SessionManager): PiResumeCursor | undefined {
  const sessionFile = sessionManager.getSessionFile();
  if (!sessionFile) return undefined;
  return {
    sessionFile,
    sessionId: sessionManager.getSessionId(),
  };
}

interface PiTurnSnapshot {
  readonly id: TurnId;
  readonly items: Array<unknown>;
  leafId?: string | null;
}

interface PiQueuedDuringCompactionInput {
  readonly mode: "steer" | "followUp";
  readonly text: string;
  readonly images: Array<{
    readonly type: "image";
    readonly data: string;
    readonly mimeType: string;
  }>;
  readonly createdAt: string;
}

type PiTurnFailure = { readonly state: "failed" | "interrupted"; readonly message: string };

interface PiSessionContext {
  session: ProviderSession;
  readonly piSession: AgentSession;
  readonly sessionScope: Scope.Closeable;
  readonly unsubscribe: () => void;
  readonly turns: Array<PiTurnSnapshot>;
  readonly stopped: Ref.Ref<boolean>;
  readonly deferredUserMessageTexts: Array<string>;
  readonly queuedDuringCompaction: Array<PiQueuedDuringCompactionInput>;
  readonly activeToolsByCallId: Map<
    string,
    {
      readonly turnId: TurnId | undefined;
      readonly toolName: string;
      readonly args: unknown;
      readonly itemType: "command_execution" | "file_change" | "dynamic_tool_call" | "web_search";
    }
  >;
  activeTurnId: TurnId | undefined;
  activeCompactionTurnId: TurnId | undefined;
  activePromptFiber: Fiber.Fiber<void, never> | undefined;
  activeAssistantItemId: string | undefined;
  activeReasoningItemId: string | undefined;
  activeTurnFailure: PiTurnFailure | undefined;
  nextAssistantMessageIndex: number;
}

interface PiAdapterOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  readonly authStorage?: AuthStorage;
  readonly modelRegistry: ModelRegistry;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly environmentId: EnvironmentId;
}

export type PiAdapterEnv = Crypto.Crypto | FileSystem.FileSystem | Path.Path | ServerConfig;

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function withTemporaryProcessEnvironment<T>(
  environment: NodeJS.ProcessEnv | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (!environment) return fn();

  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(environment)) {
    if (process.env[key] === value) continue;
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function parsePiModelSlug(slug: string | undefined): { provider: string; modelId: string } | null {
  if (!slug) return null;
  const separator = slug.indexOf("/");
  if (separator <= 0 || separator === slug.length - 1) return null;
  return {
    provider: slug.slice(0, separator),
    modelId: slug.slice(separator + 1),
  };
}

function resolvePiModel(
  modelRegistry: ModelRegistry,
  slug: string | undefined,
): PiModel | undefined {
  const parsed = parsePiModelSlug(slug);
  if (!parsed) return modelRegistry.getAvailable()[0] as PiModel | undefined;
  return modelRegistry.find(parsed.provider, parsed.modelId);
}

function resolveThinkingLevel(
  input: ProviderSendTurnInput,
): AgentSession["thinkingLevel"] | undefined {
  const value = input.modelSelection?.options?.find(
    (option) => option.id === "thinkingLevel",
  )?.value;
  return typeof value === "string" ? (value as AgentSession["thinkingLevel"]) : undefined;
}

function trimToUndefined(value: string | null | undefined): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : undefined;
}

function getPiSupportedThinkingOptions(model: {
  readonly reasoning?: boolean;
  readonly thinkingLevelMap?: Partial<Record<string, string | null>>;
}) {
  if (!model.reasoning) return [];
  return PI_THINKING_OPTIONS.filter((option) => {
    const mapped = model.thinkingLevelMap?.[option.value];
    if (mapped === null) return false;
    if (option.value === "xhigh") return mapped !== undefined;
    return true;
  });
}

function getPiMessageRole(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const role = (message as { readonly role?: unknown }).role;
  return typeof role === "string" ? role : undefined;
}

function getPiMessageText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const content = (message as { readonly content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const record = entry as { readonly type?: unknown; readonly text?: unknown };
      return record.type === "text" && typeof record.text === "string" ? [record.text] : [];
    })
    .join("\n");
  return text.length > 0 ? text : undefined;
}

function getPiUserMessageText(message: unknown): string | undefined {
  return getPiMessageText(message);
}

function getPiAssistantStopReason(message: unknown): string | undefined {
  if (getPiMessageRole(message) !== "assistant" || !message || typeof message !== "object") {
    return undefined;
  }
  const stopReason = (message as { readonly stopReason?: unknown }).stopReason;
  return typeof stopReason === "string" ? stopReason : undefined;
}

function getPiAssistantErrorMessage(message: unknown): string | undefined {
  if (getPiMessageRole(message) !== "assistant" || !message || typeof message !== "object") {
    return undefined;
  }
  const errorMessage = (message as { readonly errorMessage?: unknown }).errorMessage;
  if (typeof errorMessage !== "string") return undefined;
  const trimmed = errorMessage.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function findLastPiAssistantTerminalError(
  messages: ReadonlyArray<unknown>,
): { readonly state: "failed" | "interrupted"; readonly message: string } | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (getPiMessageRole(message) !== "assistant") continue;
    const stopReason = getPiAssistantStopReason(message);
    if (stopReason !== "error" && stopReason !== "aborted") return undefined;
    return {
      state: stopReason === "aborted" ? "interrupted" : "failed",
      message:
        getPiAssistantErrorMessage(message) ??
        (stopReason === "aborted" ? "Pi request was aborted." : "Pi provider returned an error."),
    };
  }
  return undefined;
}

function ensureAssistantItemId(context: PiSessionContext, turnId: TurnId | undefined): string {
  if (context.activeAssistantItemId) return context.activeAssistantItemId;
  const itemId = `pi-assistant-${turnId ?? "session"}-${context.nextAssistantMessageIndex}`;
  context.nextAssistantMessageIndex += 1;
  context.activeAssistantItemId = itemId;
  return itemId;
}

function ensureReasoningItemId(context: PiSessionContext, turnId: TurnId | undefined): string {
  if (context.activeReasoningItemId) return context.activeReasoningItemId;
  const itemId = `pi-reasoning-${turnId ?? "session"}`;
  context.activeReasoningItemId = itemId;
  return itemId;
}

function takeDeferredUserMessageText(context: PiSessionContext, text: string): boolean {
  const exactIndex = context.deferredUserMessageTexts.indexOf(text);
  if (exactIndex !== -1) {
    context.deferredUserMessageTexts.splice(exactIndex, 1);
    return true;
  }
  if (context.deferredUserMessageTexts.length > 0) {
    context.deferredUserMessageTexts.shift();
    return true;
  }
  return false;
}

function queuedDuringCompactionTexts(
  context: PiSessionContext,
  mode: "steer" | "followUp",
): Array<string> {
  return context.queuedDuringCompaction
    .filter((message) => message.mode === mode)
    .map((message) => message.text);
}

function enqueueDuringCompaction(
  context: PiSessionContext,
  input: PiQueuedDuringCompactionInput,
): void {
  context.queuedDuringCompaction.push(input);
}

function drainQueuedDuringCompaction(
  context: PiSessionContext,
): Array<PiQueuedDuringCompactionInput> {
  const queued = context.queuedDuringCompaction.splice(0);
  return queued;
}

function ensureTurnSnapshot(context: PiSessionContext, turnId: TurnId | undefined): void {
  if (!turnId) return;
  if (context.turns.some((turn) => turn.id === turnId)) return;
  context.turns.push({ id: turnId, items: [] });
}

function appendTurnItem(
  context: PiSessionContext,
  turnId: TurnId | undefined,
  item: unknown,
): void {
  if (!turnId) return;
  const existing = context.turns.find((turn) => turn.id === turnId);
  if (existing) {
    existing.items.push(item);
    return;
  }
  context.turns.push({ id: turnId, items: [item] });
}

function recordTurnLeaf(context: PiSessionContext, turnId: TurnId | undefined): void {
  if (!turnId) return;
  const turn = context.turns.find((candidate) => candidate.id === turnId);
  if (!turn) return;
  turn.leafId = context.piSession.sessionManager.getLeafId();
}

function mapPiMessageHistory(session: AgentSession): Array<unknown> {
  const items: Array<unknown> = [];
  const pendingTools = new Map<string, { toolName: string; args: unknown }>();
  for (const message of session.messages) {
    const role = getPiMessageRole(message);
    if (role === "user") {
      const text = getPiMessageText(message);
      if (text) items.push({ type: "user_message", text });
      continue;
    }
    if (role === "assistant") {
      const content = recordFromUnknown(message)?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        const record = recordFromUnknown(block);
        if (record?.type === "text" && typeof record.text === "string" && record.text.length > 0) {
          items.push({ type: "assistant_message", text: record.text });
        } else if (
          record?.type === "thinking" &&
          typeof record.thinking === "string" &&
          record.thinking.length > 0
        ) {
          items.push({ type: "reasoning", text: record.thinking });
        } else if (
          record?.type === "toolCall" &&
          typeof record.id === "string" &&
          typeof record.name === "string"
        ) {
          pendingTools.set(record.id, { toolName: record.name, args: record.arguments });
          items.push({
            type: "tool_call",
            status: "started",
            callId: record.id,
            toolName: record.name,
            itemType: toToolItemType(record.name),
            title: buildPiToolTitle(record.name, record.arguments),
            args: record.arguments,
            data: buildPiToolData({
              toolCallId: record.id,
              toolName: record.name,
              args: record.arguments,
            }),
          });
        }
      }
      continue;
    }
    if (role === "toolResult") {
      const record = recordFromUnknown(message);
      const toolCallId = typeof record?.toolCallId === "string" ? record.toolCallId : undefined;
      if (!toolCallId) continue;
      const pending = pendingTools.get(toolCallId);
      pendingTools.delete(toolCallId);
      const toolName =
        pending?.toolName ?? (typeof record?.toolName === "string" ? record.toolName : "tool");
      const result = { content: record?.content };
      const isError = record?.isError === true;
      items.push({
        type: "tool_call",
        status: isError ? "failed" : "completed",
        callId: toolCallId,
        toolName,
        itemType: toToolItemType(toolName),
        title: buildPiToolTitle(toolName, pending?.args),
        output: readPiToolTextOutput(result),
        isError,
        data: buildPiToolData({
          toolCallId,
          toolName,
          args: pending?.args,
          result,
          isError,
        }),
      });
    }
  }
  return items;
}

function ensureSessionContext(
  sessions: ReadonlyMap<ThreadId, PiSessionContext>,
  threadId: ThreadId,
): PiSessionContext {
  const session = sessions.get(threadId);
  if (!session) {
    throw new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
  }
  return session;
}

function recordFromUnknown(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstStringValue(
  record: Record<string, unknown> | undefined,
  keys: ReadonlyArray<string>,
): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

function toToolItemType(
  toolName: string,
): "command_execution" | "file_change" | "dynamic_tool_call" | "web_search" {
  const normalized = toolName.toLowerCase();
  if (normalized === "bash" || normalized.includes("bash") || normalized.includes("command")) {
    return "command_execution";
  }
  if (
    normalized === "edit" ||
    normalized === "write" ||
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("patch")
  ) {
    return "file_change";
  }
  if (normalized === "grep" || normalized === "find" || normalized.includes("search")) {
    return "web_search";
  }
  return "dynamic_tool_call";
}

function readPiToolCommand(toolName: string, args: unknown): string | undefined {
  const normalized = toolName.toLowerCase();
  if (!normalized.includes("bash") && !normalized.includes("command")) return undefined;
  return firstStringValue(recordFromUnknown(args), ["command", "cmd"]);
}

function readPiToolPath(args: unknown): string | undefined {
  return firstStringValue(recordFromUnknown(args), ["path", "filePath", "file", "relativePath"]);
}

function readPiToolSearchQuery(toolName: string, args: unknown): string | undefined {
  const record = recordFromUnknown(args);
  if (!record) return undefined;
  if (toolName === "grep" || toolName === "find")
    return firstStringValue(record, ["pattern", "query"]);
  return firstStringValue(record, ["query", "pattern"]);
}

function readPiToolEditEntries(args: unknown): ReadonlyArray<Record<string, unknown>> | undefined {
  const record = recordFromUnknown(args);
  if (!record) return undefined;
  if (Array.isArray(record.edits)) {
    const edits = record.edits.flatMap((entry) => {
      const edit = recordFromUnknown(entry);
      return edit ? [edit] : [];
    });
    return edits.length > 0 ? edits : undefined;
  }
  const oldText = firstStringValue(record, ["oldText", "old_string", "oldString"]);
  const newText = firstStringValue(record, ["newText", "new_string", "newString"]);
  if (oldText !== undefined || newText !== undefined) {
    return [
      {
        ...(oldText !== undefined ? { oldText } : {}),
        ...(newText !== undefined ? { newText } : {}),
      },
    ];
  }
  return undefined;
}

function readPiToolTextOutput(result: unknown): string | undefined {
  if (typeof result === "string") {
    const trimmed = result.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  const record = recordFromUnknown(result);
  const direct = firstStringValue(record, [
    "output",
    "stdout",
    "stderr",
    "text",
    "summary",
    "message",
    "error",
  ]);
  if (direct) return direct;
  const content = Array.isArray(record?.content) ? record.content : [];
  const text = content
    .flatMap((entry) => {
      const block = recordFromUnknown(entry);
      return block?.type === "text" && typeof block.text === "string" ? [block.text] : [];
    })
    .join("\n")
    .trim();
  return text.length > 0 ? text : undefined;
}

function readPiToolExitCode(result: unknown): number | null | undefined {
  const record = recordFromUnknown(result);
  if (!record) return undefined;
  for (const key of ["exitCode", "code"]) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function buildPiToolRawOutput(result: unknown): Record<string, unknown> | undefined {
  if (result === undefined) return undefined;
  const text = readPiToolTextOutput(result);
  const exitCode = readPiToolExitCode(result);
  if (typeof result === "string") return { stdout: result, content: result };
  if (result === null) return {};
  const record = recordFromUnknown(result);
  if (!record) return text ? { stdout: text, content: text } : undefined;
  return {
    ...record,
    ...(text ? { stdout: text, content: text } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
  };
}

function buildPiToolTitle(toolName: string, args: unknown): string {
  const command = readPiToolCommand(toolName, args);
  if (command) return command;
  const path = readPiToolPath(args);
  if (path && ["read", "edit", "write", "ls"].includes(toolName)) return `${toolName} ${path}`;
  const query = readPiToolSearchQuery(toolName, args);
  if (query && ["find", "grep"].includes(toolName)) return `${toolName} ${query}`;
  return toolName;
}

function buildPiToolData(input: {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: unknown;
  readonly partialResult?: unknown;
  readonly result?: unknown;
  readonly isError?: boolean;
}): Record<string, unknown> {
  const rawOutput = buildPiToolRawOutput(input.result ?? input.partialResult);
  const command = readPiToolCommand(input.toolName, input.args);
  const path = readPiToolPath(input.args);
  const query = readPiToolSearchQuery(input.toolName, input.args);
  const edits = readPiToolEditEntries(input.args);
  const content = recordFromUnknown(input.args)?.content;
  const diff = firstStringValue(recordFromUnknown(recordFromUnknown(rawOutput)?.details), ["diff"]);
  const base: Record<string, unknown> = {
    toolCallId: input.toolCallId,
    callId: input.toolCallId,
    toolName: input.toolName,
    name: input.toolName,
    tool: input.toolName,
    kind: input.toolName,
    args: input.args,
    input: input.args,
    rawInput: input.args,
    ...(rawOutput ? { rawOutput } : {}),
    ...(input.partialResult !== undefined ? { partialResult: input.partialResult } : {}),
    ...(input.result !== undefined ? { result: input.result } : {}),
    ...(input.isError !== undefined ? { isError: input.isError } : {}),
  };

  switch (input.toolName) {
    case "bash":
      return {
        ...base,
        kind: "execute",
        ...(command ? { command } : {}),
        ...(rawOutput?.exitCode !== undefined ? { exitCode: rawOutput.exitCode } : {}),
      };
    case "read":
      return {
        ...base,
        kind: "read",
        ...(path
          ? {
              path,
              filePath: path,
              files: [{ path }],
              commandActions: [{ type: "read", name: "read", path }],
            }
          : {}),
      };
    case "edit":
      return {
        ...base,
        kind: "edit",
        ...(path ? { path, filePath: path, files: [{ path }], changes: [{ path }] } : {}),
        ...(edits ? { edits: edits.map((edit) => ({ ...edit, ...(path ? { path } : {}) })) } : {}),
        ...(diff ? { unifiedDiff: diff } : {}),
      };
    case "write":
      return {
        ...base,
        kind: "write",
        ...(path ? { path, filePath: path, files: [{ path }], changes: [{ path }] } : {}),
        ...(typeof content === "string" ? { content } : {}),
      };
    case "find":
    case "grep":
      return {
        ...base,
        kind: "search",
        searchKind: input.toolName,
        ...(query ? { query } : {}),
        ...(path ? { path } : {}),
        ...(query || path
          ? { commandActions: [{ type: "search", name: input.toolName, query, path }] }
          : {}),
      };
    case "ls":
      return {
        ...base,
        kind: "listFiles",
        ...(path
          ? { path, query: path, commandActions: [{ type: "listFiles", name: "ls", path }] }
          : {}),
      };
    default:
      return base;
  }
}

function piCompactionDetail(
  event: Extract<AgentSessionEvent, { type: "compaction_end" }>,
): string | undefined {
  if (event.errorMessage && event.errorMessage.trim().length > 0) {
    return event.errorMessage.trim();
  }
  if (event.aborted) {
    return "Context compaction aborted.";
  }
  if (!event.result) {
    return undefined;
  }
  return "Context compaction completed.";
}

function classifyPiRuntimeError(
  message: string,
): "provider_error" | "transport_error" | "permission_error" | "validation_error" | "unknown" {
  const normalized = message.toLowerCase();
  if (
    normalized.includes("network") ||
    normalized.includes("connection") ||
    normalized.includes("timeout") ||
    normalized.includes("econn") ||
    normalized.includes("fetch failed")
  ) {
    return "transport_error";
  }
  if (
    normalized.includes("api key") ||
    normalized.includes("auth") ||
    normalized.includes("unauthorized") ||
    normalized.includes("forbidden") ||
    normalized.includes("permission")
  ) {
    return "permission_error";
  }
  if (
    normalized.includes("invalid") ||
    normalized.includes("validation") ||
    normalized.includes("not available")
  ) {
    return "validation_error";
  }
  if (
    normalized.includes("rate limit") ||
    normalized.includes("quota") ||
    normalized.includes("usage limit") ||
    normalized.includes("overloaded") ||
    normalized.includes("provider")
  ) {
    return "provider_error";
  }
  return "unknown";
}

function normalizePiTokenUsage(
  stats: ReturnType<AgentSession["getSessionStats"]>,
  fallbackContextWindow?: number | null,
): ThreadTokenUsageSnapshot | undefined {
  const inputTokens = Math.max(0, Math.round(stats.tokens.input));
  const cachedInputTokens = Math.max(0, Math.round(stats.tokens.cacheRead));
  const outputTokens = Math.max(0, Math.round(stats.tokens.output));
  const totalProcessedTokens = Math.max(0, Math.round(stats.tokens.total));
  const contextWindow =
    typeof stats.contextUsage?.contextWindow === "number" && stats.contextUsage.contextWindow > 0
      ? Math.round(stats.contextUsage.contextWindow)
      : typeof fallbackContextWindow === "number" && fallbackContextWindow > 0
        ? Math.round(fallbackContextWindow)
        : undefined;
  const contextUsageTokens =
    typeof stats.contextUsage?.tokens === "number" && stats.contextUsage.tokens >= 0
      ? Math.round(stats.contextUsage.tokens)
      : undefined;
  const usedTokens =
    contextUsageTokens ??
    (contextWindow ? Math.min(totalProcessedTokens, contextWindow) : totalProcessedTokens);
  if (usedTokens <= 0 && totalProcessedTokens <= 0 && contextWindow === undefined) return undefined;
  return {
    usedTokens,
    ...(totalProcessedTokens > usedTokens ? { totalProcessedTokens } : {}),
    ...(contextWindow !== undefined ? { maxTokens: contextWindow } : {}),
    inputTokens,
    cachedInputTokens,
    outputTokens,
    lastUsedTokens: usedTokens,
    lastInputTokens: inputTokens,
    lastCachedInputTokens: cachedInputTokens,
    lastOutputTokens: outputTokens,
    toolUses: stats.toolCalls,
    compactsAutomatically: true,
  };
}

export const makePiAdapter = Effect.fn("makePiAdapter")(function* (
  piSettings: PiSettings,
  options: PiAdapterOptions,
) {
  const boundInstanceId = options.instanceId ?? ProviderInstanceId.make("pi");
  const nativeEventLogger = options.nativeEventLogger;
  const serverConfig = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const effectContext = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(effectContext);
  const runPromise = Effect.runPromiseWith(effectContext);
  const randomUUIDv4 = crypto.randomUUIDv4.pipe(
    Effect.mapError(
      (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "crypto/randomUUIDv4",
          detail: "Failed to generate Pi runtime identifier.",
          cause,
        }),
    ),
  );
  const sessions = new Map<ThreadId, PiSessionContext>();

  const buildEventBase = Effect.fn("buildPiEventBase")(function* (input: {
    readonly threadId: ThreadId;
    readonly turnId?: TurnId | undefined;
    readonly itemId?: string | undefined;
    readonly raw?: unknown;
    readonly createdAt?: string | undefined;
  }) {
    return {
      eventId: EventId.make(`pi-event-${yield* randomUUIDv4}`),
      provider: PROVIDER,
      providerInstanceId: boundInstanceId,
      threadId: input.threadId,
      createdAt: input.createdAt ?? (yield* nowIso),
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(input.itemId ? { itemId: RuntimeItemId.make(input.itemId) } : {}),
      ...(input.raw ? { raw: { source: "pi.sdk.event" as const, payload: input.raw } } : {}),
    };
  });

  const emit = (event: ProviderRuntimeEvent) => Queue.offer(runtimeEvents, event);

  const writeNativeEvent = Effect.fn("writePiNativeEvent")(function* (
    threadId: ThreadId,
    event: AgentSessionEvent,
  ) {
    if (!nativeEventLogger) return;
    yield* nativeEventLogger.write(event, threadId);
  });

  const updateProviderSession = Effect.fn("updatePiProviderSession")(function* (
    context: PiSessionContext,
    patch: Partial<ProviderSession>,
    options?: { readonly clearActiveTurnId?: boolean; readonly clearLastError?: boolean },
  ) {
    const updatedAt = yield* nowIso;
    context.session = {
      ...context.session,
      ...patch,
      updatedAt,
      ...(options?.clearActiveTurnId ? { activeTurnId: undefined } : {}),
      ...(options?.clearLastError ? { lastError: undefined } : {}),
    };
  });

  const emitContextWindowUsage = Effect.fn("emitPiContextWindowUsage")(function* (
    context: PiSessionContext,
    turnId: TurnId,
  ) {
    const usage = normalizePiTokenUsage(
      context.piSession.getSessionStats(),
      context.piSession.model?.contextWindow,
    );
    if (!usage) return;

    yield* emit({
      ...(yield* buildEventBase({ threadId: context.session.threadId, turnId })),
      type: "thread.token-usage.updated",
      payload: { usage },
    });
  });

  const emitQueuedDuringCompactionUpdate = Effect.fn("emitQueuedDuringCompactionUpdate")(function* (
    context: PiSessionContext,
    turnId: TurnId | undefined,
  ) {
    yield* emit({
      ...(yield* buildEventBase({ threadId: context.session.threadId, turnId })),
      type: "input.queue.updated",
      payload: {
        steering: queuedDuringCompactionTexts(context, "steer"),
        followUp: queuedDuringCompactionTexts(context, "followUp"),
      },
    });
  });

  const runQueuedAfterCompaction = Effect.fn("runQueuedAfterCompaction")(function* (
    context: PiSessionContext,
    modelSlug: string,
  ) {
    const queued = drainQueuedDuringCompaction(context);
    if (queued.length === 0) return;

    const queuedTurnId = TurnId.make(`pi-turn-${yield* randomUUIDv4}`);
    ensureTurnSnapshot(context, queuedTurnId);
    context.activeTurnId = queuedTurnId;
    context.activeAssistantItemId = undefined;
    context.activeReasoningItemId = undefined;
    context.activeTurnFailure = undefined;
    context.nextAssistantMessageIndex = 0;
    yield* updateProviderSession(
      context,
      { status: "running", activeTurnId: queuedTurnId, model: modelSlug },
      { clearLastError: true },
    );
    yield* emit({
      ...(yield* buildEventBase({ threadId: context.session.threadId, turnId: queuedTurnId })),
      type: "turn.started",
      payload: { model: modelSlug },
    });

    const continueExit = yield* Effect.tryPromise({
      try: async () => {
        const agentMessages = queued.map((message) => ({
          role: "user" as const,
          content: [{ type: "text" as const, text: message.text }, ...message.images],
          timestamp: Date.parse(message.createdAt),
        }));
        const lastMessage = context.piSession.agent.state.messages.at(-1);
        if (lastMessage?.role === "assistant") {
          for (let index = 0; index < queued.length; index += 1) {
            const message = queued[index]!;
            const agentMessage = agentMessages[index]!;
            context.deferredUserMessageTexts.push(message.text);
            if (message.mode === "followUp") {
              context.piSession.agent.followUp(agentMessage);
            } else {
              context.piSession.agent.steer(agentMessage);
            }
          }
          while (context.piSession.agent.hasQueuedMessages()) {
            await context.piSession.agent.continue();
          }
          return;
        }

        for (const message of queued) {
          context.deferredUserMessageTexts.push(message.text);
        }
        await context.piSession.agent.prompt(agentMessages);
        while (context.piSession.agent.hasQueuedMessages()) {
          await context.piSession.agent.continue();
        }
      },
      catch: (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "compact/continueQueuedInput",
          detail: errorDetail(cause),
          cause,
        }),
    }).pipe(Effect.exit);

    yield* emitQueuedDuringCompactionUpdate(context, queuedTurnId);
    const stopped = yield* Ref.get(context.stopped);
    if (stopped || context.activeTurnId !== queuedTurnId) return;
    const turnFailure = context.activeTurnFailure as PiTurnFailure | undefined;
    context.activeTurnId = undefined;
    context.activePromptFiber = undefined;
    context.activeAssistantItemId = undefined;
    context.activeReasoningItemId = undefined;
    context.activeTurnFailure = undefined;
    if (Exit.isSuccess(continueExit)) {
      yield* updateProviderSession(
        context,
        turnFailure
          ? {
              status: turnFailure.state === "interrupted" ? "ready" : "error",
              lastError: turnFailure.message,
            }
          : { status: "ready" },
        { clearActiveTurnId: true },
      );
      yield* emitContextWindowUsage(context, queuedTurnId).pipe(Effect.ignore);
      yield* emit({
        ...(yield* buildEventBase({ threadId: context.session.threadId, turnId: queuedTurnId })),
        type: "turn.completed",
        payload: turnFailure
          ? { state: turnFailure.state, errorMessage: turnFailure.message }
          : { state: "completed" },
      });
    } else {
      const detail = Cause.pretty(continueExit.cause);
      yield* updateProviderSession(
        context,
        { status: "error", lastError: detail },
        { clearActiveTurnId: true },
      );
      yield* emit({
        ...(yield* buildEventBase({ threadId: context.session.threadId, turnId: queuedTurnId })),
        type: "turn.completed",
        payload: { state: "failed", errorMessage: detail },
      });
      yield* emit({
        ...(yield* buildEventBase({ threadId: context.session.threadId, turnId: queuedTurnId })),
        type: "runtime.error",
        payload: {
          message: detail,
          class: classifyPiRuntimeError(detail),
          detail: continueExit.cause,
        },
      });
    }
  });

  const handleSessionEvent = (
    context: PiSessionContext,
    event: AgentSessionEvent,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const turnId = context.activeTurnId;
      switch (event.type) {
        case "queue_update": {
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              raw: event,
            })),
            type: "input.queue.updated",
            payload: {
              steering: [...event.steering],
              followUp: [...event.followUp],
            },
          });
          break;
        }
        case "message_start": {
          const role = getPiMessageRole(event.message);
          if (role === "assistant") {
            const itemId = ensureAssistantItemId(context, turnId);
            yield* emit({
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId,
                itemId,
                raw: event,
              })),
              type: "item.started",
              payload: {
                itemType: "assistant_message",
                status: "inProgress",
                title: "Assistant message",
              },
            });
            return;
          }

          const text = getPiUserMessageText(event.message);
          if (role === "user" && text !== undefined) {
            const isDeferredMidTurnMessage = takeDeferredUserMessageText(context, text);
            if (isDeferredMidTurnMessage) {
              yield* emit({
                ...(yield* buildEventBase({
                  threadId: context.session.threadId,
                  turnId,
                  raw: event,
                })),
                type: "user-message.observed",
                payload: { text },
              });
            }
          }
          break;
        }
        case "message_update": {
          const assistantEvent = event.assistantMessageEvent;
          if (assistantEvent.type === "text_delta" || assistantEvent.type === "thinking_delta") {
            if (assistantEvent.delta.length === 0) return;
            const isReasoning = assistantEvent.type === "thinking_delta";
            const hadReasoningItem = context.activeReasoningItemId !== undefined;
            const itemId = isReasoning
              ? ensureReasoningItemId(context, turnId)
              : ensureAssistantItemId(context, turnId);
            if (isReasoning && !hadReasoningItem) {
              yield* emit({
                ...(yield* buildEventBase({
                  threadId: context.session.threadId,
                  turnId,
                  itemId,
                  raw: event,
                })),
                type: "item.started",
                payload: {
                  itemType: "reasoning",
                  status: "inProgress",
                  title: "Reasoning",
                },
              });
            }
            yield* emit({
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId,
                itemId,
                raw: event,
              })),
              type: "content.delta",
              payload: {
                streamKind: isReasoning ? "reasoning_text" : "assistant_text",
                delta: assistantEvent.delta,
                contentIndex: assistantEvent.contentIndex,
              },
            });
          }
          break;
        }
        case "message_end": {
          if (getPiMessageRole(event.message) !== "assistant") {
            break;
          }
          const stopReason = getPiAssistantStopReason(event.message);
          const assistantErrorMessage = getPiAssistantErrorMessage(event.message);
          if (stopReason === "error" || stopReason === "aborted") {
            context.activeTurnFailure = {
              state: stopReason === "aborted" ? "interrupted" : "failed",
              message:
                assistantErrorMessage ??
                (stopReason === "aborted"
                  ? "Pi request was aborted."
                  : "Pi provider returned an error."),
            };
          }
          const itemId = ensureAssistantItemId(context, turnId);
          const reasoningItemId = context.activeReasoningItemId;
          context.activeAssistantItemId = undefined;
          context.activeReasoningItemId = undefined;
          const detail = getPiMessageText(event.message) ?? assistantErrorMessage;
          if (reasoningItemId) {
            yield* emit({
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId,
                itemId: reasoningItemId,
                raw: event,
              })),
              type: "item.completed",
              payload: {
                itemType: "reasoning",
                status: stopReason === "error" ? "failed" : "completed",
                title: "Reasoning",
              },
            });
          }
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              itemId,
              raw: event,
            })),
            type: "item.completed",
            payload: {
              itemType: "assistant_message",
              status: stopReason === "error" ? "failed" : "completed",
              title: "Assistant message",
              ...(detail ? { detail } : {}),
              data: {
                itemId,
                ...(stopReason ? { stopReason } : {}),
                ...(assistantErrorMessage ? { errorMessage: assistantErrorMessage } : {}),
              },
            },
          });
          break;
        }
        case "tool_execution_start": {
          const itemType = toToolItemType(event.toolName);
          context.activeToolsByCallId.set(event.toolCallId, {
            turnId,
            toolName: event.toolName,
            args: event.args,
            itemType,
          });
          appendTurnItem(context, turnId, event);
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              itemId: event.toolCallId,
              raw: event,
            })),
            providerRefs: { providerItemId: ProviderItemId.make(event.toolCallId) },
            type: "item.started",
            payload: {
              itemType,
              status: "inProgress",
              title: buildPiToolTitle(event.toolName, event.args),
              data: buildPiToolData({
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                args: event.args,
              }),
            },
          });
          break;
        }
        case "tool_execution_update": {
          const activeTool = context.activeToolsByCallId.get(event.toolCallId);
          const toolTurnId = activeTool?.turnId ?? turnId;
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId: toolTurnId,
              itemId: event.toolCallId,
              raw: event,
            })),
            providerRefs: { providerItemId: ProviderItemId.make(event.toolCallId) },
            type: "item.updated",
            payload: {
              itemType: activeTool?.itemType ?? toToolItemType(event.toolName),
              status: "inProgress",
              title: buildPiToolTitle(event.toolName, activeTool?.args ?? event.args),
              detail: readPiToolTextOutput(event.partialResult),
              data: buildPiToolData({
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                args: activeTool?.args ?? event.args,
                partialResult: event.partialResult,
              }),
            },
          });
          break;
        }
        case "tool_execution_end": {
          const activeTool = context.activeToolsByCallId.get(event.toolCallId);
          const toolTurnId = activeTool?.turnId ?? turnId;
          appendTurnItem(context, toolTurnId, event);
          context.activeToolsByCallId.delete(event.toolCallId);
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId: toolTurnId,
              itemId: event.toolCallId,
              raw: event,
            })),
            providerRefs: { providerItemId: ProviderItemId.make(event.toolCallId) },
            type: "item.completed",
            payload: {
              itemType: activeTool?.itemType ?? toToolItemType(event.toolName),
              status: event.isError ? "failed" : "completed",
              title: buildPiToolTitle(event.toolName, activeTool?.args),
              detail: readPiToolTextOutput(event.result),
              data: buildPiToolData({
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                args: activeTool?.args,
                result: event.result,
                isError: event.isError,
              }),
            },
          });
          break;
        }
        case "agent_end": {
          if (event.willRetry) {
            break;
          }
          const terminalError = findLastPiAssistantTerminalError(event.messages);
          if (!terminalError) {
            break;
          }
          // Pi emits assistant message_end before agent_end. The assistant message already
          // carries the terminal error text, so agent_end should only preserve failed turn
          // state and not emit a duplicate runtime.error work-log entry.
          context.activeTurnFailure = terminalError;
          break;
        }
        case "session_info_changed": {
          if (!event.name || event.name.trim().length === 0) {
            break;
          }
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              raw: event,
            })),
            type: "thread.metadata.updated",
            payload: { name: event.name.trim() },
          });
          break;
        }
        case "compaction_start": {
          const itemId = `pi-compaction-${turnId ?? "session"}`;
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              itemId,
              raw: event,
            })),
            type: "item.started",
            payload: {
              itemType: "context_compaction",
              status: "inProgress",
              title: "Context compaction",
              data: { reason: event.reason },
            },
          });
          break;
        }
        case "compaction_end": {
          const itemId = `pi-compaction-${turnId ?? "session"}`;
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              itemId,
              raw: event,
            })),
            type: "item.completed",
            payload: {
              itemType: "context_compaction",
              status: event.aborted || event.errorMessage ? "failed" : "completed",
              title: "Context compaction",
              ...(piCompactionDetail(event) ? { detail: piCompactionDetail(event) } : {}),
              data: {
                reason: event.reason,
                aborted: event.aborted,
                willRetry: event.willRetry,
                ...(event.result !== undefined ? { result: event.result } : {}),
                ...(event.errorMessage !== undefined ? { errorMessage: event.errorMessage } : {}),
              },
            },
          });
          break;
        }
        case "auto_retry_start": {
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              raw: event,
            })),
            type: "runtime.warning",
            payload: {
              message: `Pi retrying request (${event.attempt}/${event.maxAttempts}): ${event.errorMessage}`,
              detail: {
                attempt: event.attempt,
                maxAttempts: event.maxAttempts,
                delayMs: event.delayMs,
                errorMessage: event.errorMessage,
              },
            },
          });
          break;
        }
        case "auto_retry_end": {
          if (event.success) {
            break;
          }
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              raw: event,
            })),
            type: "runtime.error",
            payload: {
              message: event.finalError ?? `Pi retry attempt ${event.attempt} failed.`,
              class: classifyPiRuntimeError(
                event.finalError ?? `Pi retry attempt ${event.attempt} failed.`,
              ),
              detail: {
                success: event.success,
                attempt: event.attempt,
                ...(event.finalError !== undefined ? { finalError: event.finalError } : {}),
              },
            },
          });
          break;
        }
        default:
          break;
      }
    }).pipe(Effect.ignoreCause({ log: true }));

  const stopContext = Effect.fn("stopPiContext")(function* (context: PiSessionContext) {
    const wasStopped = yield* Ref.getAndSet(context.stopped, true);
    if (wasStopped) return false;
    if (context.activePromptFiber) {
      yield* Fiber.interrupt(context.activePromptFiber).pipe(Effect.ignore);
    }
    context.unsubscribe();
    yield* Effect.sync(() => context.piSession.dispose()).pipe(Effect.ignore);
    yield* Scope.close(context.sessionScope, Exit.void).pipe(Effect.ignore);
    return true;
  });

  const startSession: PiAdapterShape["startSession"] = Effect.fn("startSession")(function* (input) {
    if (input.provider !== undefined && input.provider !== PROVIDER) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "startSession",
        issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
      });
    }

    const existing = sessions.get(input.threadId);
    if (existing) {
      yield* stopContext(existing);
      sessions.delete(input.threadId);
    }

    const cwd = input.cwd ?? serverConfig.cwd;
    const model = resolvePiModel(options.modelRegistry, input.modelSelection?.model);
    if (!model) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "startSession",
        issue: input.modelSelection?.model
          ? `Pi model '${input.modelSelection.model}' is not available or is missing auth.`
          : "No Pi model with configured auth is available.",
      });
    }

    const resumeSessionFile = extractResumeSessionFile(input.resumeCursor);
    const sessionManager = resumeSessionFile
      ? SessionManager.open(resumeSessionFile, undefined, cwd)
      : undefined;
    const sessionScope = yield* Scope.make();
    const environmentId = options.environmentId;
    const providerSessionId = yield* randomUUIDv4;
    const issuedAt = yield* Clock.currentTimeMillis;
    const piT3Tools = makePiT3Tools({
      environmentId,
      threadId: input.threadId,
      providerInstanceId: boundInstanceId,
      providerSessionId,
      makeSnapshotToolView: (snapshot) =>
        runPromise(
          makePreviewAutomationSnapshotToolView({
            stateDir: serverConfig.stateDir,
            threadId: input.threadId,
            snapshot,
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
          ),
        ),
      issuedAt,
      expiresAt: issuedAt + 8 * 60 * 60 * 1_000,
    });
    const created = yield* Effect.tryPromise({
      try: () =>
        withTemporaryProcessEnvironment(options.environment, async () => {
          const created = await createAgentSession({
            cwd,
            ...(piSettings.agentDir ? { agentDir: piSettings.agentDir } : {}),
            authStorage:
              options.authStorage ??
              AuthStorage.create(
                piSettings.agentDir ? `${piSettings.agentDir}/auth.json` : undefined,
              ),
            modelRegistry: options.modelRegistry,
            model,
            ...(sessionManager ? { sessionManager } : {}),
            ...(piSettings.tools.length > 0
              ? { tools: [...new Set([...piSettings.tools, ...T3_PI_TOOL_NAMES])] }
              : {}),
            ...(piSettings.excludeTools.length > 0
              ? { excludeTools: [...piSettings.excludeTools] }
              : {}),
            ...(piSettings.noTools === "all" || piSettings.noTools === "builtin"
              ? { noTools: piSettings.noTools }
              : {}),
            customTools: piT3Tools,
          });
          await created.session.bindExtensions({});
          return created;
        }),
      catch: (cause) =>
        new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId: input.threadId,
          detail: errorDetail(cause),
          cause,
        }),
    }).pipe(Effect.onError(() => Scope.close(sessionScope, Exit.void).pipe(Effect.ignore)));

    const createdAt = yield* nowIso;
    const resumeCursor = buildPiResumeCursor(created.session.sessionManager);
    const session: ProviderSession = {
      provider: PROVIDER,
      providerInstanceId: boundInstanceId,
      status: "ready",
      runtimeMode: input.runtimeMode,
      cwd,
      model: `${model.provider}/${model.id}`,
      threadId: input.threadId,
      ...(resumeCursor ? { resumeCursor } : {}),
      createdAt,
      updatedAt: createdAt,
    };

    const contextRef: { current?: PiSessionContext } = {};
    const unsubscribe = created.session.subscribe((event) => {
      const context = contextRef.current;
      if (!context) return;
      runFork(
        writeNativeEvent(context.session.threadId, event).pipe(
          Effect.andThen(handleSessionEvent(context, event)),
        ),
      );
    });
    const context: PiSessionContext = {
      session,
      piSession: created.session,
      sessionScope,
      unsubscribe,
      turns: [],
      stopped: yield* Ref.make(false),
      deferredUserMessageTexts: [],
      queuedDuringCompaction: [],
      activeToolsByCallId: new Map(),
      activeTurnId: undefined,
      activeCompactionTurnId: undefined,
      activePromptFiber: undefined,
      activeAssistantItemId: undefined,
      activeReasoningItemId: undefined,
      activeTurnFailure: undefined,
      nextAssistantMessageIndex: 0,
    };
    contextRef.current = context;
    sessions.set(input.threadId, context);

    yield* emit({
      ...(yield* buildEventBase({ threadId: input.threadId })),
      type: "session.started",
      payload: { message: "Pi SDK session started" },
    });
    yield* emit({
      ...(yield* buildEventBase({ threadId: input.threadId })),
      type: "thread.started",
      payload: { providerThreadId: created.session.sessionId },
    });
    const initialUsage = normalizePiTokenUsage(
      created.session.getSessionStats(),
      created.session.model?.contextWindow,
    );
    if (initialUsage) {
      yield* emit({
        ...(yield* buildEventBase({ threadId: input.threadId })),
        type: "thread.token-usage.updated",
        payload: { usage: initialUsage },
      });
    }

    return session;
  });

  const sendTurn: PiAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
    const context = ensureSessionContext(sessions, input.threadId);
    const activeTurnId = context.activeTurnId;

    const turnId = TurnId.make(`pi-turn-${yield* randomUUIDv4}`);
    const model = resolvePiModel(
      options.modelRegistry,
      input.modelSelection?.model ?? context.session.model,
    );
    if (!model) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "sendTurn",
        issue: `Pi model '${input.modelSelection?.model ?? context.session.model ?? ""}' is not available.`,
      });
    }

    const text = input.input?.trim();
    const images = yield* Effect.forEach(
      input.attachments ?? [],
      (attachment) =>
        Effect.gen(function* () {
          if (attachment.type !== "image") return null;
          const attachmentPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          });
          if (!attachmentPath) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: `Invalid image attachment id '${attachment.id}'.`,
            });
          }
          const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "attachment/read",
                  detail: `Failed to read attachment file: ${cause.message}.`,
                  cause,
                }),
            ),
          );
          return {
            type: "image" as const,
            data: Buffer.from(bytes).toString("base64"),
            mimeType: attachment.mimeType,
          };
        }),
      { concurrency: 1 },
    ).pipe(Effect.map((items) => items.filter((item) => item !== null)));
    if ((!text || text.length === 0) && images.length === 0) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "sendTurn",
        issue: "Pi turns require text input or at least one attachment.",
      });
    }

    if (text === "/reload" && images.length === 0) {
      ensureTurnSnapshot(context, turnId);
      context.activeTurnId = turnId;
      context.activeAssistantItemId = undefined;
      context.activeReasoningItemId = undefined;
      context.activeTurnFailure = undefined;
      yield* updateProviderSession(
        context,
        { status: "running", activeTurnId: turnId, model: `${model.provider}/${model.id}` },
        { clearLastError: true },
      );
      yield* emit({
        ...(yield* buildEventBase({ threadId: input.threadId, turnId, raw: { method: "reload" } })),
        type: "turn.started",
        payload: { model: `${model.provider}/${model.id}` },
      });
      yield* Effect.tryPromise({
        try: () => context.piSession.reload(),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "reload",
            detail: errorDetail(cause),
            cause,
          }),
      }).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            context.activeTurnId = undefined;
            context.activePromptFiber = undefined;
            context.activeAssistantItemId = undefined;
            context.activeReasoningItemId = undefined;
            yield* updateProviderSession(
              context,
              { status: "error", lastError: error.detail },
              { clearActiveTurnId: true },
            );
            yield* emit({
              ...(yield* buildEventBase({ threadId: input.threadId, turnId, raw: error })),
              type: "turn.completed",
              payload: { state: "failed", errorMessage: error.detail },
            });
            yield* emit({
              ...(yield* buildEventBase({ threadId: input.threadId, turnId, raw: error })),
              type: "runtime.error",
              payload: {
                message: error.detail,
                class: classifyPiRuntimeError(error.detail),
                detail: error,
              },
            });
            return yield* error;
          }),
        ),
      );
      context.activeTurnId = undefined;
      context.activePromptFiber = undefined;
      context.activeAssistantItemId = undefined;
      context.activeReasoningItemId = undefined;
      yield* updateProviderSession(context, { status: "ready" }, { clearActiveTurnId: true });
      yield* emit({
        ...(yield* buildEventBase({ threadId: input.threadId, turnId, raw: { method: "reload" } })),
        type: "turn.completed",
        payload: { state: "completed" },
      });
      return {
        threadId: input.threadId,
        turnId,
        ...(context.session.resumeCursor !== undefined
          ? { resumeCursor: context.session.resumeCursor }
          : {}),
      };
    }

    if (context.activeCompactionTurnId && text !== undefined) {
      const compactionTurnId = context.activeCompactionTurnId;
      const mode = piSettings.midTurnInputMode;
      enqueueDuringCompaction(context, { mode, text, images, createdAt: yield* nowIso });
      yield* emitQueuedDuringCompactionUpdate(context, compactionTurnId);
      return { threadId: input.threadId, turnId: compactionTurnId };
    }

    // Handle /compact slash command — trigger manual compaction instead of
    // starting a turn. Supports optional custom instructions after the command.
    const compactMatch = text?.match(/^\/compact(?:\s+(.+))?$/);
    if (compactMatch) {
      const customInstructions = compactMatch[1]?.trim();
      ensureTurnSnapshot(context, turnId);
      context.activeTurnId = turnId;
      context.activeCompactionTurnId = turnId;
      context.activeAssistantItemId = undefined;
      context.activeReasoningItemId = undefined;
      context.activeTurnFailure = undefined;
      yield* updateProviderSession(
        context,
        { status: "running", activeTurnId: turnId, model: `${model.provider}/${model.id}` },
        { clearLastError: true },
      );
      yield* emit({
        ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
        type: "turn.started",
        payload: { model: `${model.provider}/${model.id}` },
      });
      yield* emitContextWindowUsage(context, turnId).pipe(Effect.ignore);
      const compactEffect = Effect.tryPromise({
        try: () => context.piSession.compact(customInstructions),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "compact",
            detail: errorDetail(cause),
            cause,
          }),
      }).pipe(
        Effect.flatMap(() =>
          Effect.gen(function* () {
            const stopped = yield* Ref.get(context.stopped);
            if (stopped || context.activeTurnId !== turnId) return;
            recordTurnLeaf(context, turnId);
            context.activeTurnId = undefined;
            context.activeCompactionTurnId = undefined;
            context.activePromptFiber = undefined;
            context.activeAssistantItemId = undefined;
            context.activeReasoningItemId = undefined;
            context.activeTurnFailure = undefined;
            yield* emitContextWindowUsage(context, turnId).pipe(Effect.ignore);
            yield* updateProviderSession(context, { status: "ready" }, { clearActiveTurnId: true });
            yield* emit({
              ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
              type: "thread.state.changed",
              payload: {
                state: "compacted",
                detail: customInstructions
                  ? { instructions: customInstructions }
                  : { reason: "manual_compact_command" },
              },
            });
            yield* emit({
              ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
              type: "turn.completed",
              payload: { state: "completed" },
            });
            yield* runQueuedAfterCompaction(context, `${model.provider}/${model.id}`);
          }),
        ),
        Effect.catch((error) =>
          Effect.gen(function* () {
            const stopped = yield* Ref.get(context.stopped);
            if (stopped || context.activeTurnId !== turnId) return;
            context.activeTurnId = undefined;
            context.activeCompactionTurnId = undefined;
            context.activePromptFiber = undefined;
            context.activeAssistantItemId = undefined;
            context.activeReasoningItemId = undefined;
            const detail = error.detail;
            yield* updateProviderSession(
              context,
              { status: "error", lastError: detail },
              { clearActiveTurnId: true },
            );
            yield* emit({
              ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
              type: "turn.completed",
              payload: { state: "failed", errorMessage: detail },
            });
            yield* emit({
              ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
              type: "runtime.error",
              payload: { message: detail, class: classifyPiRuntimeError(detail), detail: error },
            });
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.logError("Pi compact fiber failed", { cause: Cause.pretty(cause) }),
        ),
      );
      context.activePromptFiber = yield* compactEffect.pipe(
        Effect.asVoid,
        Effect.forkIn(context.sessionScope),
      );
      return { threadId: input.threadId, turnId };
    }

    if (activeTurnId) {
      context.deferredUserMessageTexts.push(text ?? "");
      yield* Effect.tryPromise({
        try: () =>
          context.piSession.prompt(text ?? "", {
            ...(images.length > 0 ? { images } : {}),
            streamingBehavior: piSettings.midTurnInputMode,
          }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: `prompt/${piSettings.midTurnInputMode}`,
            detail: errorDetail(cause),
            cause,
          }),
      }).pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            const index = context.deferredUserMessageTexts.indexOf(text ?? "");
            if (index !== -1) {
              context.deferredUserMessageTexts.splice(index, 1);
            }
          }),
        ),
      );
      return { threadId: input.threadId, turnId: activeTurnId };
    }

    const thinkingLevel = resolveThinkingLevel(input);
    yield* Effect.tryPromise({
      try: async () => {
        await context.piSession.setModel(model);
        if (thinkingLevel) context.piSession.setThinkingLevel(thinkingLevel);
      },
      catch: (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "set_model",
          detail: errorDetail(cause),
          cause,
        }),
    });

    ensureTurnSnapshot(context, turnId);
    context.activeTurnId = turnId;
    context.activeAssistantItemId = undefined;
    context.activeReasoningItemId = undefined;
    context.activeTurnFailure = undefined;
    context.nextAssistantMessageIndex = 0;
    yield* updateProviderSession(
      context,
      { status: "running", activeTurnId: turnId, model: `${model.provider}/${model.id}` },
      { clearLastError: true },
    );
    yield* emit({
      ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
      type: "turn.started",
      payload: {
        model: `${model.provider}/${model.id}`,
        ...(thinkingLevel ? { effort: thinkingLevel } : {}),
      },
    });

    const promptEffect = Effect.tryPromise({
      try: () => context.piSession.prompt(text ?? "", images.length > 0 ? { images } : undefined),
      catch: (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "prompt",
          detail: errorDetail(cause),
          cause,
        }),
    }).pipe(
      Effect.flatMap(() =>
        Effect.gen(function* () {
          const stopped = yield* Ref.get(context.stopped);
          if (stopped || context.activeTurnId !== turnId) return;
          const turnFailure = context.activeTurnFailure;
          recordTurnLeaf(context, turnId);
          context.activeTurnId = undefined;
          context.activePromptFiber = undefined;
          context.activeAssistantItemId = undefined;
          context.activeReasoningItemId = undefined;
          context.activeTurnFailure = undefined;
          yield* updateProviderSession(
            context,
            turnFailure
              ? {
                  status: turnFailure.state === "interrupted" ? "ready" : "error",
                  lastError: turnFailure.message,
                }
              : { status: "ready" },
            { clearActiveTurnId: true },
          );
          yield* emitContextWindowUsage(context, turnId);
          yield* emit({
            ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
            type: "turn.completed",
            payload: turnFailure
              ? { state: turnFailure.state, errorMessage: turnFailure.message }
              : { state: "completed" },
          });
        }),
      ),
      Effect.catch((error) =>
        Effect.gen(function* () {
          const stopped = yield* Ref.get(context.stopped);
          if (stopped || context.activeTurnId !== turnId) return;
          context.activeTurnId = undefined;
          context.activePromptFiber = undefined;
          context.activeAssistantItemId = undefined;
          context.activeReasoningItemId = undefined;
          yield* updateProviderSession(
            context,
            { status: "error", lastError: error.detail },
            { clearActiveTurnId: true },
          );
          yield* emit({
            ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
            type: "turn.completed",
            payload: { state: "failed", errorMessage: error.detail },
          });
          yield* emit({
            ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
            type: "runtime.error",
            payload: {
              message: error.detail,
              class: classifyPiRuntimeError(error.detail),
              detail: error,
            },
          });
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.logError("Pi prompt fiber failed", { cause: Cause.pretty(cause) }),
      ),
    );
    context.activePromptFiber = yield* promptEffect.pipe(
      Effect.asVoid,
      Effect.forkIn(context.sessionScope),
    );
    return {
      threadId: input.threadId,
      turnId,
      ...(context.session.resumeCursor !== undefined
        ? { resumeCursor: context.session.resumeCursor }
        : {}),
    };
  });

  const interruptTurn: PiAdapterShape["interruptTurn"] = Effect.fn("interruptTurn")(
    function* (threadId, turnId) {
      const context = ensureSessionContext(sessions, threadId);
      const activeTurnId = turnId ?? context.activeTurnId;

      context.activeTurnId = undefined;
      context.activePromptFiber = undefined;
      context.activeAssistantItemId = undefined;
      context.activeReasoningItemId = undefined;
      context.activeTurnFailure = undefined;
      context.deferredUserMessageTexts.splice(0);

      yield* Effect.sync(() => context.piSession.clearQueue()).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "clearQueue",
              detail: errorDetail(cause),
              cause,
            }),
        ),
      );
      yield* Effect.tryPromise({
        try: () => context.piSession.abort(),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "abort",
            detail: errorDetail(cause),
            cause,
          }),
      });
      yield* updateProviderSession(context, { status: "ready" }, { clearActiveTurnId: true });
      if (activeTurnId) {
        yield* emit({
          ...(yield* buildEventBase({ threadId, turnId: activeTurnId })),
          type: "turn.aborted",
          payload: { reason: "Interrupted by user." },
        });
        yield* emit({
          ...(yield* buildEventBase({ threadId, turnId: activeTurnId })),
          type: "turn.completed",
          payload: { state: "interrupted" },
        });
      }
    },
  );

  const respondToRequest: PiAdapterShape["respondToRequest"] = (_threadId, requestId) =>
    Effect.fail(
      new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "respondToRequest",
        detail: `Pi SDK phase 1 does not expose approval request '${requestId}'.`,
      }),
    );

  const respondToUserInput: PiAdapterShape["respondToUserInput"] = (_threadId, requestId) =>
    Effect.fail(
      new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "respondToUserInput",
        detail: `Pi SDK phase 1 does not expose user input request '${requestId}'.`,
      }),
    );

  const stopSession: PiAdapterShape["stopSession"] = Effect.fn("stopSession")(function* (threadId) {
    const context = ensureSessionContext(sessions, threadId);
    const stopped = yield* stopContext(context);
    sessions.delete(threadId);
    if (stopped) {
      yield* emit({
        ...(yield* buildEventBase({ threadId })),
        type: "session.exited",
        payload: { reason: "Session stopped.", recoverable: false, exitKind: "graceful" },
      });
    }
  });

  const listSessions: PiAdapterShape["listSessions"] = () =>
    Effect.sync(() => [...sessions.values()].map((context) => context.session));

  const hasSession: PiAdapterShape["hasSession"] = (threadId) =>
    Effect.sync(() => sessions.has(threadId));

  const snapshotThread = (context: PiSessionContext) => {
    const historyItems = mapPiMessageHistory(context.piSession);
    const activeTurn = context.activeTurnId
      ? context.turns.find((turn) => turn.id === context.activeTurnId)
      : undefined;
    const turns = [
      ...(historyItems.length > 0
        ? [{ id: TurnId.make(`pi-history-${context.piSession.sessionId}`), items: historyItems }]
        : []),
      ...(activeTurn ? [{ id: activeTurn.id, items: [...activeTurn.items] }] : []),
    ];
    return {
      threadId: context.session.threadId,
      ...(context.session.cwd ? { cwd: context.session.cwd } : {}),
      turns:
        turns.length > 0
          ? turns
          : context.turns.map((turn) => ({ id: turn.id, items: [...turn.items] })),
    };
  };

  const readThread: PiAdapterShape["readThread"] = (threadId) =>
    Effect.sync(() => snapshotThread(ensureSessionContext(sessions, threadId)));

  const rollbackThread: PiAdapterShape["rollbackThread"] = (threadId, numTurns) =>
    Effect.sync(() => {
      const context = ensureSessionContext(sessions, threadId);
      const nextLength = Math.max(0, context.turns.length - Math.max(0, numTurns));
      context.turns.splice(nextLength);
      const leafId = context.turns.at(-1)?.leafId;
      if (leafId) {
        context.piSession.sessionManager.branch(leafId);
      } else if (nextLength === 0) {
        context.piSession.sessionManager.resetLeaf();
      }
      context.piSession.agent.state.messages =
        context.piSession.sessionManager.buildSessionContext().messages;
      return snapshotThread(context);
    });

  const stopAll: PiAdapterShape["stopAll"] = () =>
    Effect.gen(function* () {
      const contexts = [...sessions.values()];
      sessions.clear();
      yield* Effect.forEach(contexts, (context) => Effect.ignoreCause(stopContext(context)), {
        concurrency: "unbounded",
        discard: true,
      });
    });

  const listModels: NonNullable<PiAdapterShape["listModels"]> = () =>
    Effect.try({
      try: () => {
        options.modelRegistry.refresh();
        const models = options.modelRegistry.getAvailable().map((model) => {
          const supportedThinkingOptions = getPiSupportedThinkingOptions(model);
          return {
            slug: `${model.provider}/${model.id}`,
            name: model.name,
            upstreamProviderId: model.provider,
            upstreamProviderName: options.modelRegistry.getProviderDisplayName(model.provider),
            ...(supportedThinkingOptions.length > 0
              ? {
                  supportedReasoningEfforts: supportedThinkingOptions.map((option) => ({
                    value: option.value,
                    label: option.label,
                    description: option.description,
                  })),
                  ...(supportedThinkingOptions.some(
                    (option) => option.value === DEFAULT_PI_THINKING_LEVEL,
                  )
                    ? { defaultReasoningEffort: DEFAULT_PI_THINKING_LEVEL }
                    : {}),
                }
              : {}),
          };
        });
        return { models, source: "pi.sdk", cached: false } satisfies ProviderListModelsResult;
      },
      catch: (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "model/list",
          detail: errorDetail(cause),
          cause,
        }),
    });

  const listSkills: NonNullable<PiAdapterShape["listSkills"]> = (input) =>
    Effect.tryPromise({
      try: async () => {
        const active = input.threadId ? sessions.get(input.threadId) : undefined;
        const loader = active?.piSession.resourceLoader;
        if (active && input.forceReload) await active.piSession.reload();
        const services = loader
          ? undefined
          : await createAgentSessionServices({
              cwd: input.cwd ?? serverConfig.cwd,
              ...(piSettings.agentDir ? { agentDir: piSettings.agentDir } : {}),
              modelRegistry: options.modelRegistry,
            });
        if (services && input.forceReload) await services.resourceLoader.reload();
        const result = (loader ?? services!.resourceLoader).getSkills();
        return {
          skills: result.skills.map((skill: PiSkill) => piSkillToServerProviderSkill(skill)),
          source: "pi.sdk",
          cached: false,
        } satisfies ProviderListSkillsResult;
      },
      catch: (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "skill/list",
          detail: errorDetail(cause),
          cause,
        }),
    });

  const listCommands: NonNullable<PiAdapterShape["listCommands"]> = (input) =>
    Effect.tryPromise({
      try: async () => {
        const active = input.threadId ? sessions.get(input.threadId) : undefined;
        const session = active?.piSession;
        const [reloadCommand, compactCommand] = PI_SLASH_COMMANDS;
        if (session) {
          if (input.forceReload) await session.reload();
          const extensionCommands = session.extensionRunner
            .getRegisteredCommands()
            .map((command) => ({
              name: command.invocationName,
              description: trimToUndefined(command.description) ?? "Extension command",
            }));
          const promptCommands = session.promptTemplates.map((template) => ({
            name: template.name,
            description: trimToUndefined(template.description) ?? "Prompt template",
          }));
          const skillCommands = session.resourceLoader.getSkills().skills.map((skill) => ({
            name: `skill:${skill.name}`,
            description: trimToUndefined(skill.description) ?? "Skill",
          }));
          return {
            commands: [
              reloadCommand!,
              compactCommand!,
              ...extensionCommands,
              ...promptCommands,
              ...skillCommands,
            ],
            source: "pi.sdk",
            cached: false,
          } satisfies ProviderListCommandsResult;
        }
        const services = await createAgentSessionServices({
          cwd: input.cwd ?? serverConfig.cwd,
          ...(piSettings.agentDir ? { agentDir: piSettings.agentDir } : {}),
          modelRegistry: options.modelRegistry,
        });
        if (input.forceReload) await services.resourceLoader.reload();
        const promptCommands = services.resourceLoader.getPrompts().prompts.map((template) => ({
          name: template.name,
          description: trimToUndefined(template.description) ?? "Prompt template",
        }));
        const skillCommands = services.resourceLoader.getSkills().skills.map((skill) => ({
          name: `skill:${skill.name}`,
          description: trimToUndefined(skill.description) ?? "Skill",
        }));
        return {
          commands: [reloadCommand!, compactCommand!, ...promptCommands, ...skillCommands],
          source: "pi.sdk",
          cached: false,
        } satisfies ProviderListCommandsResult;
      },
      catch: (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "command/list",
          detail: errorDetail(cause),
          cause,
        }),
    });

  const getComposerCapabilities: NonNullable<PiAdapterShape["getComposerCapabilities"]> = () =>
    Effect.succeed({
      instanceId: boundInstanceId,
      provider: PROVIDER,
      supportsSkillMentions: true,
      supportsSkillDiscovery: true,
      supportsNativeSlashCommandDiscovery: true,
      supportsPluginMentions: false,
      supportsPluginDiscovery: false,
      supportsRuntimeModelList: true,
      supportsThreadCompaction: true,
      supportsThreadImport: false,
      supportsTurnSteering: true,
    });

  return {
    provider: PROVIDER,
    capabilities: {
      sessionModelSwitch: "in-session",
      supportsSkillMentions: true,
      supportsSkillDiscovery: true,
      supportsNativeSlashCommandDiscovery: true,
      supportsRuntimeModelList: true,
      supportsThreadCompaction: true,
      supportsTurnSteering: true,
    },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    rollbackThread,
    stopAll,
    getComposerCapabilities,
    listModels,
    listSkills,
    listCommands,
    get streamEvents() {
      return Stream.fromQueue(runtimeEvents);
    },
  } satisfies PiAdapterShape;
});
