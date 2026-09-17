/**
 * SPINE.md — agent-maintained project architecture spine.
 *
 * Public API barrel for the spine module. Consumers import from here rather
 * than the individual files so internal details can be reorganized freely.
 *
 * @module agent/spine
 */

export {
  readSpine,
  writeSpine,
  parseSpine,
  serializeSpine,
  nextId,
  addEntry,
  findEntry,
  sectionForPrefix,
} from './spine-store.js';

export type {
  SpineDocument,
  SpineEntry,
  SpineSection,
  SpineSectionName,
  SpineIdPrefix,
} from './spine-store.js';

export {
  classifyDiff,
  classifySeedMaterial,
  parseClassifierOutput,
} from './spine-classifier.js';

export type {
  ClassifierLabel,
  ClassifierResult,
  SpineAdditionItem,
  SpineRelationItem,
  SpineClassifierItem,
} from './spine-classifier.js';

export {
  createSpineSessionEndHook,
} from './spine-hook.js';

export type {
  SpineHookOptions,
} from './spine-hook.js';
