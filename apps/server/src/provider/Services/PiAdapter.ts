/**
 * PiAdapter — shape type for the Pi SDK provider adapter.
 *
 * The driver model bundles one adapter per Pi provider instance as a
 * captured closure, so this module only names the per-instance shape.
 *
 * @module PiAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface PiAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
