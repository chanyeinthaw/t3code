"use client";

import { LegendList, type LegendListRef } from "@legendapp/list/react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  EyeIcon,
  EyeOffIcon,
  InfoIcon,
  PlusIcon,
  StarIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProviderModel,
} from "@pulse/contracts";
import { normalizeModelSlug } from "@pulse/shared/model";

import { cn } from "../../lib/utils";
import { sortModelsForProviderInstance } from "../../modelOrdering";
import { MAX_CUSTOM_MODEL_LENGTH } from "../../modelSelection";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * Placeholder text for the "add a custom model" input, keyed by driver
 * kind. Mirrors the prior hardcoded switch in `SettingsPanels.tsx` so the
 * UX is unchanged — only the owning component has moved.
 */
const CUSTOM_MODEL_PLACEHOLDER_BY_KIND: Partial<Record<ProviderDriverKind, string>> = {
  [ProviderDriverKind.make("codex")]: "gpt-6.7-codex-ultra-preview",
  [ProviderDriverKind.make("opencode")]: "openai/gpt-5",
};

const PROVIDER_MODELS_VIRTUALIZATION_THRESHOLD = 60;
const PROVIDER_MODELS_ESTIMATED_ROW_HEIGHT = 32;
const PROVIDER_MODELS_LIST_MAX_HEIGHT = 256;

interface ProviderModelsSectionProps {
  /** Identifier used to namespace input ids within the DOM. */
  readonly instanceId: ProviderInstanceId;
  /**
   * Driver kind for slug normalization + input placeholder. `null` when
   * the section is rendered without enough provider metadata.
   */
  readonly driverKind: ProviderDriverKind | null;
  /**
   * The live model list to display. Includes both built-in (probe-reported)
   * and custom entries, distinguished by `isCustom`.
   */
  readonly models: ReadonlyArray<ServerProviderModel>;
  /**
   * The persisted custom-model slug list for this instance. Drives dedup,
   * and is the array we hand back verbatim (with the new slug appended /
   * removed) via `onChange`.
   */
  readonly customModels: ReadonlyArray<string>;
  /** Server-returned model slugs hidden from the model picker. */
  readonly hiddenModels: ReadonlyArray<string>;
  /** Model slugs favorited for this provider instance. */
  readonly favoriteModels: ReadonlyArray<string>;
  /** Explicit user-authored model ordering for this provider instance. */
  readonly modelOrder: ReadonlyArray<string>;
  /**
   * Commit the new custom-model list. Caller is responsible for routing the
   * write to the correct storage (legacy `settings.providers[kind]` vs.
   * `providerInstances[id].config`).
   */
  readonly onChange: (next: ReadonlyArray<string>) => void;
  readonly onHiddenModelsChange: (next: ReadonlyArray<string>) => void;
  readonly onFavoriteModelsChange: (next: ReadonlyArray<string>) => void;
  readonly onModelOrderChange: (next: ReadonlyArray<string>) => void;
}

/**
 * Shared "Models" section rendered on both the built-in default and custom
 * provider-instance cards. Owns its own input + error local state so two
 * cards on screen don't fight over the input value.
 *
 * Validation mirrors the pre-consolidation logic in `SettingsPanels`:
 *   - empty / whitespace → "Enter a model slug."
 *   - duplicate of a non-custom (probe-reported) slug → "already built in"
 *   - exceeds `MAX_CUSTOM_MODEL_LENGTH` → length error
 *   - duplicate of an already-saved custom slug → already-saved error
 */
export function ProviderModelsSection({
  instanceId,
  driverKind,
  models,
  customModels,
  hiddenModels,
  favoriteModels,
  modelOrder,
  onChange,
  onHiddenModelsChange,
  onFavoriteModelsChange,
  onModelOrderChange,
}: ProviderModelsSectionProps) {
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const virtualizedListRef = useRef<LegendListRef | null>(null);
  const pendingRevealSlugRef = useRef<string | null>(null);
  const hiddenModelSet = useMemo(() => new Set(hiddenModels), [hiddenModels]);
  const favoriteModelSet = useMemo(() => new Set(favoriteModels), [favoriteModels]);
  const orderedModels = useMemo(() => {
    return sortModelsForProviderInstance(models, {
      favoriteModels: favoriteModelSet,
      groupFavorites: true,
      modelOrder,
    });
  }, [favoriteModelSet, modelOrder, models]);
  const shouldVirtualizeModels = orderedModels.length > PROVIDER_MODELS_VIRTUALIZATION_THRESHOLD;
  const listRenderVersion = useMemo(
    () =>
      [favoriteModels.join("\u0000"), hiddenModels.join("\u0000"), modelOrder.join("\u0000")].join(
        "\u0001",
      ),
    [favoriteModels, hiddenModels, modelOrder],
  );

  const handleAdd = () => {
    const normalized = driverKind ? normalizeModelSlug(input, driverKind) : input.trim() || null;
    if (!normalized) {
      setError("Enter a model slug.");
      return;
    }
    if (models.some((model) => !model.isCustom && model.slug === normalized)) {
      setError("That model is already built in.");
      return;
    }
    if (normalized.length > MAX_CUSTOM_MODEL_LENGTH) {
      setError(`Model slugs must be ${MAX_CUSTOM_MODEL_LENGTH} characters or less.`);
      return;
    }
    if (customModels.includes(normalized)) {
      setError("That custom model is already saved.");
      return;
    }

    pendingRevealSlugRef.current = normalized;
    onChange([...customModels, normalized]);
    setInput("");
    setError(null);
  };

  const handleRemove = (slug: string) => {
    onChange(customModels.filter((model) => model !== slug));
    onModelOrderChange(modelOrder.filter((model) => model !== slug));
    onFavoriteModelsChange(favoriteModels.filter((model) => model !== slug));
    setError(null);
  };

  const handleToggleHidden = (slug: string) => {
    if (hiddenModelSet.has(slug)) {
      onHiddenModelsChange(hiddenModels.filter((model) => model !== slug));
      return;
    }
    onHiddenModelsChange([...hiddenModels, slug]);
  };

  const handleToggleFavorite = (slug: string) => {
    if (favoriteModelSet.has(slug)) {
      onFavoriteModelsChange(favoriteModels.filter((model) => model !== slug));
      return;
    }
    onFavoriteModelsChange([...favoriteModels, slug]);
  };

  const handleMove = (slug: string, direction: -1 | 1) => {
    const slugs = orderedModels.map((model) => model.slug);
    const index = slugs.indexOf(slug);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= slugs.length) {
      return;
    }
    const next = [...slugs];
    [next[index], next[nextIndex]] = [next[nextIndex]!, next[index]!];
    onModelOrderChange(next);
  };

  useEffect(() => {
    const pendingSlug = pendingRevealSlugRef.current;
    if (!pendingSlug) return;

    const index = orderedModels.findIndex((model) => model.slug === pendingSlug);
    if (index < 0) return;

    pendingRevealSlugRef.current = null;
    requestAnimationFrame(() => {
      if (shouldVirtualizeModels) {
        virtualizedListRef.current?.scrollIndexIntoView?.({ index, animated: true });
        return;
      }
      listRef.current
        ?.querySelector<HTMLElement>(`[data-provider-model-slug="${CSS.escape(pendingSlug)}"]`)
        ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  }, [orderedModels, shouldVirtualizeModels]);

  const renderModelRow = (model: ServerProviderModel, index: number) => {
    const caps = model.capabilities;
    const capLabels: string[] = [];
    const isHidden = !model.isCustom && hiddenModelSet.has(model.slug);
    const isFavorite = favoriteModelSet.has(model.slug);
    const previousModel = orderedModels[index - 1];
    const nextModel = orderedModels[index + 1];
    const canMoveUp =
      previousModel !== undefined && favoriteModelSet.has(previousModel.slug) === isFavorite;
    const canMoveDown =
      nextModel !== undefined && favoriteModelSet.has(nextModel.slug) === isFavorite;
    const descriptors = caps?.optionDescriptors ?? [];
    if (descriptors.some((descriptor) => descriptor.id === "fastMode")) {
      capLabels.push("Fast mode");
    }
    if (descriptors.some((descriptor) => descriptor.id === "thinking")) {
      capLabels.push("Thinking");
    }
    if (
      descriptors.some(
        (descriptor) =>
          descriptor.type === "select" &&
          (descriptor.id === "reasoningEffort" ||
            descriptor.id === "effort" ||
            descriptor.id === "reasoning" ||
            descriptor.id === "variant"),
      )
    ) {
      capLabels.push("Reasoning");
    }
    const hasDetails = capLabels.length > 0 || model.name !== model.slug;

    return (
      <div
        key={`${instanceId}:${model.slug}`}
        data-provider-model-slug={model.slug}
        className={cn(
          "grid min-h-8 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-2 py-1",
          index > 0 && "border-t border-border/40",
          isHidden && "text-muted-foreground",
        )}
      >
        <div className="flex min-w-0 items-center gap-1">
          <span
            className={cn(
              "min-w-0 truncate text-xs",
              isHidden ? "text-muted-foreground line-through" : "text-foreground/90",
            )}
          >
            {model.name}
          </span>
          {hasDetails ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="size-5 rounded-sm p-0 text-muted-foreground/60 hover:text-muted-foreground"
                    aria-label={`Details for ${model.name}`}
                  />
                }
              >
                <InfoIcon className="size-3" />
              </TooltipTrigger>
              <TooltipPopup side="top" className="max-w-56">
                <div className="space-y-1">
                  <code className="block text-[11px] text-foreground">{model.slug}</code>
                  {capLabels.length > 0 ? (
                    <div className="flex flex-wrap gap-x-2 gap-y-0.5">
                      {capLabels.map((label) => (
                        <span key={label} className="text-[10px] text-muted-foreground">
                          {label}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
              </TooltipPopup>
            </Tooltip>
          ) : null}
          {isHidden ? <span className="text-[10px] text-muted-foreground">hidden</span> : null}
          {model.isCustom ? (
            <span className="text-[10px] text-muted-foreground">custom</span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className={cn(
                    "size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground",
                    isFavorite && "text-yellow-500 hover:text-yellow-600",
                  )}
                  onClick={() => handleToggleFavorite(model.slug)}
                  aria-label={`${isFavorite ? "Remove" : "Add"} ${model.name} ${
                    isFavorite ? "from" : "to"
                  } favorites`}
                />
              }
            >
              <StarIcon className={cn("size-3", isFavorite && "fill-current")} />
            </TooltipTrigger>
            <TooltipPopup side="top">
              {isFavorite ? "Remove from favorites" : "Add to favorites"}
            </TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                  disabled={!canMoveUp}
                  onClick={() => handleMove(model.slug, -1)}
                  aria-label={`Move ${model.name} up`}
                />
              }
            >
              <ArrowUpIcon className="size-3" />
            </TooltipTrigger>
            <TooltipPopup side="top">Move up</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                  disabled={!canMoveDown}
                  onClick={() => handleMove(model.slug, 1)}
                  aria-label={`Move ${model.name} down`}
                />
              }
            >
              <ArrowDownIcon className="size-3" />
            </TooltipTrigger>
            <TooltipPopup side="top">Move down</TooltipPopup>
          </Tooltip>
          {!model.isCustom ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                    onClick={() => handleToggleHidden(model.slug)}
                    aria-label={`${isHidden ? "Show" : "Hide"} ${model.name}`}
                  />
                }
              >
                {isHidden ? <EyeIcon className="size-3" /> : <EyeOffIcon className="size-3" />}
              </TooltipTrigger>
              <TooltipPopup side="top">
                {isHidden ? "Show in picker" : "Hide from picker"}
              </TooltipPopup>
            </Tooltip>
          ) : null}
          {model.isCustom ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                    aria-label={`Remove ${model.slug}`}
                    onClick={() => handleRemove(model.slug)}
                  />
                }
              >
                <XIcon className="size-3" />
              </TooltipTrigger>
              <TooltipPopup side="top">Remove custom model</TooltipPopup>
            </Tooltip>
          ) : null}
        </div>
      </div>
    );
  };

  return (
    <div className="border-t border-border/60 px-4 py-3 sm:px-5">
      <div className="text-xs font-medium text-foreground">Models</div>
      <div className="mt-1 text-xs text-muted-foreground">
        {models.length} model{models.length === 1 ? "" : "s"} available.
      </div>
      {shouldVirtualizeModels ? (
        <div className="mt-2 overflow-hidden rounded-md border border-border/50 bg-muted/15">
          <LegendList<ServerProviderModel>
            ref={virtualizedListRef}
            data={orderedModels}
            dataVersion={listRenderVersion}
            extraData={listRenderVersion}
            keyExtractor={(model) => `${instanceId}:${model.slug}`}
            renderItem={({ item, index }) => renderModelRow(item, index)}
            estimatedItemSize={PROVIDER_MODELS_ESTIMATED_ROW_HEIGHT}
            drawDistance={PROVIDER_MODELS_LIST_MAX_HEIGHT}
            style={{ maxHeight: PROVIDER_MODELS_LIST_MAX_HEIGHT }}
          />
        </div>
      ) : (
        <div
          ref={listRef}
          className="mt-2 max-h-64 overflow-y-auto rounded-md border border-border/50 bg-muted/15"
        >
          {orderedModels.map((model, index) => renderModelRow(model, index))}
        </div>
      )}

      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <Input
          id={`provider-instance-${instanceId}-custom-model`}
          value={input}
          onChange={(event) => {
            setInput(event.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            handleAdd();
          }}
          placeholder={driverKind ? CUSTOM_MODEL_PLACEHOLDER_BY_KIND[driverKind] : "model-slug"}
          spellCheck={false}
        />
        <Button className="shrink-0" variant="outline" onClick={handleAdd}>
          <PlusIcon className="size-3.5" />
          Add
        </Button>
      </div>

      {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
