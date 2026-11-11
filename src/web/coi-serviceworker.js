// From roxora-os/edk2-webflash coi-serviceworker.js at 0955b20, unchanged below this line.
/**
 * Cross-Origin Isolation Service Worker
 *
 * Adds Cross-Origin-Opener-Policy: same-origin
 *     + Cross-Origin-Embedder-Policy: credentialless
 * to every same-origin response so the page becomes cross-origin isolated.
 *
 * This enables SharedArrayBuffer, which is required by the Emscripten libusb
 * patch (001-fix-hangs.patch) to use Atomics.waitAsync instead of a polling
 * fallback. Without it, ASYNCIFY suspend/resume corrupts Emscripten's thread
 * local state, causing val.h's pthread_equal assertion to abort().
 *
 * 'credentialless' (not 'require-corp') is used for COEP so that cross-origin
 * resources (firmware from raw.githubusercontent.com) still load via CORS
 * without needing a Cross-Origin-Resource-Policy header.
 */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const req = e.request;

  // Only intercept same-origin requests — we only need to add headers to our own files.
  // Cross-origin fetches (firmware download) are exempt; the browser handles them
  // under the page's credentialless COEP policy automatically.
  if (!req.url.startsWith(self.location.origin + '/')) return;

  // Avoid a known TypeError with 'only-if-cached' requests in non-same-origin mode.
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;

  e.respondWith(
    fetch(req).then((resp) => {
      const headers = new Headers(resp.headers);
      headers.set('Cross-Origin-Opener-Policy', 'same-origin');
      headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
      return new Response(resp.body, {
        status: resp.status,
        statusText: resp.statusText,
        headers,
      });
    }),
  );
});
