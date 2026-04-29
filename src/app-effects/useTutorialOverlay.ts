import { useEffect, useState } from 'react';

export interface TutorialOverlayDeps {
  /** Persisted flag from the store: has the user seen the tutorial yet? */
  tutorialSeen: boolean;
  /** Store action invoked when the user dismisses (via skip / new / import). */
  markTutorialSeen: () => void;
}

export interface TutorialOverlayState {
  /** True when the tutorial overlay should be visible. */
  show: boolean;
  /** Hide the overlay AND mark it seen so it does not return on next mount. */
  dismiss: () => void;
}

/**
 * Drives the show/hide state of the first-run tutorial overlay rendered
 * by App.tsx. Mirrors the behaviour previously inlined in App's render —
 * the overlay is visible iff `tutorialSeen` is false, and dismissal flips
 * the persisted store flag so it does not return on the next launch.
 *
 * The hook also runs an effect that synchronizes the local `show` state
 * to the store flag (e.g. when the user resets `tutorialSeen` from
 * Settings → Help, the overlay reappears immediately without remount).
 *
 * Extracted from App.tsx for SRP under Task #724.
 */
export function useTutorialOverlay(deps: TutorialOverlayDeps): TutorialOverlayState {
  const { tutorialSeen, markTutorialSeen } = deps;
  const [show, setShow] = useState<boolean>(!tutorialSeen);

  useEffect(() => {
    setShow(!tutorialSeen);
  }, [tutorialSeen]);

  return {
    show,
    dismiss: () => {
      setShow(false);
      markTutorialSeen();
    },
  };
}
