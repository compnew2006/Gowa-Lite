# Repository Guidelines

Gowa Lite is a bilingual, multi-account WhatsApp inbox for operators and supervisors. Keep changes compatible with the existing React frontend, Express API, SQLite data, and GOWA gateway.

## Project Structure

- Put screens in `src/pages/`, domain UI in `src/features/`, shared UI in `src/components/`, and typed requests in `src/api/`. `src/lib/http.ts` wraps Axios and handles session and API errors.
- Keep pure rules used by both the frontend and server in `shared/`. Reuse the existing permission checks, WhatsApp identity helpers, and message cache updates when adding a flow.
- `server.ts` starts Express and the WebSocket bridge. Put handlers in `server/routes/`, schemas in `server/validation/schemas.ts`, service logic in `server/services/`, and SQLite schema and queries in `server/db.ts`.
- Keep regression tests in `tests/*.test.ts`, static assets in `public/assets/`, and implementation status in `checklist.md`.
- Use strict TypeScript, two-space indentation, single quotes, and semicolons. Use kebab-case filenames, PascalCase components, and `use`-prefixed hooks. Use `@/` in frontend imports and explicit `.ts` extensions for relative server imports.

## Engineering Workflow

Follow [Superpowers](https://github.com/obra/superpowers) for systematic debugging, test-driven development, and verification. Trace defects through the UI, REST API, upstream gateway, database, WebSocket, and React Query as applicable. Reproduce the failure in a focused test, implement the smallest fix, then run the full checks. Use `node:test`, temporary SQLite databases, and mock HTTP/WS GOWA servers for integration tests.

Review the diff for authorization, stale data, retry behavior, and frontend regressions. Keep commits focused and use subjects such as `fix(chat): reconcile message reactions`. In PRs, explain the behavior change and verification, link related issues, and include captures for visible UI changes.

## Message and Access Rules

- Keep upstream credentials server-side. Use `.env.example` for local configuration and keep generated databases, keys, and secrets out of commits.
- Apply session, permission, device, and chat-content checks where applicable. Scope live message updates by device, chat, and target message. Enforce content redaction across REST and WebSocket. Verify GOWA webhooks against the raw request body before handling payloads.
- Bind live connections to the HTTP session. Accept message events with an identified GOWA account. Serve GOWA assets using the signed URLs issued by the authorized download or pairing routes.
- Persist successful sends before broadcasting. Reconcile reactions by actor and treat an empty emoji as removal. Patch the matching React Query entries without invalidating the inbox. Keep existing access checks and use parameterized SQL for database writes.

## UI and Performance

Apply [Impeccable](https://github.com/pbakaus/impeccable) to the operator workflow. Use existing tokens and controls, visible focus, and reduced-motion settings. Check compact and desktop layouts in Arabic RTL and English LTR. Keep translation keys aligned between `src/lib/i18n.ts` and `src/lib/i18n-en.ts`.

Measure production builds before and after a performance change. Record readiness, paint metrics, requests, transferred bytes, and the device/network profile. Target an entry chunk of at most 120 kB raw and 40 kB gzip. Keep inactive routes and English translations lazy, and check that WOFF2 font requests leave room for chat requests on slow networks. Share query keys when two consumers request the same data.

## Commands and Completion

Use Node.js 22.18 or newer and run from the repository root.

- `npm ci` installs dependencies from `package-lock.json`. Run `npm install` when intentionally changing dependencies. `npm run dev` starts the app on port 3000 by default.
- `npm run lint && npm run build && npm test` type-checks, builds, and runs the suite. Build first because `tests/phase3.test.ts` reads `dist/`.
- `npm exec -- tsx --test tests/message-reactions.test.ts` runs reaction regressions.
- `NODE_ENV=production npm start` serves the built app. `npm run verify:live` checks a configured real gateway.
