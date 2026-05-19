# CodexBin

CodexBin is a self-hosted encrypted pastebin (PrivateBin-style) with:

- Static frontend on GitHub Pages (`docs/`)
- Cloudflare Worker backend (`worker/`)
- AES-256-GCM client-side encryption with Web Crypto
- URL fragment key transport (`#...`) so the server never receives plaintext keys
- Optional password protection using PBKDF2-derived wrapping key
- Encrypted comments, expiration, burn-after-reading, attachments, syntax/markdown rendering, copy-link + QR

## Repository layout

```text
/
├── docs/
│   ├── index.html
│   ├── css/
│   └── js/
├── worker/
│   ├── index.js
│   └── wrangler.toml
└── .github/workflows/deploy.yml
```

## 1) Cloudflare setup

1. Create a Cloudflare account and install Wrangler locally:

```bash
npm install -g wrangler
wrangler login
```

2. Create KV namespaces:

```bash
wrangler kv namespace create "PASTES"
wrangler kv namespace create "PASTES" --preview
wrangler kv namespace create "RATE_LIMITS"
wrangler kv namespace create "RATE_LIMITS" --preview
```

3. Copy the returned namespace IDs into [worker/wrangler.toml](worker/wrangler.toml):
- `PASTES_KV_NAMESPACE_ID`
- `PASTES_KV_PREVIEW_NAMESPACE_ID`
- `RATE_LIMITS_KV_NAMESPACE_ID`
- `RATE_LIMITS_KV_PREVIEW_NAMESPACE_ID`

4. Deploy once manually to confirm:

```bash
cd worker
wrangler deploy
```

## 2) GitHub Actions secrets

In your GitHub repository:

1. Go to `Settings -> Secrets and variables -> Actions`.
2. Add:
- `CF_API_TOKEN` (token with Workers + KV edit permissions)
- `CF_ACCOUNT_ID` (your Cloudflare account ID)

The workflow in [deploy.yml](.github/workflows/deploy.yml) deploys the worker on push to `main` when files in `worker/` change.

## 3) Enable GitHub Pages frontend

1. Push this repo to GitHub.
2. Open `Settings -> Pages`.
3. Set `Source` to `Deploy from a branch`.
4. Select branch `main` and folder `/docs`.
5. Save and wait for Pages to publish.

## 4) Connect frontend to backend

After Worker deployment, copy your Worker URL (for example `https://codexbin-worker.<subdomain>.workers.dev`).

In the app UI, set **Worker API base URL** to that Worker URL and create a paste.

You can also prefill your own default in [app.js](docs/js/app.js) by changing:

```js
const DEFAULT_API_BASE = "https://your-worker-subdomain.workers.dev";
```

## API endpoints

- `POST /api/paste` - store encrypted paste blob
- `GET /api/paste/:id` - retrieve encrypted paste blob
- `DELETE /api/paste/:id` - delete via `X-Delete-Token`
- `POST /api/paste/:id/comment` - add encrypted comment
- `GET /api/paste/:id/comments` - list encrypted comments

Worker behavior:

- KV TTL follows expiration selection (`5min`, `1hr`, `1day`, `1week`, `never`)
- Burn-after-reading deletes paste/comments after first read
- IP rate limit: 10 requests/minute (KV-backed)

## Rename / branding

To replace `CodexBin` with your own name:

1. Update title/brand text in [index.html](docs/index.html)
2. Update Worker name in [wrangler.toml](worker/wrangler.toml)
3. Update this README title