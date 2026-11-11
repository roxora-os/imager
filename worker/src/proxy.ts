// Roxora download proxy: a Cloudflare Worker that serves files of the
// roxora-os/build GitHub releases with CORS headers, so the web version of
// Roxora Imager can download an image itself. GitHub serves release
// downloads without CORS headers, so a browser page cannot read them.
//
// It is deliberately narrow: GET, HEAD and OPTIONS only; only
// /<tag>/<file> for release tags and the file names of the release
// contract (roxora-os/build docs/release-contract.md); only requests from
// the imager's own pages. Anything else is refused without contacting
// GitHub. Bodies are streamed, never buffered.

export const UPSTREAM = 'https://github.com/roxora-os/build/releases/download';

/**
 * Pages allowed to read through the proxy. CORS does not stop other
 * programs, but it keeps other web sites from using this Worker (and its
 * owner's bandwidth) from their pages: requests with any other Origin are
 * refused. Requests without an Origin (curl, a download link) are served.
 */
export const ALLOWED_ORIGINS = [
  'https://roxora-os.github.io',
  // The web build served locally (scripts/web-shots.mjs, npx serve, ...).
  /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/,
];

const TAG = /^v(\d{4}\.\d{2}\.\d+)$/;

/** Is `file` a file a release with this version may carry? */
export function allowedFile(file: string, version: string): boolean {
  if (file === 'roxora-catalog.json' || file === 'SHA256SUMS') return true;
  const v = version.replace(/\./g, '\\.');
  // roxora-<board>-<release>-<branch>-<version>, board having dashes itself.
  const re = new RegExp(`^roxora-(?:[a-z0-9]+-){3,}${v}(?:\\.img\\.xz|\\.img\\.xz\\.sha256|-spi\\.img|-spi\\.img\\.sha256|\\.verify\\.txt)$`);
  return re.test(file);
}

/** The GitHub URL for a request path, or null when the path is not allowed. */
export function upstreamUrl(pathname: string): string | null {
  const m = /^\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (!m) return null;
  const [, tag, file] = m;
  const t = TAG.exec(tag);
  if (!t || !allowedFile(file, t[1])) return null;
  return `${UPSTREAM}/${tag}/${file}`;
}

export function originAllowed(origin: string | null): boolean {
  if (origin === null) return true;
  return ALLOWED_ORIGINS.some((o) => (typeof o === 'string' ? o === origin : o.test(origin)));
}

const PASSED_REQUEST = ['range', 'if-none-match', 'if-modified-since'];
const PASSED_RESPONSE = ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified', 'content-type', 'cache-control'];
const EXPOSED = 'Content-Length, Content-Range, Accept-Ranges, ETag, Last-Modified, Content-Type';

function cors(origin: string | null): Record<string, string> {
  const h: Record<string, string> = { Vary: 'Origin' };
  if (origin !== null) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Expose-Headers'] = EXPOSED;
  }
  return h;
}

function text(status: number, body: string, extra: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...extra } });
}

export const ABOUT = `Roxora download proxy.

Serves the files of the roxora-os/build GitHub releases with CORS headers,
for the web version of Roxora Imager (https://roxora-os.github.io/imager/).
Paths are /<tag>/<file>, for example
/v2026.11.0/roxora-armsom-cm5-io-noble-edge-2026.11.0.img.xz
Nothing else is served. Source: https://github.com/roxora-os/imager/tree/main/worker
`;

export async function handle(req: Request, fetchFn: typeof fetch = fetch): Promise<Response> {
  const url = new URL(req.url);
  const origin = req.headers.get('Origin');
  if (!originAllowed(origin)) return text(403, 'This origin may not use the Roxora download proxy.\n', { Vary: 'Origin' });

  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        ...cors(origin),
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Range, If-None-Match, If-Modified-Since',
        'Access-Control-Max-Age': '86400',
      },
    });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return text(405, 'Only GET, HEAD and OPTIONS.\n', { Allow: 'GET, HEAD, OPTIONS', ...cors(origin) });
  }
  if (url.pathname === '/') return text(200, ABOUT, cors(origin));

  const target = upstreamUrl(url.pathname);
  if (!target) return text(404, 'Not a Roxora release file.\n', cors(origin));

  const headers = new Headers({ 'User-Agent': 'roxora-download-proxy' });
  for (const h of PASSED_REQUEST) {
    const v = req.headers.get(h);
    if (v !== null) headers.set(h, v);
  }
  // GitHub answers with a redirect to its storage; follow it here.
  let up: Response;
  try {
    up = await fetchFn(target, { method: req.method, headers, redirect: 'follow' });
  } catch {
    return text(502, 'GitHub could not be reached.\n', cors(origin));
  }
  const out = new Headers(cors(origin));
  for (const h of PASSED_RESPONSE) {
    const v = up.headers.get(h);
    if (v !== null) out.set(h, v);
  }
  if (up.status >= 400) {
    // A 416 keeps Content-Range (bytes */<size>) so the client learns the size.
    const extra: Record<string, string> = cors(origin);
    const cr = up.headers.get('content-range');
    if (up.status === 416 && cr !== null) extra['Content-Range'] = cr;
    return text(up.status, up.status === 404 ? 'No such file in that release.\n' : `GitHub answered ${up.status}.\n`, extra);
  }
  return new Response(req.method === 'HEAD' ? null : up.body, { status: up.status, headers: out });
}
