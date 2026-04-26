// Public API surface for the inlined notify module.
//
// Originally vendored from the standalone `@ccsm/notify` package (v0.1.1).
// Kept as a self-contained module under `electron/notify-impl/` so it can be
// extracted again later if it ever needs to ship as a separate package.

export { Notifier } from './notifier';
export { ToastRegistry } from './registry';
export { truncate, codePointLength } from './util/truncate';
export { buildPermissionXml } from './xml/permission';
export { buildQuestionXml } from './xml/question';
export { buildDoneXml, formatElapsed } from './xml/done';
export {
  buildActionArgs,
  parseActionArgs,
  xmlEscape,
} from './xml/common';

export type {
  ActionArgs,
  ActionEvent,
  ActionId,
  DonePayload,
  NotifierOptions,
  PermissionPayload,
  QuestionPayload,
} from './types';

export type { TruncateResult } from './util/truncate';
export type { PlatformAdapter } from './platform/windows';
export type { ToastCallback } from './registry';
export type { XmlBuildOptions } from './xml/common';
