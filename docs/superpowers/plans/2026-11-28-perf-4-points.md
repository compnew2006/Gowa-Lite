# Perf: 4 points in Gowa-Lite — 2026-11-28 (corrected scope)

Contract for the 4-point performance work in `compnew2006/Gowa-Lite` (main @ `238c31e`).
Owner approved this scope ("ابدء في ال ٤ نقاط دول") and corrected it on 2026-11-28.
Work is local-only; the owner is the last gate for merge/deploy.

## 1. لماذا (سطران فقط)

- The owner's four points: (1) virtualization + memoization — the biggest render win;
  (2) WS batching; (3) media lazy-load + thumbnails; (4) upload without base64 (multipart).
  The goal is a faster current stack, not a rebuild (decided 2026-11-28 after brainstorming).
- Correction 2026-11-28: the unified-inbox cache was the coordinator's suggestion, NOT one of
  the owner's points — it is cancelled entirely (its agent was stopped, its branch/worktree
  deleted, no code, no tests, no section here). The search cap (50 results + index) was already
  done on the server — no work on it.

## 2. ماذا يجب أن يكون صحيحًا (معايير القبول)

1. When a long chat/message list is shown, only visible rows are rendered (DOM nodes ≈ visible
   rows, memoised rows don't re-render on unrelated updates), while RTL/Arabic,
   fetch-older-messages, read states, and reactions keep working.
2. When gateway WS events arrive in bursts, they are batched and flushed every 100–200ms,
   preserving order, dedup, per-user filtering, and content redaction as today.
3. When a chat contains images/videos/stickers, only visible media loads (lazy) and large media
   shows a thumbnail first; tapping/viewing still loads the full media as today.
4. When a large file (up to 20 MB) is uploaded, it is sent as multipart/form-data with no base64
   conversion, and the response envelope `{code, message, results}` is identical.
5. `npm run lint && npm run build && npm test` is green (build first) on every branch and on the
   merged result.
6. No change to the `/api` contract, the SQLite schema, gateway behavior, or the CRM.
7. Every point is measured: before/after numbers are recorded, or "not measurable locally" is
   stated with the reason — never invented.

## 3. خارج النطاق

- No VPS deploy, no GitHub push, no touching the gateway repo or the CRM, no `/api` contract
  change, no SQLite schema change, no enabling vite-plugin-singlefile (separate decision).
- NO unified-inbox cache — cancelled 2026-11-28 (was the coordinator's suggestion, not an owner
  point; agent stopped, branch `perf/inbox-cache` and its worktree deleted).
- NO search-cap work — the 50-result cap + `idx_chats_jid` index are already live on the server
  (commit `238c31e` + VPS patch).
- No single-binary / Go rewrite (separate later project).

## 4. كيف (فقرة قصيرة)

- Four independent branches from main @ `238c31e` (one worktree + one branch per point):
  (1) `perf/virtualization` — virtualize chat list + message list (choose
  `@tanstack/react-virtual` or `react-virtuoso` by fit — neither is installed today) +
  `React.memo` on rows in `src/features/chat/*`;
  (2) `perf/ws-batch` — event batching in `server/ws-bridge.ts` (100–200ms flush) keeping dedup
  and the 15s reconcile loop, plus batched React Query patches in `src/lib/ws.ts` +
  `src/lib/live-query-sync.ts` if applicable;
  (3) `perf/media-lazy` — lazy-load images/videos/stickers (loading=lazy or
  IntersectionObserver) + thumbnails, in `src/features/chat/message-media.tsx` and related
  media code, plus backend support in `server/services/inbox-media.ts` only where needed;
  (4) `perf/multipart` — multipart upload via FormData to `/send-media` with the smallest
  suitable middleware (e.g. multer — record the new dependency) in
  `server/routes/inbox-messages.ts` + the composer in `src/features/chat/`. TDD where it fits
  (batching / upload / media behavior). Measure production builds before/after; the
  entry-chunk target (≤120 kB raw / 40 kB gzip) is measured and reported, never silently broken.

## 5. المهام (قائمة تحقق)

- [ ] P1 virtualization + memoization: choose + install the library ← verify: build green +
      DOM-node count before/after recorded + behavior (RTL, fetch-older, read states, reactions)
      intact in the existing tests.
- [ ] P2 WS batching: failing test first (burst events → one batch; order preserved; dedup works;
      15s reconcile kept) ← verify: `npm run lint && npm run build && npm test` green + no lost
      events in `live-query-sync.test.ts`.
- [ ] P3 media lazy-load + thumbnails: lazy loading + thumbnails for images/videos/stickers ←
      verify: same commands green + media requests on initial render before/after recorded +
      full media still loads on view.
- [ ] P4 multipart: failing test first (large file → multipart, no base64; 20 MB limit kept; same
      envelope) ← verify: same commands green + multer recorded as a dependency.
- [ ] Sequential merge of the four branches into local main ← verify: full commands green on the
      merged result + before/after measurements recorded.

## 6. تمّ عندما

- Tests green + production build green + no change outside the scope above + before/after
  measurements recorded (or "not measurable" documented) + coordinator report to the owner
  (the owner is the last gate for merge/deploy).

## 7. الدليل

- Numbers from code read 2026-11-28: `server/ws-bridge.ts` (629 lines, dedup map 2,048 entries /
  30s, 15s reconcile), `server/routes/inbox-messages.ts` (20 MB limit),
  `src/features/chat/` (no virtualization — grep zero hits; media rendered eagerly),
  `package.json` (no virtualization lib, no multer; React 19, Vite 8.3, TanStack Query 5.108.4).
  Baseline: `npm run lint && npm run build && npm test` on main @ `238c31e` — all green
  (130 pass / 0 fail, log `/tmp/baseline-perf4.log`).
- Gate bypass: the owner explicitly approved the 4-point scope and asked to start ("ابدء في ال ٤
  نقاط دول") on 2026-11-28 — the separate design-doc approval step is bypassed by that direct
  request; recorded in `~/workspace/factory/ledger.md`. Scope corrected the same day by the
  owner (cache out, media split out as its own point).
