// Web shell host config — same-origin daemon address + sessionStorage token.
//
// Wave-2 T6 (#686): @ccsm/ui's RuntimeProvider takes a HostConfig and uses
// it to construct the SessionRuntime + bind the REST API. The web shell
// always talks to the same origin (the daemon serves the bundle), so
// httpBase comes from window.location and the token comes from
// sessionStorage (main.tsx wrote it from the URL ?token= on page load).

import type { HostConfig } from '@ccsm/ui';

export const webHostConfig: HostConfig = {
  httpBase: typeof window !== 'undefined' ? window.location.origin : '',
  getToken: () => {
    if (typeof window === 'undefined') return null;
    return sessionStorage.getItem('ccsm.token');
  },
};
