import type { MessageBlock } from '../../types';
import { PermissionPromptBlock } from '../PermissionPromptBlock';
import { QuestionBlock } from '../QuestionBlock';
import { UserBlock } from './blocks/UserBlock';
import { AssistantBlock } from './blocks/AssistantBlock';
import { ToolBlock } from './blocks/ToolBlock';
import { TodoBlock } from './blocks/TodoBlock';
import { PlanBlock } from './blocks/PlanBlock';
import { StatusBanner } from './blocks/StatusBanner';
import { SystemTraceBlock } from './blocks/SystemTraceBlock';
import { ErrorBlock } from './blocks/ErrorBlock';

export function renderBlock(
  b: MessageBlock,
  activeId: string,
  resolvePermission: (sid: string, rid: string, d: 'allow' | 'deny') => void,
  bumpComposerFocus: () => void,
  addAllowAlways: (toolName: string) => void,
  opts: { permissionAutoFocus?: boolean; now?: number; permissionPendingToolIds?: Set<string> } = {}
) {
  switch (b.kind) {
    case 'user':
      return <UserBlock text={b.text} images={b.images} />;
    case 'assistant':
      return <AssistantBlock text={b.text} streaming={b.streaming} viaSkill={b.viaSkill} />;
    case 'tool':
      return <ToolBlock name={b.name} brief={b.brief} result={b.result} isError={b.isError} input={b.input} now={opts.now} sessionId={activeId} toolUseId={b.toolUseId} permissionPending={!!(b.toolUseId && opts.permissionPendingToolIds?.has(b.toolUseId))} />;
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
      return (
        <QuestionBlock
          questions={b.questions}
          onSubmit={(answersText) => {
            const api = window.ccsm;
            if (!api) return;
            // Two flows land here:
            //  1. can_use_tool path (SDK-era / possible future): answers the
            //     pending permission with "deny" and sends the answer as a
            //     fresh user message — slightly lossy but unblocks the turn.
            //  2. tool_use path (current claude.exe spawn): no requestId, the
            //     bogus tool_result has already landed, agent is waiting on
            //     the next user turn. Just send the answer text.
            if (b.requestId) {
              void api.agentResolvePermission(activeId, b.requestId, 'deny');
            }
            void api.agentSend(activeId, answersText);
            // Return focus to the composer so the user's next keystroke types
            // into chat instead of being eaten by the now-disabled options.
            bumpComposerFocus();
          }}
        />
      );
    case 'status':
      return <StatusBanner tone={b.tone} title={b.title} detail={b.detail} />;
    case 'system':
      return <SystemTraceBlock subkind={b.subkind} toolName={b.toolName} toolInputSummary={b.toolInputSummary} decision={b.decision} />;
    case 'error':
      return <ErrorBlock text={b.text} />;
  }
}
