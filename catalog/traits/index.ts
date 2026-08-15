/**
 * The trait registry.
 *
 * Every definition the platform computes. Adding one means adding a module
 * and a line here — a diff a reviewer can read, rather than a directory
 * scan whose contents depend on what happens to be on disk.
 */

export { ordersThirtyDays } from "./orders-30d.js";
export {
  READABLE_PROJECTIONS,
  TRAIT_TYPES,
  type TraitDefinition,
  traitDefinitionSchema,
  type TraitType,
} from "./types.js";

import { ordersThirtyDays } from "./orders-30d.js";
import type { TraitDefinition } from "./types.js";

/** Every trait, in a stable order. */
export const TRAIT_DEFINITIONS: readonly TraitDefinition[] = Object.freeze([ordersThirtyDays]);
