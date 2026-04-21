import React, { useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronRight, Folder, FolderOpen, File } from 'lucide-react';
import { buildFileTree, countNodes, parseFileToolResult, type FileTreeNode } from '../utils/file-tree';

interface FileTreeProps {
  /**
   * Either the raw tool-result string from Glob/LS, or a pre-parsed list of
   * paths. The string overload is the common path; the array overload exists
   * for tests and any future caller that already has structured paths.
   */
  source: string | string[];
  /** Override default expand-on-mount heuristic. */
  defaultExpanded?: boolean;
  /** Callback when a file row is activated (click or Enter). */
  onSelect?: (path: string) => void;
}

const SHALLOW_THRESHOLD = 20;

export function FileTree({ source, defaultExpanded, onSelect }: FileTreeProps) {
  const tree = useMemo(() => {
    const paths = typeof source === 'string' ? parseFileToolResult(source) : source;
    return buildFileTree(paths);
  }, [source]);

  const initialOpen = useMemo(() => {
    if (defaultExpanded !== undefined) return defaultExpanded;
    return countNodes(tree) <= SHALLOW_THRESHOLD;
  }, [tree, defaultExpanded]);

  if (tree.length === 0) {
    return (
      <div className="mt-1 ml-6 pl-3 border-l border-border-subtle font-mono text-xs text-fg-tertiary">
        (no files)
      </div>
    );
  }

  return (
    <div
      role="tree"
      aria-label="File tree"
      className="mt-1 ml-6 pl-2 border-l border-border-subtle font-mono text-xs text-fg-secondary"
    >
      {tree.map((node) => (
        <TreeRow
          key={node.path || node.name}
          node={node}
          depth={0}
          initiallyOpen={initialOpen}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

interface TreeRowProps {
  node: FileTreeNode;
  depth: number;
  initiallyOpen: boolean;
  onSelect?: (path: string) => void;
}

function TreeRow({ node, depth, initiallyOpen, onSelect }: TreeRowProps) {
  const [open, setOpen] = useState(initiallyOpen);

  if (node.isDir) {
    return (
      <div role="treeitem" aria-expanded={open} className="select-none">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="group flex items-center gap-1 w-full text-left px-1 py-[1px] rounded-sm text-fg-secondary hover:bg-bg-hover hover:text-fg-primary active:bg-bg-active transition-colors duration-100 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-border-strong"
          style={{ paddingLeft: depth * 10 + 4 }}
        >
          <motion.span
            initial={false}
            animate={{ rotate: open ? 90 : 0 }}
            transition={{ duration: 0.15, ease: [0, 0, 0.2, 1] }}
            className="inline-flex shrink-0"
            aria-hidden
          >
            <ChevronRight size={11} className="stroke-[1.75]" />
          </motion.span>
          {open ? (
            <FolderOpen size={12} className="shrink-0 text-fg-tertiary group-hover:text-fg-secondary" aria-hidden />
          ) : (
            <Folder size={12} className="shrink-0 text-fg-tertiary group-hover:text-fg-secondary" aria-hidden />
          )}
          <span className="truncate">{node.name}/</span>
          <span className="ml-1 text-fg-tertiary text-[10px]">
            {node.children.length}
          </span>
        </button>
        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              key="kids"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.15, ease: [0, 0, 0.2, 1] }}
              style={{ overflow: 'hidden' }}
            >
              {node.children.map((child) => (
                <TreeRow
                  key={child.path || child.name}
                  node={child}
                  depth={depth + 1}
                  initiallyOpen={initiallyOpen}
                  onSelect={onSelect}
                />
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    );
  }

  return (
    <div role="treeitem" className="select-none">
      <button
        type="button"
        onClick={() => {
          if (onSelect) onSelect(node.path);
          else {
            // Follow-up: wire through IPC ("reveal in editor"). For v0.1
            // keep the dispatch site here so wiring is one-line later.
            console.log('[FileTree] reveal:', node.path);
          }
        }}
        className="group flex items-center gap-1 w-full text-left px-1 py-[1px] rounded-sm text-fg-tertiary hover:bg-bg-hover hover:text-fg-primary active:bg-bg-active transition-colors duration-100 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-border-strong"
        style={{ paddingLeft: depth * 10 + 4 + 12 }}
        title={node.path}
      >
        <File size={12} className="shrink-0 text-fg-tertiary group-hover:text-fg-secondary" aria-hidden />
        <span className="truncate">{node.name}</span>
      </button>
    </div>
  );
}
