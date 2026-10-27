# Answer key — upload-svg-inline

**Planted true positive** — `server.js`, the `GET /files/:name` handler. Uploaded bytes are served from the
application's own origin with the response `Content-Type` derived from the client-supplied filename
extension and no `Content-Disposition`. An uploaded `.svg` is served `image/svg+xml` inline, and SVG executes
script. The upload filter rejects `.html`/`.js`, which is exactly why reading only the filter says "safe".

**Planted safe sibling** — `server.js`, the `GET /downloads/:name` handler: same bytes, served `attachment`
with `X-Content-Type-Options: nosniff` and a fixed `application/octet-stream`.
