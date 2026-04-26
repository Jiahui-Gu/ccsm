// Adaptive Toast XML for the Permission notification type.
//
// Layout:
//   title:        "Permission needed · {sessionName}"
//   text 1:       "{toolName} · {toolBrief}"   (truncated ~60 chars)
//   attribution:  "cwd: {cwdBasename}"
//   actions:      Allow / Allow always / Reject

import type { PermissionPayload } from '../types';
import { truncate } from '../util/truncate';
import {
  appLogoElement,
  audioElement,
  buildActionArgs,
  xmlEscape,
  type XmlBuildOptions,
} from './common';

const TITLE_MAX = 80;
const BODY_MAX = 60;

export function buildPermissionXml(
  payload: PermissionPayload,
  opts: XmlBuildOptions = {},
): string {
  const title = truncate(
    `Permission needed · ${payload.sessionName}`,
    TITLE_MAX,
  ).text;
  const body = truncate(
    `${payload.toolName} · ${payload.toolBrief}`,
    BODY_MAX,
  ).text;
  const attribution = `cwd: ${payload.cwdBasename}`;

  const launchArgs = buildActionArgs({
    action: 'focus',
    toastId: payload.toastId,
  });
  const allowArgs = buildActionArgs({
    action: 'allow',
    toastId: payload.toastId,
  });
  const allowAlwaysArgs = buildActionArgs({
    action: 'allow-always',
    toastId: payload.toastId,
    tool: payload.toolName,
  });
  const rejectArgs = buildActionArgs({
    action: 'reject',
    toastId: payload.toastId,
  });

  return [
    `<toast launch="${xmlEscape(launchArgs)}" activationType="foreground">`,
    '<visual>',
    '<binding template="ToastGeneric">',
    `<text>${xmlEscape(title)}</text>`,
    `<text>${xmlEscape(body)}</text>`,
    `<text placement="attribution">${xmlEscape(attribution)}</text>`,
    appLogoElement(opts.iconPath),
    '</binding>',
    '</visual>',
    '<actions>',
    `<action content="Allow" arguments="${xmlEscape(allowArgs)}" activationType="background"/>`,
    `<action content="Allow always" arguments="${xmlEscape(allowAlwaysArgs)}" activationType="background"/>`,
    `<action content="Reject" arguments="${xmlEscape(rejectArgs)}" activationType="foreground"/>`,
    '</actions>',
    audioElement(opts.silent),
    '</toast>',
  ].join('');
}
