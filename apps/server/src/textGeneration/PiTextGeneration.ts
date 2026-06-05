import {
  type ChatAttachment,
  type ModelSelection,
  type PiSettings,
  TextGenerationError,
} from "@t3tools/contracts";
import { sanitizeFeatureBranchName } from "@t3tools/shared/git";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import {
  AuthStorage,
  createAgentSession,
  type ModelRegistry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

import { resolveAttachmentPath } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import type { BranchNameGenerationInput, TextGenerationShape } from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

const PROVIDER_LABEL = "Pi SDK";

type PiModel = NonNullable<ReturnType<ModelRegistry["find"]>>;

type PiTextGenerationOptions = {
  readonly settings: PiSettings;
  readonly authStorage: AuthStorage;
  readonly modelRegistry: ModelRegistry;
};

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parsePiModelSlug(slug: string): { provider: string; modelId: string } | null {
  const separator = slug.indexOf("/");
  if (separator <= 0 || separator === slug.length - 1) return null;
  return {
    provider: slug.slice(0, separator),
    modelId: slug.slice(separator + 1),
  };
}

function resolvePiModel(
  operation: string,
  modelRegistry: ModelRegistry,
  modelSelection: ModelSelection,
): Effect.Effect<PiModel, TextGenerationError> {
  const parsed = parsePiModelSlug(modelSelection.model);
  if (!parsed) {
    return Effect.fail(
      new TextGenerationError({
        operation,
        detail: "Pi model selection must use the 'provider/model' format.",
      }),
    );
  }

  const model = modelRegistry.find(parsed.provider, parsed.modelId);
  if (!model || !modelRegistry.hasConfiguredAuth(model)) {
    return Effect.fail(
      new TextGenerationError({
        operation,
        detail: `Pi model '${modelSelection.model}' is not available or is missing auth.`,
      }),
    );
  }
  return Effect.succeed(model);
}

function extractTextFromPiMessages(messages: ReadonlyArray<unknown>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || typeof message !== "object") continue;
    const record = message as {
      readonly role?: unknown;
      readonly content?: unknown;
    };
    if (record.role !== "assistant") continue;
    const content = record.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .flatMap((part) => {
          if (!part || typeof part !== "object") return [];
          const partRecord = part as {
            readonly type?: unknown;
            readonly text?: unknown;
          };
          return partRecord.type === "text" && typeof partRecord.text === "string"
            ? [partRecord.text]
            : [];
        })
        .join("");
    }
  }
  return "";
}

function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1]?.trim();
  if (fenced?.startsWith("{") && fenced.endsWith("}")) {
    return fenced;
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }

  return trimmed;
}

export const makePiTextGeneration = Effect.fn("makePiTextGeneration")(function* (
  options: PiTextGenerationOptions,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const serverConfig = yield* ServerConfig;

  const materializeImageAttachments = Effect.fn("materializePiTextGenerationImageAttachments")(
    function* (
      operation: "generateBranchName" | "generateThreadTitle",
      attachments: BranchNameGenerationInput["attachments"],
    ) {
      const images = yield* Effect.forEach(
        attachments ?? [],
        (attachment: ChatAttachment) =>
          Effect.gen(function* () {
            if (attachment.type !== "image") return null;
            const attachmentPath = resolveAttachmentPath({
              attachmentsDir: serverConfig.attachmentsDir,
              attachment,
            });
            if (!attachmentPath) return null;
            const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
              Effect.mapError(
                (cause) =>
                  new TextGenerationError({
                    operation,
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
      );
      return images.filter((image) => image !== null);
    },
  );

  const runPiJson = Effect.fn("runPiJson")(function* <S extends Schema.Top>(input: {
    readonly operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle";
    readonly cwd: string;
    readonly prompt: string;
    readonly outputSchemaJson: S;
    readonly modelSelection: ModelSelection;
    readonly images?: ReadonlyArray<{
      readonly type: "image";
      readonly data: string;
      readonly mimeType: string;
    }>;
  }): Effect.fn.Return<S["Type"], TextGenerationError, S["DecodingServices"]> {
    const model = yield* resolvePiModel(
      input.operation,
      options.modelRegistry,
      input.modelSelection,
    );
    const rawOutput = yield* Effect.tryPromise({
      try: async () => {
        const { session } = await createAgentSession({
          cwd: input.cwd,
          ...(options.settings.agentDir ? { agentDir: options.settings.agentDir } : {}),
          authStorage: options.authStorage,
          modelRegistry: options.modelRegistry,
          model,
          sessionManager: SessionManager.inMemory(),
          noTools: "all",
        });
        try {
          await session.prompt(
            input.prompt,
            input.images?.length ? { images: [...input.images] } : undefined,
          );
          const output = extractTextFromPiMessages(session.messages as ReadonlyArray<unknown>);
          if (output.trim().length === 0) {
            throw new Error(`${PROVIDER_LABEL} returned empty output.`);
          }
          return output;
        } finally {
          session.dispose();
        }
      },
      catch: (cause) =>
        new TextGenerationError({
          operation: input.operation,
          detail: errorDetail(cause),
          cause,
        }),
    });

    const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(input.outputSchemaJson));
    return yield* decodeOutput(extractJsonObject(rawOutput)).pipe(
      Effect.catchTag("SchemaError", (cause) =>
        Effect.fail(
          new TextGenerationError({
            operation: input.operation,
            detail: `${PROVIDER_LABEL} returned invalid structured output.`,
            cause,
          }),
        ),
      ),
    );
  });

  const generateCommitMessage: TextGenerationShape["generateCommitMessage"] = Effect.fn(
    "PiTextGeneration.generateCommitMessage",
  )(function* (input) {
    const { prompt, outputSchema } = buildCommitMessagePrompt({
      branch: input.branch,
      stagedSummary: input.stagedSummary,
      stagedPatch: input.stagedPatch,
      includeBranch: input.includeBranch === true,
    });
    const generated = yield* runPiJson({
      operation: "generateCommitMessage",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      subject: sanitizeCommitSubject(generated.subject),
      body: generated.body.trim(),
      ...("branch" in generated && typeof generated.branch === "string"
        ? { branch: sanitizeFeatureBranchName(generated.branch) }
        : {}),
    };
  });

  const generatePrContent: TextGenerationShape["generatePrContent"] = Effect.fn(
    "PiTextGeneration.generatePrContent",
  )(function* (input) {
    const { prompt, outputSchema } = buildPrContentPrompt({
      baseBranch: input.baseBranch,
      headBranch: input.headBranch,
      commitSummary: input.commitSummary,
      diffSummary: input.diffSummary,
      diffPatch: input.diffPatch,
    });
    const generated = yield* runPiJson({
      operation: "generatePrContent",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      title: sanitizePrTitle(generated.title),
      body: generated.body.trim(),
    };
  });

  const generateBranchName: TextGenerationShape["generateBranchName"] = Effect.fn(
    "PiTextGeneration.generateBranchName",
  )(function* (input) {
    const images = yield* materializeImageAttachments("generateBranchName", input.attachments);
    const { prompt, outputSchema } = buildBranchNamePrompt({
      message: input.message,
      attachments: input.attachments,
    });
    const generated = yield* runPiJson({
      operation: "generateBranchName",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
      images,
    });

    return {
      branch: sanitizeFeatureBranchName(generated.branch),
    };
  });

  const generateThreadTitle: TextGenerationShape["generateThreadTitle"] = Effect.fn(
    "PiTextGeneration.generateThreadTitle",
  )(function* (input) {
    const images = yield* materializeImageAttachments("generateThreadTitle", input.attachments);
    const { prompt, outputSchema } = buildThreadTitlePrompt({
      message: input.message,
      attachments: input.attachments,
    });
    const generated = yield* runPiJson({
      operation: "generateThreadTitle",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
      images,
    });

    return {
      title: sanitizeThreadTitle(generated.title),
    };
  });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGenerationShape;
});
