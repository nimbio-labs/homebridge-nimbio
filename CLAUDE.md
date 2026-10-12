# CLAUDE.md

Official Homebridge plugin for Nimbio gates — npm `@nimbio/homebridge-nimbio`,
public repo `nimbio-labs/homebridge-nimbio`. Part of the Nimbio ecosystem; the
hub is `../nimbioCore` (see its CLAUDE.md for changelog/follow-up rules).

## What it is

A **consumer of the npm SDK** (`@nimbio/community-api`), like `nimbio-mcp-server`:
no HTTP, auth, retry or SSE code of its own. If a feature needs a new API call,
it goes into the SDK first.

Dynamic platform, alias **`NimbioGates`** — deliberately not `Nimbio`, which an
unofficial third-party package (`homebridge-nimbio` by bob138, Sept 2026)
already registers. Both must be installable side by side.

## The one rule: the key decides

`src/session.ts` reads `me()` once at startup:

- `key.type === "community"` → **manager** mode. Live status if the key has
  `gate_status`; hold-open switches if it has `hold_opens`. Gate each feature
  on its capability, never on the type alone.
- anything else → **member** mode: open-only momentary garage doors, **zero
  background API calls**.

This mirrors `nimbio-home-assistant`. Latch classification (`src/classify.ts`)
is a port of HA's `const.py` and `test/classify.test.ts` copies HA's
`tests/test_const.py` — change both together.

## Layout

- `src/platform.ts` — startup, inventory, accessory sync (UUID =
  `nimbio:<role>:<latchId>`; role in the UUID so a type change re-creates the
  accessory with the right icon), shutdown.
- `src/accessories/` — `gate.ts` (GarageDoorOpener, momentary or sensed),
  `lock.ts` (LockMechanism), `holdOpen.ts` (Switch).
- `src/live.ts` — SSE stream → state store, polling fallback, safety re-sync.
- `src/state.ts`, `src/doorState.ts` — pure state + HAP value mapping.
- `src/opener.ts` — the only open path (idempotency key + access-log note).
- `src/streamProbe.ts` — a pass-through wrapper on the SDK's `fetch` option
  that reports the event stream's HTTP 200. **A deliberate, documented
  stopgap**: `streamEvents()` yields nothing until an event arrives and retries
  connection failures silently, so it has no other honest "connected" signal
  (elapsed-time guessing was tried and was wrong both ways). Delete it once the
  SDK exposes an on-connect message/hook (nimbioCore follow-up).

Invariants: reads never throw while the plugin is running (an offline box must
not turn a gate into "No Response") — but cached tiles *do* report No Response
until a confirmed key attaches real handlers; unknown statuses never become a
fake open/closed (fallbacks return to the last *real* position); a status read
never overwrites a latch an event updated after the read began; logs carry
named fields only — never payloads or the API key. Each of these has a
regression test (`test/review-fixes.test.ts`, `test/second-pass.test.ts`,
`test/logging.test.ts`, `test/hygiene.test.ts`).

## Commands

```bash
npm run check          # version:check + lint + typecheck + tests with coverage thresholds
npm run build          # tsc → dist/
scripts/dev-smoke.sh member|manager   # real Homebridge vs dev API; test keys only
```

Use **npm ≥ 11** (11.19.1, as CI and `publish.yml` pin). npm 10 — including
10.9.9 — crashes with `Cannot read properties of null (reading 'edgesOut')` when
adding a dependency: vite 8's optional peer `@vitejs/devtools` pulls
`vitest: "*"` into the peer set (npm/cli#5151). `npm ci` from the lockfile is
unaffected. No `legacy-peer-deps` — it would hide real conflicts.

## Release

Bump `package.json`, `src/version.ts`, `CHANGELOG.md` (`npm run version:check`
enforces agreement), update `../nimbioCore/changelogs/homebridge.md` +
`marketing-changelogs/homebridge.md`, then tag `vX.Y.Z`. `publish.yml` publishes
via npm Trusted Publishing and creates the GitHub Release (a Homebridge
Verified requirement). First publish is manual (npm needs the package to exist
before a trusted publisher can be attached).
