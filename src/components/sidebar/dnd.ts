// Cross-group DnD uses three drop-target id flavors via closestCenter:
//   - session id            → insert before that session
//   - group id              → append to empty SortableContext (only when open)
//   - `header:<groupId>`    → append to that group (works even if collapsed,
//                             and drives hover-to-expand on collapsed groups)
export const HEADER_PREFIX = 'header:';

export const headerDroppableId = (groupId: string) =>
  `${HEADER_PREFIX}${groupId}`;

export const parseHeaderDroppable = (id: string) =>
  id.startsWith(HEADER_PREFIX) ? id.slice(HEADER_PREFIX.length) : null;
