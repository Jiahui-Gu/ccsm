// Adaptive Toast XML for the Question notification type.
//
// Layout:
//   title:        "Question · {sessionName}"
//   text 1:       "{question}"                  (truncated ~50 chars)
//   text 2:       "{Single|Multi}-select · {n} options"
//   attribution:  "cwd: {cwdBasename}"
//   actions:      none — body click focuses the app

import type { QuestionPayload } from '../types';
import { truncate } from '../util/truncate';
import {
  appLogoElement,
  audioElement,
  buildActionArgs,
  xmlEscape,
  type XmlBuildOptions,
} from './common';

const TITLE_MAX = 80;
const QUESTION_MAX = 50;

export function buildQuestionXml(
  payload: QuestionPayload,
  opts: XmlBuildOptions = {},
): string {
  const title = truncate(
    `Question · ${payload.sessionName}`,
    TITLE_MAX,
  ).text;
  const question = truncate(payload.question, QUESTION_MAX).text;
  const kindLabel = payload.selectionKind === 'single' ? 'Single' : 'Multi';
  const subline = `${kindLabel}-select · ${payload.optionCount} options`;
  const attribution = `cwd: ${payload.cwdBasename}`;

  const launchArgs = buildActionArgs({
    action: 'focus',
    toastId: payload.toastId,
  });

  return [
    `<toast launch="${xmlEscape(launchArgs)}" activationType="foreground">`,
    '<visual>',
    '<binding template="ToastGeneric">',
    `<text>${xmlEscape(title)}</text>`,
    `<text>${xmlEscape(question)}</text>`,
    `<text>${xmlEscape(subline)}</text>`,
    `<text placement="attribution">${xmlEscape(attribution)}</text>`,
    appLogoElement(opts.iconPath),
    '</binding>',
    '</visual>',
    audioElement(opts.silent),
    '</toast>',
  ].join('');
}
