import type { MessageBlock } from '../../types';
import { PermissionPromptBlock } from '../PermissionPromptBlock';
import { UserBlock } from './blocks/UserBlock';
import { AssistantBlock } from './blocks/AssistantBlock';
import { ToolBlock } from './blocks/ToolBlock';
import { TodoBlock } from './blocks/TodoBlock';
import { PlanBlock } from './blocks/PlanBlock';
import { StatusBanner } from './blocks/StatusBanner';
import { SystemTraceBlock } from './blocks/SystemTraceBlock';
import { ErrorBlock } from './blocks/ErrorBlock';
import { QuestionAnsweredRow } from './blocks/QuestionAnsweredRow';

export function renderBlock(
  b: MessageBlock,
  activeId: string,
  resolvePermission: (sid: string, rid: string, d: 'allow' | 'deny') => void,
  _bumpComposerFocus: () => void,
  addAllowAlways: (toolName: string) => void,
  opts: {
    permissionAutoFocus?: boolean;
    now?: number;
    permissionPendingToolIds?: Set<string>;
    resolvePermissionPartial?: (sid: string, rid: string, acceptedHunks: number[]) => void;
  } = {}
) {
  switch (b.kind) {
    case 'user':
      return <UserBlock text={b.text} images={b.images} />;
    case 'assistant':
      return <AssistantBlock text={b.text} streaming={b.streaming} viaSkill={b.viaSkill} />;
    case 'tool':
      return <ToolBlock name={b.name} brief={b.brief} result={b.result} isError={b.isError} input={b.input} now={opts.now} sessionId={activeId} toolUseId={b.toolUseId} permissionPending={!!(b.toolUseId && opts.permissionPendingToolIds?.has(b.toolUseId))} bashPartialCommand={b.bashPartialCommand} streamingInput={b.streamingInput} />;
    case 'todo':
      return <TodoBlock todos={b.todos} />;
    case 'waiting':
      if (b.intent === 'plan' && b.plan) {
        return (
          <PlanBlock
            plan={b.plan}
            onAllow={b.requestId ? () => resolvePermission(activeId, b.requestId!, 'allow') : undefined}
            onDeny={b.requestId ? () => resolvePermission(activeId, b.requestId!, 'deny') : undefined}
          />
        );
      }
      return (
        <PermissionPromptBlock
          prompt={b.prompt}
          toolName={b.toolName}
          toolInput={b.toolInput}
          autoFocus={opts.permissionAutoFocus ?? true}
          onAllow={b.requestId ? () => resolvePermission(activeId, b.requestId!, 'allow') : undefined}
          onReject={b.requestId ? () => resolvePermission(activeId, b.requestId!, 'deny') : undefined}
          onAllowPartial={
            b.requestId && opts.resolvePermissionPartial
              ? (acceptedHunks) =>
                  opts.resolvePermissionPartial!(activeId, b.requestId!, acceptedHunks)
              : undefined
          }
          onAllowAlways={
            b.requestId && b.toolName
              ? () => {
                  addAllowAlways(b.toolName!);
                  resolvePermission(activeId, b.requestId!, 'allow');
                }
              : undefined
          }
        />
      );
    case 'question':
      // Live (unanswered) question cards no longer render in the timeline —
      // they're handled by the sticky `<QuestionStickyHost />` above the
      // composer, mirroring the upstream Claude VS Code extension's
      // permission-request placement (webview/index.js → permissionsContainer
      // host between the messages list and the inputContainer). Once the
      // user submits or rejects, we leave a compact summary row in the
      // timeline so the chat retains a scrollable record of the prompt and
      // the answer that was sent — matches upstream's "card 出队 / timeline
      // 留 ToolBlock result row" outcome.
      if (!b.answered) return null;
      return <QuestionAnsweredRow questions={b.questions} answers={b.answers} rejected={!!b.rejected} />;
    case 'status':
      return <StatusBanner tone={b.tone} title={b.title} detail={b.detail} />;
    case 'system':
      return <SystemTraceBlock subkind={b.subkind} toolName={b.toolName} toolInputSummary={b.toolInputSummary} decision={b.decision} />;
    case 'error':
      return <ErrorBlock text={b.text} />;
  }
}
