// Adaptive Toast XML for the Done (run completed) notification type.
//
// Layout:
//   title:        "{groupName} · {sessionName}"
//   text 1:       "> {lastUserMsg}"             (truncated ~50 chars)
//   text 2:       "{lastAssistantMsg}"          (truncated ~80 chars)
//   attribution:  "{elapsed} · {toolCount} tools · {cwdBasename}"
//   actions:      none — body click focuses the app

import type { DonePayload } from '../types';
import { truncate } from '../util/truncate';
import {
  appLogoElement,
  audioElement,
  buildActionArgs,
  xmlEscape,
  type XmlBuildOptions,
} from './common';

const TITLE_MAX = 80;
const USER_LINE_MAX = 50;
const ASSISTANT_LINE_MAX = 80;

/** Format ms as a compact duration: 850ms / 42s / 7m 5s / 1h 3m. */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  const remSec = totalSec % 60;
  if (totalMin < 60) {
    return remSec === 0 ? `${totalMin}m` : `${totalMin}m ${remSec}s`;
  }
  const hours = Math.floor(totalMin / 60);
  const remMin = totalMin % 60;
  return remMin === 0 ? `${hours}h` : `${hours}h ${remMin}m`;
}

export function buildDoneXml(
  payload: DonePayload,
  opts: XmlBuildOptions = {},
): string {
  const title = truncate(
    `${payload.groupName} · ${payload.sessionName}`,
    TITLE_MAX,
  ).text;
  const userLine = truncate(payload.lastUserMsg, USER_LINE_MAX);
  // The "> " prefix is part of the visual contract; it sits outside the
  // truncation budget so the marker is never lost to the ellipsis.
  const userText = `> ${userLine.text}`;
  const assistantLine = truncate(payload.lastAssistantMsg, ASSISTANT_LINE_MAX).text;
  const attribution = `${formatElapsed(payload.elapsedMs)} · ${payload.toolCount} tools · ${payload.cwdBasename}`;

  const launchArgs = buildActionArgs({
    action: 'focus',
    toastId: payload.toastId,
  });

  return [
    `<toast launch="${xmlEscape(launchArgs)}" activationType="foreground">`,
    '<visual>',
    '<binding template="ToastGeneric">',
    `<text>${xmlEscape(title)}</text>`,
    `<text>${xmlEscape(userText)}</text>`,
    `<text>${xmlEscape(assistantLine)}</text>`,
    `<text placement="attribution">${xmlEscape(attribution)}</text>`,
    appLogoElement(opts.iconPath),
    '</binding>',
    '</visual>',
    audioElement(opts.silent),
    '</toast>',
  ].join('');
}
