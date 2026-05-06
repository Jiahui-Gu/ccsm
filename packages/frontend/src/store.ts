import { create } from 'zustand';
import type { WsStatus } from './ws/client';

// T6 extends the T5 placeholder. Multi-session map / scrollback / activeSid
// switching is deferred to T9/T10 (#656 / #662) — single sid is enough for MVP.
interface Store {
  token: string | null;
  sid: string | null;
  status: WsStatus;
  setSid: (sid: string | null) => void;
  setStatus: (status: WsStatus) => void;
}

export const useStore = create<Store>((set) => ({
  token:
    typeof window !== 'undefined'
      ? sessionStorage.getItem('ccsm.token')
      : null,
  sid: null,
  status: 'idle',
  setSid: (sid) => set({ sid }),
  setStatus: (status) => set({ status }),
}));
