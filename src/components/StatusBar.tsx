import React from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '../lib/cn';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from './ui/DropdownMenu';
import { useStore } from '../stores/store';
import { useTranslation } from '../i18n/useTranslation';
import { CwdPopover } from './CwdPopover';

// Permission mode values match claude.exe's `--permission-mode` flag 1:1.
// We intentionally use the official CLI names (title-cased for display)
// rather than invented shortnames like `yolo` / `standard`. The CLI also
// accepts `auto` (classifier-driven, research-preview, requires account
// enablement) and `dontAsk` (legacy alias for `default`). We omit `auto`
// from the chip to keep the picker simple and avoid exposing a mode most
// users can't enable; we omit `dontAsk` because it's redundant with
// `default`.
type PermissionMode = 'plan' | 'default' | 'acceptEdits' | 'bypassPermissions';

const Chip = React.forwardRef<
  HTMLButtonElement,
  { children: React.ReactNode; title?: string; accent?: 'warn' } & React.ButtonHTMLAttributes<HTMLButtonElement>
>(function Chip({ children, title, accent, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      title={title}
      {...rest}
      className={cn(
        'inline-flex items-center gap-1 h-5 px-1.5 rounded-sm',
        accent === 'warn'
          ? 'text-state-warning hover:text-state-warning-text hover:bg-state-warning-soft'
          : 'text-fg-tertiary hover:text-fg-secondary hover:bg-bg-hover',
        'outline-none focus-ring',
        'transition-colors duration-120 ease-out'
      )}
    >
      {children}
      <ChevronDown size={10} className="stroke-[1.75] opacity-70" />
    </button>
  );
});

type ChipOption<V extends string> =
  | {
      kind: 'item';
      value: V;
      primary: string;
      secondary?: string;
      icon?: React.ReactNode;
    }
  | { kind: 'separator' }
  | { kind: 'label'; primary: string };

type ChipMenuProps<V extends string> = {
  /** Stable id for the global popover-mutex slot. Two ChipMenu instances must
   *  not share the same id. */
  popoverId: string;
  label: string;
  triggerLabel: string;
  triggerTitle?: string;
  triggerAccent?: 'warn';
  options: ChipOption<V>[];
  onSelect: (value: V) => void;
};

function ChipMenu<V extends string>({
  popoverId,
  label,
  triggerLabel,
  triggerTitle,
  triggerAccent,
  options,
  onSelect
}: ChipMenuProps<V>) {
  // Bind Radix's controlled `open` to the global mutex slot so opening any
  // other popover (or another ChipMenu) auto-closes this one. Radix would
  // otherwise own its open state internally and never react to a sibling's
  // openPopoverId change.
  const open = useStore((s) => s.openPopoverId === popoverId);
  const openPopover = useStore((s) => s.openPopover);
  const closePopover = useStore((s) => s.closePopover);
  return (
    <DropdownMenu
      open={open}
      // Non-modal: clicks on other StatusBar chips (cwd, sibling chip) must
      // reach their triggers and route through the global popover mutex —
      // the default modal=true installs a pointer-events guard on <body> that
      // blocks every click outside the menu, breaking cross-popover dismiss.
      modal={false}
      onOpenChange={(next) => {
        if (next) openPopover(popoverId);
        else closePopover(popoverId);
      }}
    >
      <DropdownMenuTrigger asChild>
        <Chip title={triggerTitle} accent={triggerAccent}>{triggerLabel}</Chip>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="min-w-[240px] max-h-[360px] overflow-y-auto">
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        {options.map((o, i) => {
          if (o.kind === 'separator') return <DropdownMenuSeparator key={`sep-${i}`} />;
          if (o.kind === 'label') {
            return (
              <DropdownMenuLabel key={`lbl-${i}`} className="pt-2">
                {o.primary}
              </DropdownMenuLabel>
            );
          }
          if (o.secondary) {
            return (
              <DropdownMenuItem
                key={o.value}
                onSelect={() => onSelect(o.value)}
                className="flex-col items-start gap-0 h-auto py-1.5"
              >
                <span className="truncate w-full text-fg-primary">{o.primary}</span>
                <span className="truncate w-full text-mono-sm font-mono text-fg-tertiary leading-tight">
                  {o.secondary}
                </span>
              </DropdownMenuItem>
            );
          }
          return (
            <DropdownMenuItem key={o.value} onSelect={() => onSelect(o.value)}>
              {o.icon}
              <span>{o.primary}</span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function primaryOf<V extends string>(options: ChipOption<V>[], value: V): string {
  for (const o of options) {
    if (o.kind === 'item' && o.value === value) return o.primary;
  }
  return value;
}

export type StatusBarProps = {
  cwd: string;
  cwdMissing?: boolean;
  model: string;
  permission: PermissionMode;
  onChangeCwdToPath: (cwd: string) => void;
  onBrowseForCwd: () => void;
  onChangeModel: (model: string) => void;
  onChangePermission: (mode: PermissionMode) => void;
};

export function StatusBar({
  cwd,
  cwdMissing,
  model,
  permission,
  onChangeCwdToPath,
  onBrowseForCwd,
  onChangeModel,
  onChangePermission
}: StatusBarProps) {
  const { t } = useTranslation();
  const models = useStore((s) => s.models);
  const modelsLoaded = useStore((s) => s.modelsLoaded);

  // Labels describe what claude.exe actually does per mode. The underlying
  // VALUES (default / acceptEdits / plan / bypassPermissions) are CLI argv
  // and remain in English everywhere — only labels/tooltips are localized.
  const permissionOptions: ChipOption<PermissionMode>[] = [
    { kind: 'item', value: 'plan', primary: t('statusBar.modePlanLabel'), secondary: t('statusBar.modePlanDesc') },
    { kind: 'item', value: 'default', primary: t('statusBar.modeDefaultLabel'), secondary: t('statusBar.modeDefaultDesc') },
    { kind: 'item', value: 'acceptEdits', primary: t('statusBar.modeAcceptEditsLabel'), secondary: t('statusBar.modeAcceptEditsDesc') },
    { kind: 'item', value: 'bypassPermissions', primary: t('statusBar.modeBypassLabel'), secondary: t('statusBar.modeBypassDesc') }
  ];

  const permissionTooltips: Record<PermissionMode, string> = {
    plan: t('statusBar.modePlanTooltip'),
    default: t('statusBar.modeDefaultTooltip'),
    acceptEdits: t('statusBar.modeAcceptEditsTooltip'),
    bypassPermissions: t('statusBar.modeBypassTooltip')
  };

  const cwdChip = (
    <CwdPopover
      key="cwd"
      cwd={cwd}
      cwdMissing={cwdMissing}
      onPick={onChangeCwdToPath}
      onBrowse={onBrowseForCwd}
    />
  );

  // Flat model list discovered from ~/.claude/settings.json (+ env). No
  // grouping — there is exactly one connection.
  const modelOptions: ChipOption<string>[] = [];
  if (!modelsLoaded) {
    modelOptions.push({ kind: 'label', primary: t('statusBar.loading') });
  } else if (models.length === 0) {
    modelOptions.push({ kind: 'label', primary: t('statusBar.noModelsHint') });
  } else {
    for (const m of models) {
      modelOptions.push({ kind: 'item', value: m.id, primary: m.id });
    }
  }

  // Render the trigger as the model id, else a friendly placeholder.
  const modelTriggerLabel = model || t('statusBar.pickModel');

  const chips: React.ReactNode[] = [
    cwdChip,
    <ChipMenu
      key="model"
      popoverId="model"
      label={t('statusBar.model')}
      triggerLabel={modelTriggerLabel}
      options={modelOptions}
      onSelect={onChangeModel}
    />,
    <ChipMenu
      key="permission"
      popoverId="permission"
      label={t('statusBar.permissionMode')}
      triggerLabel={primaryOf(permissionOptions, permission)}
      triggerTitle={permissionTooltips[permission]}
      triggerAccent={permission === 'bypassPermissions' ? 'warn' : undefined}
      options={permissionOptions}
      onSelect={onChangePermission}
    />
  ];

  return (
    <div data-type-scale-role="status-bar" className="h-6 px-4 pt-0.5 flex items-center gap-1 font-mono text-meta">
      {chips.map((c, i) => (
        <React.Fragment key={i}>
          {i > 0 ? <span className="text-fg-disabled px-1">·</span> : null}
          {c}
        </React.Fragment>
      ))}
    </div>
  );
}
