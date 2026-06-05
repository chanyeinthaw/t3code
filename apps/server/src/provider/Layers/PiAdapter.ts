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

const PROVIDER = ProviderDriverKind.make("pi");

type PiModel = NonNullable<ReturnType<ModelRegistry["find"]>>;

interface PiTurnSnapshot {
  readonly id: TurnId;
  readonly items: Array<unknown>;
}

interface PiSessionContext {
  session: ProviderSession;
  readonly piSession: AgentSession;
  readonly sessionScope: Scope.Closeable;
  readonly unsubscribe: () => void;
  readonly turns: Array<PiTurnSnapshot>;
  readonly stopped: Ref.Ref<boolean>;
  activeTurnId: TurnId | undefined;
  activePromptFiber: Fiber.Fiber<void, never> | undefined;
}

interface PiAdapterOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  readonly authStorage?: AuthStorage;
  readonly modelRegistry: ModelRegistry;
}

export type PiAdapterEnv = Crypto.Crypto | FileSystem.FileSystem | ServerConfig;

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

export const makePiAdapter = Effect.fn("makePiAdapter")(function* (
  piSettings: PiSettings,
  options: PiAdapterOptions,
) {
  const boundInstanceId = options.instanceId ?? ProviderInstanceId.make("pi");
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
  }) {
    return {
      eventId: EventId.make(`pi-event-${yield* randomUUIDv4}`),
      provider: PROVIDER,
      providerInstanceId: boundInstanceId,
      threadId: input.threadId,
      createdAt: yield* nowIso,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(input.itemId ? { itemId: RuntimeItemId.make(input.itemId) } : {}),
      ...(input.raw ? { raw: { source: "pi.sdk.event" as const, payload: input.raw } } : {}),
    };
  });

  const emit = (event: ProviderRuntimeEvent) => Queue.offer(runtimeEvents, event);

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

  const handleSessionEvent = (
    context: PiSessionContext,
    event: AgentSessionEvent,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const turnId = context.activeTurnId;
      switch (event.type) {
        case "message_update": {
          const assistantEvent = event.assistantMessageEvent;
          if (assistantEvent.type === "text_delta" || assistantEvent.type === "thinking_delta") {
            if (assistantEvent.delta.length === 0) return;
            yield* emit({
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId,
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
        case "tool_execution_start": {
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
              data: { args: event.args },
            },
          });
          break;
        }
        case "tool_execution_update": {
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              itemId: event.toolCallId,
              raw: event,
            })),
            type: "item.updated",
            payload: {
              itemType: toToolItemType(event.toolName),
              status: "inProgress",
              title: event.toolName,
              detail: typeof event.partialResult === "string" ? event.partialResult : undefined,
              data: { args: event.args, partialResult: event.partialResult },
            },
          });
          break;
        }
        case "tool_execution_end": {
          appendTurnItem(context, turnId, event);
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              itemId: event.toolCallId,
              raw: event,
            })),
            type: "item.completed",
            payload: {
              itemType: toToolItemType(event.toolName),
              status: event.isError ? "failed" : "completed",
              title: event.toolName,
              detail: typeof event.result === "string" ? event.result : undefined,
              data: { result: event.result, isError: event.isError },
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

    const sessionScope = yield* Scope.make();
    const created = yield* Effect.tryPromise({
      try: () =>
        createAgentSession({
          cwd,
          ...(piSettings.agentDir ? { agentDir: piSettings.agentDir } : {}),
          authStorage:
            options.authStorage ??
            AuthStorage.create(
              piSettings.agentDir ? `${piSettings.agentDir}/auth.json` : undefined,
            ),
          modelRegistry: options.modelRegistry,
          model,
          sessionManager: piSettings.persistSessions
            ? SessionManager.create(cwd)
            : SessionManager.inMemory(),
          ...(piSettings.tools.length > 0 ? { tools: [...piSettings.tools] } : {}),
          ...(piSettings.excludeTools.length > 0
            ? { excludeTools: [...piSettings.excludeTools] }
            : {}),
          ...(piSettings.noTools === "all" || piSettings.noTools === "builtin"
            ? { noTools: piSettings.noTools }
            : {}),
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
    const session: ProviderSession = {
      provider: PROVIDER,
      providerInstanceId: boundInstanceId,
      status: "ready",
      runtimeMode: input.runtimeMode,
      cwd,
      model: `${model.provider}/${model.id}`,
      threadId: input.threadId,
      createdAt,
      updatedAt: createdAt,
    };

    const contextRef: { current?: PiSessionContext } = {};
    const unsubscribe = created.session.subscribe((event) => {
      const context = contextRef.current;
      if (!context) return;
      runFork(handleSessionEvent(context, event));
    });
    const context: PiSessionContext = {
      session,
      piSession: created.session,
      sessionScope,
      unsubscribe,
      turns: [],
      stopped: yield* Ref.make(false),
      activeTurnId: undefined,
      activePromptFiber: undefined,
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
    if (context.activeTurnId) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "sendTurn",
        issue: "Pi session already has an active turn.",
      });
    }

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
          context.activeTurnId = undefined;
          context.activePromptFiber = undefined;
          yield* updateProviderSession(context, { status: "ready" }, { clearActiveTurnId: true });
          yield* emit({
            ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
            type: "turn.completed",
            payload: { state: "completed" },
          });
        }),
      ),
      Effect.catch((error) =>
        Effect.gen(function* () {
          const stopped = yield* Ref.get(context.stopped);
          if (stopped) return;
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
    return { threadId: input.threadId, turnId };
  });

  const interruptTurn: PiAdapterShape["interruptTurn"] = Effect.fn("interruptTurn")(
    function* (threadId, turnId) {
      const context = ensureSessionContext(sessions, threadId);
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
      const activeTurnId = turnId ?? context.activeTurnId;
      context.activeTurnId = undefined;
      context.activePromptFiber = undefined;
      yield* updateProviderSession(context, { status: "ready" }, { clearActiveTurnId: true });
      if (activeTurnId) {
        yield* emit({
          ...(yield* buildEventBase({ threadId, turnId: activeTurnId })),
          type: "turn.aborted",
          payload: { reason: "Interrupted by user." },
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
