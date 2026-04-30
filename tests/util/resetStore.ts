// Tech-debt R6 (Task #802) — shared store reset helper.
//
// Several test files used to capture `useStore.getState()` at module scope
// and then call `useStore.setState({ ...initial, ...overrides }, true)` in
// beforeEach. The module-scope capture is fragile (load order, vi.mock
// hoisting) and the pattern was duplicated across 3+ files. This helper
// centralises both:
//
//   - we snapshot the *pristine* initial state once at module load (this
//     module is imported lazily from each test, but the snapshot is taken
//     before any test mutates the store), and
//   - we expose a single `resetStore(overrides?)` that callers use inside
//     beforeEach to fully replace the store with `{ ...initial, ...overrides }`.
//
// The `true` flag on setState is the zustand "replace" mode — it wipes any
// keys not present in the patch, which is what tests want for isolation.
import { useStore } from '../../src/stores/store';

const initial = useStore.getState();

export function resetStore(
  overrides: Partial<ReturnType<typeof useStore.getState>> = {}
): void {
  useStore.setState({ ...initial, ...overrides }, true);
}
