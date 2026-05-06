import { useState } from 'react';

const notImplemented = (): void => {
  // Placeholder for T6/T9 wiring; alert keeps the click loop visibly intact.
  alert('not implemented');
};

const notWiredYet = (): void => {
  alert('not wired (T6)');
};

export function Sidebar() {
  const [archivedExpanded, setArchivedExpanded] = useState(false);

  return (
    <div className="sidebar">
      {/* Zone 1 — top: New Session + Search */}
      <div className="sidebar__top">
        <button
          type="button"
          className="sidebar__btn sidebar__btn--primary"
          data-testid="sidebar-new-session"
          onClick={notWiredYet}
        >
          + New Session
        </button>
        <button
          type="button"
          className="sidebar__btn sidebar__btn--icon"
          data-testid="sidebar-search"
          aria-label="Search sessions"
          onClick={notImplemented}
        >
          {'\u{1F50D}'}
        </button>
      </div>

      {/* Zone 2 — middle: GROUPS list (placeholder until T9) */}
      <div
        className="sidebar__groups"
        data-testid="sidebar-groups"
      >
        <div className="sidebar__groups-header">
          <span className="sidebar__groups-label">GROUPS</span>
          <button
            type="button"
            className="sidebar__btn sidebar__btn--icon"
            aria-label="Add group"
            onClick={notImplemented}
          >
            +
          </button>
        </div>
        <div className="sidebar__groups-empty">
          No sessions yet — click + New Session above
        </div>
      </div>

      {/* Zone 3 — Archived collapsible */}
      <div className="sidebar__archived">
        <button
          type="button"
          className="sidebar__archived-toggle"
          data-testid="sidebar-archived"
          aria-expanded={archivedExpanded}
          onClick={() => setArchivedExpanded((v) => !v)}
        >
          {archivedExpanded ? '▾' : '▸'} Archived
        </button>
        {archivedExpanded && (
          <div className="sidebar__archived-body">no archived groups</div>
        )}
      </div>

      {/* Zone 4 — bottom: Settings + Import */}
      <div className="sidebar__bottom">
        <button
          type="button"
          className="sidebar__btn sidebar__btn--primary"
          data-testid="sidebar-settings"
          onClick={notImplemented}
        >
          {'⚙'} Settings
        </button>
        <button
          type="button"
          className="sidebar__btn sidebar__btn--icon"
          data-testid="sidebar-import"
          aria-label="Import"
          onClick={notImplemented}
        >
          {'⬇'}
        </button>
      </div>
    </div>
  );
}
