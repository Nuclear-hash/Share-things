# Ferry

Send a file, share a link or a QR code, and the files delete themselves after ten minutes — or the
moment the receiver says they have them.

Runs entirely on Cloudflare: one Worker, static assets, an R2 bucket for the bytes and a D1 database
for the metadata. No accounts, no framework, no build server.

## What it does

- **Any file under 5 GB** — documents, photos, music, movies, archives. Uploads travel in 16 MB
  chunks, so a flaky connection only costs you one piece.
- **Byte-identical delivery** — nothing is re-encoded. The receiver gets exactly the bytes that were
  sent, at the same size and quality.
- **Compression only where it helps** — files between 40 and 64 MB are zipped when the archive is
  genuinely smaller, and that zip unpacks to the identical file. Everything else is stored as-is
  (a multi-GB movie cannot be deflated inside a Worker, and would not shrink anyway).
- **Turn taking** — the site keeps 5 GB in total. If the space is taken, the next upload is given a
  place in line and starts by itself when room frees up.
- **Instant delete** — the receiver can press “Yes, delete now” and the files are gone immediately,
  freeing space for whoever is waiting.
- **Ten minutes** — every link expires on its own, and the storage is reclaimed.

## Limits (all at the top of `worker.js` and `public/app.js`)

| Setting | Value |
| --- | --- |
| Files per handoff | 10 |
| Size per file / per handoff | 4.9 GB (anything under 5 GB) |
| Upload chunk | 16 MB |
| Storage budget (shared) | 5 GB |
| Link lifetime | 10 minutes |
| Zip band | 40–64 MB, only when it saves space |

## Local development

```bash
npm ci
npm run build
npx wrangler dev --port 3000
```

Open <http://127.0.0.1:3000>. Local D1 and R2 are simulated under `.wrangler/`; no Cloudflare
account is needed to try it.

## Deploy to your own Cloudflare account

```bash
npx wrangler login
npx wrangler r2 bucket create ferry-files
npx wrangler d1 create ferry          # copy the database_id it prints
# paste that id into wrangler.jsonc -> d1_databases[0].database_id
npm run build
npx wrangler deploy
```

The Worker creates its tables on the first request, so there is no migration step.

## Deploy from GitHub

`.github/workflows/deploy.yml` builds and deploys on every push to `main`. Add two repository
secrets (Settings → Secrets and variables → Actions):

- `CLOUDFLARE_API_TOKEN` — a token with *Workers Scripts: Edit*, *D1: Edit* and *R2: Edit*.
- `CLOUDFLARE_ACCOUNT_ID` — from the right-hand side of the Cloudflare dashboard.

You can also use Cloudflare's own GitHub integration: Workers & Pages → Create → Import a
repository, then set the build command to `npm run build` and the deploy command to
`npx wrangler deploy`.

## Layout

```
worker.js        the whole backend: uploads, queue, shares, downloads, cleanup
public/app.js    the whole front end: home, pop-up guide, upload, result, receiver
public/styles.css
public/index.html
wrangler.jsonc   bindings and resource names
```
