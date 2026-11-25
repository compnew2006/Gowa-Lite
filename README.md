# Gowa Lite — Unified WhatsApp Inbox

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D%2022.18-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![SQLite](https://img.shields.io/badge/SQLite-WAL-003B57?logo=sqlite&logoColor=white)](https://www.sqlite.org)
[![GOWA](https://img.shields.io/badge/Gateway-GOWA-25D366?logo=whatsapp&logoColor=white)](https://github.com/aldinokemal/go-whatsapp-web-multidevice)

> [Arabic version](README.ar.md) — النسخة العربية.

A unified web interface and broker server for managing multiple WhatsApp devices from one place, via the **GOWA (go-whatsapp-web-multidevice)** gateway — a unified inbox, custom roles & permissions, and customer ratings after chat close.

---

## Features

- **Unified inbox** — all WhatsApp accounts in one list, with a per-account filter.
- **Chat lifecycle** — tabs (Pending / Mine / Closed / All), with assign, claim, close and reopen.
- **Custom roles & permissions** — a fine-grained permission matrix, and restricting each user to specific WhatsApp accounts (`/settings/roles` and `/settings/users`).
- **Per-user read tracking** — each agent sees what they read, not what others read.
- **Internal notes** on chats, invisible to the customer.
- **Scheduled messages** sent automatically on time.
- **Post-close rating** — when an individual chat is closed, a rating request (1–5) is sent on WhatsApp; the first numeric reply within 48 hours is accepted, with the average, count and last ten replies shown in the account tab.
- **Real-time reactions** on messages via a signed webhook, plus mute / pin / archive / block / clear / delete for chats.
- **Accounts, groups and newsletters management**, with device pairing via QR or code.
- **Arabic RTL and English LTR** — the same UI in both languages.
- **Security** — GOWA credentials stay server-side only, signed media-download links scoped to account and chat, and the GOWA password encrypted (`AES-256-GCM`).

---

## Screenshots

<!-- Add screenshots captured with demo data only (login, inbox, accounts).
     Never commit real customer chats, phone numbers, QR pairing codes, or production data. -->

---

## Quick start

```bash
npm ci
cp .env.example .env   # then set GOWA_URL and credentials
npm run dev            # http://localhost:3000
```

### Build and run in production

```bash
npm run build
NODE_ENV=production PORT=3000 node server.ts
```

Or via the start script:

```bash
NODE_ENV=production npm start
```

> With `NODE_ENV=production`, the server serves the `dist/` build split into separate chunks (`React.lazy` + `manualChunks`) with async compression (`compression`) and immutable caching for `dist/assets/*`, keeping all `/api/*` routes and the `/ws` bridge on the same port.

---

## How it works

```text
Browser   (React 19 + Vite + Tailwind — RTL)
   │  REST + WebSocket
Server    (Express + ws + node:sqlite)
   │  HTTP + WebSocket
GOWA gateway (go-whatsapp-web-multidevice) ← WhatsApp devices
```

Messages and chats live inside GOWA; the lite version stores only **settings and preferences** (roles, ratings, contacts, schedules) in SQLite.

---

## Requirements

- **Node.js `>= 22.18`** (verified on `v22.23.5`, running `node server.ts` directly via type stripping with `node:sqlite`).
- **npm** to install dependencies and build the UI.
- A **GOWA** server reachable over HTTP/HTTPS and WebSocket for real WhatsApp device connectivity.

---

## Environment variables

Copy `.env.example` to `.env` or set the following before running (the server loads `.env` automatically via `dotenv/config` without overriding pre-set environment variables):

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `3000` | The port the server listens on (`0.0.0.0`). |
| `NODE_ENV` | `development` | Set to `production` to serve the static `dist/` build instead of the Vite dev server. |
| `ADMIN_PASSCODE` | *(empty)* | Optional passcode to skip the first-run setup wizard (`/api/auth/setup`) and enable instant login to the `admin` account. When set, `/api/auth/setup` returns `403`. |
| `GOWA_LITE_DB_PATH` | `./gowa-lite.db` | SQLite database file path (useful to keep the database in a persistent folder or during tests). |
| `GOWA_SETTINGS_SECRET` | *(automatic)* | Secret used to encrypt the GOWA password in SQLite (`AES-256-GCM`). If left empty, the server generates a random key in `${GOWA_LITE_DB_PATH}.key` with mode `0600`. |
| `TRUST_PROXY` | `false` | Express `trust proxy` setting (`false`, `true`, a hop count such as `1`, or an IP range). Set it when running behind Nginx/Cloudflare so `AuthRateLimiter` reads the real client IP from `X-Forwarded-For` safely. |
| `BLOCK_PRIVATE_GOWA_URL` | `false` | Set to `true` in public environments to block private-network addresses (`localhost` and RFC1918) as the GOWA server address (cloud metadata and link-local addresses are always blocked). |
| `ENABLE_COMPRESSION` | `true` | Enable async response compression (`gzip`/`deflate`) for HTTP requests larger than 1KB. |
| `GOWA_URL` | *(empty)* | Default GOWA server URL (can be set or changed from the settings UI; saved UI settings take precedence). |
| `GOWA_USERNAME` | *(empty)* | Default GOWA Basic Auth username. |
| `GOWA_PASSWORD` | *(empty)* | Default GOWA Basic Auth password. |
| `GOWA_WEBHOOK_SECRET` | *(empty)* | Optional webhook signing key for showing contact reactions in real time. |
| `GOWA_WS_QUERY_AUTH` | `false` | Set to `true` only if your GOWA server or proxy rejects the `Authorization: Basic` header on the WebSocket connection and requires `?authorization=`. |

---

## Checks and tests

```bash
npm run lint
npm run build
npm test
npm run verify:live   # requires a configured real GOWA gateway
```

### Real-time WhatsApp events

Set `GOWA_WEBHOOK_SECRET` on Gowa Lite and `WHATSAPP_WEBHOOK_SECRET` to the same value on the gateway. Add the full URL of `/api/webhooks/gowa` to `WHATSAPP_WEBHOOK`, and set `WHATSAPP_WEBHOOK_EVENTS=message,message.reaction,message.edited,message.revoked,message.deleted`. If devices have separate webhook addresses, enable `WHATSAPP_WEBHOOK_DEVICE_MERGE_GLOBAL=true` so events are also sent to the global address. Gowa Lite needs a trusted source identifier for every event. If the WebSocket connection in your gateway version sends shared events without identifying the account, use the signed webhook for real-time updates. [Webhook setup in GOWA](https://github.com/aldinokemal/go-whatsapp-web-multidevice#webhooks)

Media download links are signed and scoped to account and chat, and permissions are checked when they are used. The maximum GOWA response is 16 MiB for JSON requests and 64 MiB for files. The connection timeout covers reading the full response.

### Post-close service rating

Open **Accounts**, pick a WhatsApp account, then open the **Ratings** tab and enable sending rating requests. The setting is per account and off by default. When an individual chat is closed, the app sends one request on WhatsApp and accepts the first numeric reply from 1 to 5 within 48 hours. The average, the number of ratings and the last ten replies appear in the account tab. The rating keeps the chat closed; ordinary support messages follow the normal reopen behavior.

To receive ratings in real time, use the webhook setup above with the `message` event. A reply can also be recorded when the account's message history is synced. Turning the feature off stops new requests; replies to requests already sent stay accepted for their duration.

---

## Project structure

| Path | Contents |
| :--- | :--- |
| `src/pages/` | Screens (login, inbox, accounts, groups, roles, users, settings) |
| `src/features/` | Per-domain UI (chats, accounts, groups, schedules, permissions) |
| `src/components/` | Shared components (`ui/`, layout) |
| `src/api/` and `src/lib/` | Typed requests and shared utilities |
| `server.ts` | Server entry point (Express + WebSocket bridge) |
| `server/routes/` and `server/services/` | Handlers and business logic |
| `server/db.ts` | SQLite schema and queries |
| `shared/` | Pure rules shared between frontend and server |
| `tests/` | `node:test` tests (including integration tests with mock GOWA servers) |

Read [`AGENTS.md`](AGENTS.md) before making any change — it holds the full repository rules. Detailed implementation status is in [`checklist.md`](checklist.md), and the architecture design in [`plan.md`](plan.md).

---

## Backup and restore (`gowa-lite.db`)

The database runs in **SQLite WAL** mode (`PRAGMA journal_mode = WAL;`), which means three linked files exist while the server is running, plus the encryption key file if `GOWA_SETTINGS_SECRET` is not set:
- `gowa-lite.db` (main database)
- `gowa-lite.db-wal` (active write-ahead log)
- `gowa-lite.db-shm` (shared memory for the WAL index)
- `gowa-lite.db.key` (auto-generated encryption key for the GOWA password in the `settings` table)

> Warning:
> 1. Copying `gowa-lite.db` alone while the server is running, without merging `-wal`, may produce an inconsistent copy missing the latest sessions and notes.
> 2. If you did not set `GOWA_SETTINGS_SECRET`, keep a copy of `gowa-lite.db.key` in a safe place next to the backup so the GOWA password can be decrypted after restore.

### Safe backup method (running or stopped)

**Option A — live consistent copy via SQLite `VACUUM INTO` (no server stop needed):**
```bash
node --input-type=module -e '
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.env.GOWA_LITE_DB_PATH || "./gowa-lite.db");
db.exec("VACUUM INTO \"./gowa-lite.backup.db\"");
'
```

**Option B — stop the server, then copy the files:**
1. Stop the `node server.ts` process (`SIGTERM` shuts the bridge and server down cleanly).
2. Copy `gowa-lite.db` with `gowa-lite.db-wal`, `gowa-lite.db-shm` and `gowa-lite.db.key` (if present) to the backup location.

### Restore
1. Stop the server completely.
2. Delete any old `gowa-lite.db-wal` and `gowa-lite.db-shm` leftovers if the backup was taken via `VACUUM INTO`.
3. Copy the backup file (and the `.key` file if used) to the path in `GOWA_LITE_DB_PATH` (or `./gowa-lite.db`).
4. Restart the server and check `/api/auth/status`.

---

## License

Proprietary — all rights reserved. See [LICENSE](LICENSE) (English, governing text) and [LICENSE.ar.md](LICENSE.ar.md) (Arabic translation). Commercial use requires a license purchased from the copyright holder.

---

## Status & roadmap

The project is functionally complete per the checklist in [`checklist.md`](checklist.md). Remaining: live verification against a real GOWA gateway (`npm run verify:live`), and a build check on Linux.
