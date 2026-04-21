import React from 'react';
import { ChevronDown, Folder } from 'lucide-react';
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

type ModelId = 'claude-opus-4' | 'claude-sonnet-4' | 'claude-haiku-4';
type PermissionMode = 'plan' | 'ask' | 'auto' | 'yolo';

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
  | { kind: 'separator' };

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
      <DropdownMenuContent side="top" align="start" className="min-w-[240px]">
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        {options.map((o, i) => {
          if (o.kind === 'separator') return <DropdownMenuSeparator key={`sep-${i}`} />;
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

const modelOptions: ChipOption<ModelId>[] = [
  { kind: 'item', value: 'claude-opus-4', primary: 'opus-4', secondary: 'Most capable, slower and pricier' },
  { kind: 'item', value: 'claude-sonnet-4', primary: 'sonnet-4', secondary: 'Balanced — recommended default' },
  { kind: 'item', value: 'claude-haiku-4', primary: 'haiku-4', secondary: 'Fastest and cheapest, lower quality' }
];

// Labels describe what claude.exe actually does per mode. There is no CLI
// setting that prompts on every single tool — reads are always auto-approved
// below `bypassPermissions` and above `plan`. The chip wording reflects that
// instead of promising behaviour the CLI can't deliver.
const permissionOptions: ChipOption<PermissionMode>[] = [
  { kind: 'item', value: 'plan', primary: 'plan', secondary: 'Plan only — no edits or commands' },
  { kind: 'item', value: 'ask', primary: 'standard', secondary: 'Auto-approve reads; ask before writes, edits, and shell' },
  { kind: 'item', value: 'auto', primary: 'auto', secondary: 'Auto-approve reads and edits; ask before shell' },
  { kind: 'item', value: 'yolo', primary: 'yolo', secondary: 'Auto-approve everything (use with care)' }
];

const permissionTooltips: Record<PermissionMode, string> = {
  plan: 'Plan mode — agent drafts a plan; no file edits or shell until you approve',
  ask: 'Standard — reads auto-approved; writes, edits, and shell require confirmation',
  auto: 'Auto-accept edits — reads and file edits auto-approved; shell requires confirmation',
  yolo: 'Bypass all permission checks — every tool call runs without asking'
};

function primaryOf<V extends string>(options: ChipOption<V>[], value: V): string {
  for (const o of options) {
    if (o.kind === 'item' && o.value === value) return o.primary;
  }
  return value;
}

export type StatusBarProps = {
  cwd: string;
  model: ModelId;
  permission: PermissionMode;
  onChangeCwd: (cwd: string | null) => void;
  onChangeModel: (model: ModelId) => void;
  onChangePermission: (mode: PermissionMode) => void;
};

export function StatusBar({
  cwd,
  model,
  permission,
  onChangeCwd,
  onChangeModel,
  onChangePermission
}: StatusBarProps) {
  const recentProjects = useStore((s) => s.recentProjects);
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
  const chips: React.ReactNode[] = [
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
      triggerLabel={primaryOf(modelOptions, model)}
      options={modelOptions}
      onSelect={onChangeModel}
    />,
    <ChipMenu
      key="permission"
      label="Permission mode"
      triggerLabel={primaryOf(permissionOptions, permission)}
      triggerTitle={permissionTooltips[permission]}
      triggerAccent={permission === 'yolo' ? 'warn' : undefined}
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
