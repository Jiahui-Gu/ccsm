/// <reference lib="webworker" />
/* global ExtendableEvent, FetchEvent, Response, ServiceWorkerGlobalScope, caches, fetch */

const worker = globalThis as unknown as ServiceWorkerGlobalScope;

const CACHE_NAME = 'ccsm-mobile-v1';
const SHELL = ['./', './index.html', './manifest.webmanifest'];

worker.addEventListener('install', (event: ExtendableEvent) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)));
  void worker.skipWaiting();
});

worker.addEventListener('activate', (event: ExtendableEvent) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))),
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
        if (event.request.mode === 'navigate') {
          return (await caches.match('./index.html')) ?? Response.error();
        }
        return Response.error();
      }
    }),
  );
});
