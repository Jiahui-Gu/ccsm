export type MobileRequestDescriptor = {
  mode: string;
  url: string;
};

export type MobileFetchStrategy = 'cache-first' | 'network-only';

const HASHED_ASSET = /\.[a-f0-9]{8,}\.(?:css|js)$/i;

export function classifyMobileRequest(request: MobileRequestDescriptor): MobileFetchStrategy {
  if (request.mode === 'navigate') return 'network-only';
  const pathname = new URL(request.url).pathname;
  if (pathname.endsWith('/') || pathname.endsWith('.html')) return 'network-only';
  return HASHED_ASSET.test(pathname) ? 'cache-first' : 'network-only';
}
