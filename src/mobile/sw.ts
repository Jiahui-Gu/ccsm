/// <reference lib="webworker" />
/* global ExtendableEvent, FetchEvent, Response, ServiceWorkerGlobalScope, caches, fetch */

import { classifyMobileRequest } from './serviceWorkerPolicy';

declare const __MOBILE_CACHE_VERSION__: string;

const worker = globalThis as unknown as ServiceWorkerGlobalScope;

const CACHE_PREFIX = 'ccsm-mobile-';
const CACHE_NAME = `${CACHE_PREFIX}${__MOBILE_CACHE_VERSION__}`;

worker.addEventListener('install', (event: ExtendableEvent) => {
  event.waitUntil(Promise.resolve());
  void worker.skipWaiting();
});

worker.addEventListener('activate', (event: ExtendableEvent) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
            .map((name) => caches.delete(name)),
        ),
      )
      .then(() => worker.clients.claim()),
  );
});

worker.addEventListener('fetch', (event: FetchEvent) => {
  if (
    event.request.method !== 'GET' ||
    new URL(event.request.url).origin !== worker.location.origin
  ) {
    return;
  }
  const strategy = classifyMobileRequest(event.request);
  if (strategy === 'network-only') {
    event.respondWith(fetch(event.request).catch(() => Response.error()));
    return;
  }
  event.respondWith(
    caches.match(event.request).then(async (cached) => {
      if (cached) return cached;
      try {
        const response = await fetch(event.request);
        if (response.ok) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(event.request, response.clone());
        }
        return response;
      } catch {
        return Response.error();
      }
    }),
  );
});
