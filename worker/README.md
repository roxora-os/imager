# Roxora download proxy

A Cloudflare Worker that serves the files of the
[roxora-os/build releases](https://github.com/roxora-os/build/releases) with
CORS headers, so the web version of Roxora Imager
(https://roxora-os.github.io/imager/) can download an image itself.

GitHub sends release downloads without CORS headers (the final response from
release-assets.githubusercontent.com has no `Access-Control-Allow-Origin`,
and a preflight gets 405), so a web page cannot read them. Without this
Worker the page asks the user to download the file and choose it.

## What it does

- `GET`, `HEAD` and `OPTIONS` (CORS preflight) only; anything else is 405.
- Only `/<tag>/<file>`, mapped to
  `https://github.com/roxora-os/build/releases/download/<tag>/<file>`. The
  tag must look like `v2026.11.1` and the file must be one of the names in
  the [release contract](https://github.com/roxora-os/build/blob/main/docs/release-contract.md)
  for that version: the `.img.xz`, `-spi.img`, their `.sha256`,
  `.verify.txt`, `roxora-catalog.json` and `SHA256SUMS`. Anything else is
  404 without contacting GitHub. It is not an open proxy.
- `Range`, `If-None-Match` and `If-Modified-Since` are passed on. GitHub's
  redirect to its storage is followed inside the Worker. The body is streamed,
  never buffered. `Content-Length`, `Content-Range`, `Accept-Ranges`, `ETag`,
  `Last-Modified`, `Content-Type` and `Cache-Control` are copied (GitHub's
  storage currently sends no `Cache-Control` on the final response).
- `/` answers with a short plain-text note saying what the service is.

### Which pages may use it

`Access-Control-Allow-Origin` is not `*`. The Worker answers only requests
from `https://roxora-os.github.io` and from `http://localhost` or
`http://127.0.0.1` on any port (the web build served locally), echoing the
origin back with `Vary: Origin`. A request with any other `Origin` gets 403.
Requests with no `Origin` (curl, a plain download link) are served, since
they could fetch the files from GitHub directly anyway.

The reason: the files are public and CORS does not stop other programs, but
`*` would let any web site build a downloader on this Worker and spend its
owner's request quota. If the imager ever moves to another address, add it
to `ALLOWED_ORIGINS` in `src/proxy.ts`.

## Deploy (Woo)

Needs Node.js 22 and a Cloudflare account; the free plan is enough for the
request count (see the question below on large files). Nothing in this
directory holds an account id or a secret: wrangler takes the account from
the login.

```sh
cd worker
npm ci
npx wrangler login     # opens the browser once
npx wrangler deploy    # prints the URL, https://roxora-download.<subdomain>.workers.dev
```

To serve it from a host name on a domain in the same Cloudflare account
instead of workers.dev, add a route to `wrangler.toml` before deploying:

```toml
routes = [{ pattern = "download.example.com/*", zone_name = "example.com" }]
```

Then set the address for the web build: in roxora-os/imager, Settings,
Secrets and variables, Actions, Variables, add `ROXORA_DOWNLOAD_PROXY` with
the Worker URL (no trailing path), and rerun the "Web app" workflow. While
the variable is empty the page works as before.

## Test

Unit tests (from the repository root): `npx vitest run test/worker.test.ts`.

Locally, without a Cloudflare login:

```sh
cd worker
npm ci
npx wrangler dev --local
curl -i -H 'Origin: https://roxora-os.github.io' \
  http://127.0.0.1:8787/v2026.11.1/roxora-radxa-rock-4d-noble-edge-2026.11.1-spi.img -o spi.img
```

To try the web build against it:
`ROXORA_DOWNLOAD_PROXY=http://127.0.0.1:8787 node scripts/build-web.mjs`.
