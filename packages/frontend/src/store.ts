import { create } from 'zustand';

// Minimal store for T5. T6 will extend with sessions / activeSid / ws actions.
interface Store {
  token: string | null;
}

export const useStore = create<Store>(() => ({
  token:
    typeof window !== 'undefined'
      ? sessionStorage.getItem('ccsm.token')
      : null,
}));
