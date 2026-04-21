import React from 'react';
import { ChevronDown, Folder, GitBranch } from 'lucide-react';
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

// Permission mode values match claude.exe's `--permission-mode` flag 1:1.
// We intentionally use the official CLI names (title-cased for display)
// rather than invented shortnames like `yolo` / `standard`. The CLI also
// accepts `auto` (classifier-driven, research-preview, requires account
// enablement) and `dontAsk` (legacy alias for `default`). We omit `auto`
// from the chip to keep the picker simple and avoid exposing a mode most
// users can't enable; we omit `dontAsk` because it's redundant with
// `default`.
type PermissionMode = 'plan' | 'default' | 'acceptEdits' | 'bypassPermissions';

function lastSegment(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const segs = trimmed.split(/[\\/]/).filter(Boolean);
  return segs[segs.length - 1] ?? path;
}

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
          ? 'text-state-warning hover:text-status-warning-foreground hover:bg-status-warning-muted'
          : 'text-fg-tertiary hover:text-fg-secondary hover:bg-bg-hover',
        'outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-border-strong',
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
  label: string;
  triggerLabel: string;
  triggerTitle?: string;
  triggerAccent?: 'warn';
  options: ChipOption<V>[];
  onSelect: (value: V) => void;
};

function ChipMenu<V extends string>({
  label,
  triggerLabel,
  triggerTitle,
  triggerAccent,
  options,
  onSelect
}: ChipMenuProps<V>) {
  return (
    <DropdownMenu>
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
                <span className="truncate w-full text-[11px] font-mono text-fg-tertiary leading-tight">
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

const BROWSE_FOLDER = '__browse__';

// Labels describe what claude.exe actually does per mode, and the `primary`
// string is the official CLI flag value title-cased. `default` prompts before
// any tool use that isn't a read; reads are auto-approved. `acceptEdits` adds
// file-edit auto-approval on top. `bypassPermissions` skips every check.
const permissionOptions: ChipOption<PermissionMode>[] = [
  { kind: 'item', value: 'plan', primary: 'Plan', secondary: 'Read-only analysis. No edits, no shell.' },
  { kind: 'item', value: 'default', primary: 'Default', secondary: 'Auto-approve reads. Ask before edits and shell.' },
  { kind: 'item', value: 'acceptEdits', primary: 'Accept Edits', secondary: 'Auto-approve reads and edits. Ask before shell.' },
  { kind: 'item', value: 'bypassPermissions', primary: 'Bypass Permissions', secondary: 'Auto-approve everything. Use with care.' }
];

const permissionTooltips: Record<PermissionMode, string> = {
  plan: 'Plan mode — read-only analysis; no file edits or shell until you approve.',
  default: 'Default — auto-approve reads; ask before edits and shell.',
  acceptEdits: 'Accept Edits — auto-approve reads and file edits; ask before shell.',
  bypassPermissions: 'Bypass Permissions — every tool call runs without asking. Use with care.'
};

function primaryOf<V extends string>(options: ChipOption<V>[], value: V): string {
  for (const o of options) {
    if (o.kind === 'item' && o.value === value) return o.primary;
  }
  return value;
}

export type StatusBarProps = {
  cwd: string;
  model: string;
  permission: PermissionMode;
  /** Worktree branch name to surface alongside cwd, when the active session
   *  was spawned inside a git worktree. Undefined hides the pill entirely. */
  worktreeName?: string;
  onChangeCwd: (cwd: string | null) => void;
  onChangeModel: (model: string) => void;
  onChangePermission: (mode: PermissionMode) => void;
};

export function StatusBar({
  cwd,
  model,
  permission,
  worktreeName,
  onChangeCwd,
  onChangeModel,
  onChangePermission
}: StatusBarProps) {
  const recentProjects = useStore((s) => s.recentProjects);
  const endpoints = useStore((s) => s.endpoints);
  const modelsByEndpoint = useStore((s) => s.modelsByEndpoint);
  const endpointsLoaded = useStore((s) => s.endpointsLoaded);

  const cwdOptions: ChipOption<string>[] = [
    ...recentProjects.map(
      (p) =>
        ({ kind: 'item', value: p.path, primary: p.name, secondary: p.path }) as ChipOption<string>
    ),
    ...(recentProjects.length > 0
      ? ([{ kind: 'separator' }] as ChipOption<string>[])
      : []),
    {
      kind: 'item',
      value: BROWSE_FOLDER,
      primary: 'Browse folder…',
      icon: <Folder size={12} className="stroke-[1.75] mr-2 text-fg-tertiary" />
    }
  ];

  // Build the grouped model option list: one `label` row per endpoint,
  // followed by that endpoint's discovered models, separated between groups.
  const modelOptions: ChipOption<string>[] = [];
  if (!endpointsLoaded) {
    modelOptions.push({ kind: 'label', primary: 'Loading…' });
  } else if (endpoints.length === 0) {
    modelOptions.push({ kind: 'label', primary: 'No endpoints configured' });
  } else {
    endpoints.forEach((e, idx) => {
      if (idx > 0) modelOptions.push({ kind: 'separator' });
      modelOptions.push({
        kind: 'label',
        primary: `${e.name}${e.isDefault ? ' (default)' : ''}`
      });
      const models = modelsByEndpoint[e.id] ?? [];
      if (models.length === 0) {
        modelOptions.push({
          kind: 'label',
          primary: e.lastStatus === 'error' ? e.lastError ?? 'Error' : 'No models yet — click Refresh in Settings'
        });
      } else {
        for (const m of models) {
          modelOptions.push({
            kind: 'item',
            value: m.modelId,
            primary: m.displayName ?? m.modelId,
            secondary: m.displayName ? m.modelId : undefined
          });
        }
      }
    });
  }

  // Render the trigger as the model's display name when known, else its id,
  // else a friendly placeholder.
  let modelTriggerLabel = model || '(pick model)';
  for (const list of Object.values(modelsByEndpoint)) {
    const found = list.find((m) => m.modelId === model);
    if (found) {
      modelTriggerLabel = found.displayName ?? found.modelId;
      break;
    }
  }

  const chips: React.ReactNode[] = [
    ...(worktreeName
      ? [
          <span
            key="worktree"
            title={`Worktree branch: ${worktreeName}`}
            data-testid="statusbar-worktree-pill"
            className={cn(
              'inline-flex items-center gap-1 h-5 px-1.5 rounded-sm',
              'text-fg-tertiary',
              'transition-colors duration-120 ease-out'
            )}
          >
            <GitBranch size={10} className="stroke-[1.75] opacity-80" aria-hidden />
            <span className="truncate max-w-[160px]">{worktreeName}</span>
          </span>
        ]
      : []),
    <ChipMenu
      key="cwd"
      label="Working directory"
      triggerLabel={lastSegment(cwd)}
      triggerTitle={cwd}
      options={cwdOptions}
      onSelect={(v) => onChangeCwd(v === BROWSE_FOLDER ? null : v)}
    />,
    <ChipMenu
      key="model"
      label="Model"
      triggerLabel={modelTriggerLabel}
      options={modelOptions}
      onSelect={onChangeModel}
    />,
    <ChipMenu
      key="permission"
      label="Permission mode"
      triggerLabel={primaryOf(permissionOptions, permission)}
      triggerTitle={permissionTooltips[permission]}
      triggerAccent={permission === 'bypassPermissions' ? 'warn' : undefined}
      options={permissionOptions}
      onSelect={onChangePermission}
    />
  ];

  return (
    <div className="h-6 px-4 pt-0.5 flex items-center gap-1 font-mono text-xs">
      {chips.map((c, i) => (
        <React.Fragment key={i}>
          {i > 0 ? <span className="text-fg-disabled px-1">·</span> : null}
          {c}
        </React.Fragment>
      ))}
    </div>
  );
}
