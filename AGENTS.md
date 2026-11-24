# Repository Guidelines

## Project Structure & Module Organization

- `src/` contains the React and Vite frontend. Put route screens in `src/pages/`, feature code in `src/features/`, and shared UI in `src/components/`. The typed API client lives in `src/api/`.
- `server.ts` wires Express, Vite, and the WebSocket bridge. Put endpoint handlers in `server/routes/`, business logic in `server/services/`, and request schemas in `server/validation/schemas.ts`. SQLite persistence lives in `server/db.ts`.
- Static assets live in `public/assets/`, automated tests in `tests/`, and the live GOWA check in `scripts/verify-live-gowa.ts`.

## Build, Test, and Development Commands

Use Node.js 22.18 or newer and run commands from the repository root.

- `npm install` installs dependencies.
- `npm run dev` starts Express with Vite at `http://localhost:3000` by default.
- `npm run lint` runs the TypeScript check (`tsc --noEmit`).
- `npm run build` writes the frontend bundle to `dist/`.
- `npm test` runs the automated suite. Build first for the production smoke test.
- `NODE_ENV=production npm start` serves the built UI, API, and WebSocket endpoint.
- `npm run verify:live` checks HTTP and WebSocket connectivity to a configured GOWA gateway.

## Coding Style & Naming Conventions

Match nearby strict TypeScript code. Use two-space indentation, single quotes, and semicolons. Use kebab-case filenames, PascalCase component names, and `use` prefixes for hooks. Use `@/` for frontend imports rooted in `src/` and explicit `.ts` extensions for relative server imports. Add Arabic and English UI strings in `src/lib/i18n.ts`.

## Testing Guidelines

Name test files `*.test.ts` and use `node:test` with `node:assert/strict`. Run one file with `npm exec -- tsx --test tests/media-download.test.ts`. Use temporary SQLite databases and mock GOWA servers for automated integration tests. The project has no configured coverage threshold.

## Commit & Pull Request Guidelines

Follow the recent `type(scope): summary` pattern, such as `refactor(server): modularize route handlers`. Summarize behavior changes and verification in the PR, link relevant issues, and include screenshots for visible UI changes.

## Local Configuration

Use `.env.example` as the template for `.env`. Keep credentials, generated SQLite files, and encryption keys out of commits.
