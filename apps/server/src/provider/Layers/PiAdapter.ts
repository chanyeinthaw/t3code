import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  RuntimeItemId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
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
import type {
  AgentSession,
  AgentSessionEvent,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { AuthStorage, createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
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

const PROVIDER = ProviderDriverKind.make("pi");

type PiModel = NonNullable<ReturnType<ModelRegistry["find"]>>;

interface PiResumeCursor {
  readonly sessionFile: string;
  readonly sessionId?: string;
}

function isPiResumeCursor(value: unknown): value is PiResumeCursor {
  if (!value || typeof value !== "object") return false;
  const record = value as { readonly sessionFile?: unknown };
  return typeof record.sessionFile === "string" && record.sessionFile.trim().length > 0;
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
    { readonly turnId: TurnId | undefined; readonly toolName: string; readonly args: unknown }
  >;
  activeTurnId: TurnId | undefined;
  activeCompactionTurnId: TurnId | undefined;
  activePromptFiber: Fiber.Fiber<void, never> | undefined;
  activeAssistantItemId: string | undefined;
  activeTurnFailure: PiTurnFailure | undefined;
  nextAssistantMessageIndex: number;
}

interface PiAdapterOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  readonly authStorage?: AuthStorage;
  readonly modelRegistry: ModelRegistry;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

export type PiAdapterEnv = Crypto.Crypto | FileSystem.FileSystem | ServerConfig;

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

function toToolItemType(
  toolName: string,
): "command_execution" | "file_change" | "dynamic_tool_call" {
  const normalized = toolName.toLowerCase();
  if (normalized.includes("bash") || normalized.includes("command")) return "command_execution";
  if (normalized.includes("edit") || normalized.includes("write") || normalized.includes("patch")) {
    return "file_change";
  }
  return "dynamic_tool_call";
}

function readPiToolCommand(toolName: string, args: unknown): string | undefined {
  const normalized = toolName.toLowerCase();
  if (!normalized.includes("bash") && !normalized.includes("command")) {
    return undefined;
  }
  if (!args || typeof args !== "object") {
    return undefined;
  }
  const command = (args as { readonly command?: unknown }).command;
  return typeof command === "string" && command.trim().length > 0 ? command : undefined;
}

function readPiToolTextOutput(result: unknown): string | undefined {
  if (typeof result === "string") {
    const trimmed = result.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const content = (result as { readonly content?: unknown }).content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = content
    .flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const block = entry as { readonly type?: unknown; readonly text?: unknown };
      return block.type === "text" && typeof block.text === "string" ? [block.text] : [];
    })
    .join("\n")
    .trim();
  return text.length > 0 ? text : undefined;
}

function buildPiToolData(input: {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: unknown;
  readonly partialResult?: unknown;
  readonly result?: unknown;
  readonly isError?: boolean;
}): Record<string, unknown> {
  const command = readPiToolCommand(input.toolName, input.args);
  return {
    toolCallId: input.toolCallId,
    args: input.args,
    ...(command !== undefined ? { command } : {}),
    ...(input.partialResult !== undefined ? { partialResult: input.partialResult } : {}),
    ...(input.result !== undefined ? { result: input.result } : {}),
    ...(input.isError !== undefined ? { isError: input.isError } : {}),
  };
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

export const makePiAdapter = Effect.fn("makePiAdapter")(function* (
  piSettings: PiSettings,
  options: PiAdapterOptions,
) {
  const boundInstanceId = options.instanceId ?? ProviderInstanceId.make("pi");
  const nativeEventLogger = options.nativeEventLogger;
  const serverConfig = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const effectContext = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(effectContext);
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
    const usage = context.piSession.getContextUsage();
    if (!usage || typeof usage.tokens !== "number" || usage.tokens <= 0) {
      return;
    }

    const usedTokens = Math.max(0, Math.round(usage.tokens));
    const maxTokens = Math.max(0, Math.round(usage.contextWindow));
    if (usedTokens <= 0) {
      return;
    }

    yield* emit({
      ...(yield* buildEventBase({ threadId: context.session.threadId, turnId })),
      type: "thread.token-usage.updated",
      payload: {
        usage: {
          usedTokens,
          lastUsedTokens: usedTokens,
          ...(maxTokens > 0 ? { maxTokens } : {}),
          compactsAutomatically: true,
        },
      },
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
    context.activeTurnId = queuedTurnId;
    context.activeAssistantItemId = undefined;
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
        payload: { message: detail, class: "provider_error", detail: continueExit.cause },
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
            context.activeAssistantItemId = `pi-assistant-${turnId ?? "session"}-${context.nextAssistantMessageIndex}`;
            context.nextAssistantMessageIndex += 1;
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
            const itemId = ensureAssistantItemId(context, turnId);
            yield* emit({
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId,
                itemId,
                raw: event,
              })),
              type: "content.delta",
              payload: {
                streamKind:
                  assistantEvent.type === "thinking_delta" ? "reasoning_text" : "assistant_text",
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
          context.activeAssistantItemId = undefined;
          const detail = getPiMessageText(event.message) ?? assistantErrorMessage;
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
          context.activeToolsByCallId.set(event.toolCallId, {
            turnId,
            toolName: event.toolName,
            args: event.args,
          });
          appendTurnItem(context, turnId, event);
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              itemId: event.toolCallId,
              raw: event,
            })),
            type: "item.started",
            payload: {
              itemType: toToolItemType(event.toolName),
              status: "inProgress",
              title: event.toolName,
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
            type: "item.updated",
            payload: {
              itemType: toToolItemType(event.toolName),
              status: "inProgress",
              title: event.toolName,
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
            type: "item.completed",
            payload: {
              itemType: toToolItemType(event.toolName),
              status: event.isError ? "failed" : "completed",
              title: event.toolName,
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
              class: "provider_error",
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

    const sessionManager = isPiResumeCursor(input.resumeCursor)
      ? SessionManager.open(input.resumeCursor.sessionFile, undefined, cwd)
      : undefined;
    const sessionScope = yield* Scope.make();
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
            ...(piSettings.tools.length > 0 ? { tools: [...piSettings.tools] } : {}),
            ...(piSettings.excludeTools.length > 0
              ? { excludeTools: [...piSettings.excludeTools] }
              : {}),
            ...(piSettings.noTools === "all" || piSettings.noTools === "builtin"
              ? { noTools: piSettings.noTools }
              : {}),
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
          const attachmentPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          });
          if (!attachmentPath) return null;
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
      context.activeTurnId = turnId;
      context.activeCompactionTurnId = turnId;
      context.activeAssistantItemId = undefined;
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
            context.activeTurnId = undefined;
            context.activeCompactionTurnId = undefined;
            context.activePromptFiber = undefined;
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
              payload: { message: detail, class: "provider_error", detail: error },
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

    context.activeTurnId = turnId;
    context.activeAssistantItemId = undefined;
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
          context.activeTurnId = undefined;
          context.activePromptFiber = undefined;
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
            payload: { message: error.detail, class: "provider_error", detail: error },
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

  const readThread: PiAdapterShape["readThread"] = (threadId) =>
    Effect.sync(() => {
      const context = ensureSessionContext(sessions, threadId);
      return { threadId, turns: context.turns };
    });

  const rollbackThread: PiAdapterShape["rollbackThread"] = (threadId, numTurns) =>
    Effect.sync(() => {
      const context = ensureSessionContext(sessions, threadId);
      context.turns.splice(Math.max(0, context.turns.length - numTurns));
      return { threadId, turns: context.turns };
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

  return {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "in-session" },
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
    get streamEvents() {
      return Stream.fromQueue(runtimeEvents);
    },
  } satisfies PiAdapterShape;
});
