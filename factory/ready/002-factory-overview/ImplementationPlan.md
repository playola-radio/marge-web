# 002-factory-overview — Implementation plan

The design files beside this plan are the truth; this plan only says how to build them.

**Base branch:** `main` (this repo has no `develop`). Two PRs, built in order:
- PR 1 adds the sync endpoint, the history tables and the read endpoint to the Express server (`server/`).
- PR 2 replaces the "Control panel not built yet" body of `FactoryPage` in the Vite client (`client/`) with the live
  overview.

The factory's sender is not part of either PR (Design.md decision 3). `FACTORY_REPORT_TOKEN` already exists in Render
(Design.md decision 12); PR 1 only declares it.

**Decisions made while planning:**
- **Latest state:** the catalog and snapshot are stored through the existing `KV` interface (`deps.kv`), so tests
  use `MemoryKV`.
- **History:** a new `FactoryHistory` interface with a `MemoryFactoryHistory` for tests and local dev and a
  `PostgresFactoryHistory` for production, chosen by the existing `KV_BACKEND` setting exactly as `createKv` does.
  It is a required field of `AppDeps`, so production can never silently run without it.
- **Validation:** one hand-written function, `parseSync`, that returns the cleaned body or `null`. No schema library
  is added, because the server has none today.
- **Order of checks on `POST`:** the factory token is checked before the body is even parsed, so a caller without
  the token learns nothing about the shape and always gets 401. The app parses JSON for every route in `app.ts`, so
  the sync route is mounted ahead of that parser and parses its own body (5 MB limit) after the token check.
- **Order of writes:** artifacts, then events, then the latest state, with no transaction. Each write skips ids it
  already has, so the factory's resend after any failure finishes the job (ModelChanges.md).
- **Bearer header:** the client sends it explicitly on the one call that needs it. There is no global axios
  interceptor, because no other call in the client is authenticated.
- **One markup for both sizes:** each build row is a single block of markup that CSS lays out as a table row on
  desktop and a card at `max-width: 768px` (001's breakpoint). The few phone-only and desktop-only words sit in
  spans with `mobile-only` / `desktop-only` classes.
- **Ages:**
  - Every age is `serverNow − <time>` from the latest answer, so the browser's clock is never used.
  - The quiet chip's hours come from `lastEventAt`.

| PR | Title | Depends on | Hard |
|---|---|---|---|
| 1 | feature: let the factory machine report its state and history to marge's server | — | no |
| 2 | feature: show what the factory is building and what needs attention | 1 | no |

## PR 1 — feature: let the factory machine report its state and history to marge's server

Once merged, the factory machine can push its current state, its status list and its new history to
`api.marge.playola.fm` with its own token. Marge keeps the history, each event and report once, and a signed-in
marge user can read the latest state back. Nothing a user sees changes yet.

**Changes**

- **`server/src/config.ts`:** add `factoryReportToken: string | null` to `Config`. Read it in `loadConfig` from
- `FACTORY_REPORT_TOKEN`; an unset or empty value gives `null`, and the server never throws over it.
- **New migration `server/src/db/migrations/20261122000000-factory-history.cjs`** (CommonJS, in the style of
- `20261121000000-kv-store.cjs`), exactly the two tables in ModelChanges.md:
- - `up`: create `factory_artifacts` (`id` UUID primary key, `kind` TEXT, `at` DATE, `body` JSONB, all not null),
- then `factory_events` (`id` UUID primary key; `run_id` UUID, `at` DATE, `repo` TEXT, `design` TEXT, `type` TEXT,
- all not null; `pr` INTEGER null; `details` JSONB not null default `{}`; `artifact_id` UUID null with
- `references: { model: 'factory_artifacts', key: 'id' }`). Sequelize `DATE` is `timestamptz` on Postgres.
- - `down`: drop `factory_events`, then `factory_artifacts`.
- - No other index.
- **New `server/src/lib/factorySync.ts`:**
- - Types matching ApiContract.md: `FactoryCatalog`, `FactorySnapshot`, `FactoryEvent` (`id`, `runId`, `at`, `repo`,
- `design`, `pr: number | null`, `type`, `details: Record<string, unknown>`, `artifactId: string | null`),
- `FactoryArtifact` (`id`, `kind`, `at`, `body`), and `SyncBody` (`catalog`, `snapshot`, `events`, `artifacts`).
- - `export const FACTORY_SNAPSHOT_KEY = 'factory:snapshot'`
- - `export const FACTORY_SNAPSHOT_TTL_SECONDS = 365 * 24 * 60 * 60`
- - `isUtcTime(value)`: a string matching `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/` where
- `const t = Date.parse(value)` is finite (month 13 or hour 25 give `NaN`) and
- `new Date(t).toISOString().slice(0, 19) === value.slice(0, 19)` (30 February rolls into March and fails).
- - `isUuid(value)`: a string matching `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/`.
- - `export function parseSync(body: unknown): SyncBody | null`. It returns `null` unless every rule in
- ApiContract.md → Sync body holds:
- - `body` is a plain object (not an array).
- - **Catalog:** `catalog.statuses` is an array of 1–20 plain objects. Each `key` matches
- `/^[a-z][a-z0-9_]{0,39}$/` and no two are equal; `label` is a non-empty string ≤ 30 chars; `shortLabel` a
- non-empty string ≤ 12 chars; `role` a non-empty string ≤ 20 chars.
- - **Snapshot:** `snapshot.builds` is an array of ≤ 50 plain objects:
- - `runId` passes `isUuid`, and no two builds share one.
- - `repo` is a non-empty string ≤ 200 chars.
- - `designNumber` matches `/^\d{3}$/`.
- - `designName` is a non-empty string ≤ 120 chars.
- - `status` equals one of the catalog keys.
- - `stages` is an array of 1–10 non-empty strings.
- - `currentStage` is an integer with `0 ≤ currentStage < stages.length`.
- - `reason` is a string ≤ 300 chars.
- - `pr` is an object whose `position` and `total` are integers with `1 ≤ position ≤ total`; `pr.number` and
- `pr.url` are both `null`, or a positive integer and a string starting with `https://`.
- - `lastEventAt` passes `isUtcTime`.
- - `snapshot.counts` is an object whose `upNext`, `planNotFinished` and `done` are integers ≥ 0.
- - **Events:** `events` is an array of ≤ 500 plain objects:
- - `id` and `runId` pass `isUuid`; no two events share an `id`.
- - `at` passes `isUtcTime`.
- - `repo` and `design` are non-empty strings ≤ 200 chars.
- - `type` is a non-empty string ≤ 60 chars.
- - `pr` is `null`, missing, or an integer ≥ 1.
- - `details` is missing or a plain object.
- - `artifactId` is `null`, missing, or the `id` of an entry in this body's `artifacts`.
- - **Artifacts:** `artifacts` is an array of ≤ 50 plain objects:
- - `id` passes `isUuid`; no two artifacts share one.
- - `kind` is a non-empty string ≤ 40 chars.
- - `at` passes `isUtcTime`.
- - `body` is a plain object and `Buffer.byteLength(JSON.stringify(body), 'utf8') ≤ 262144`.
- - The result keeps `catalog` and `snapshot` exactly as sent (unknown fields included). Each event is rebuilt
- with only the listed fields, with `pr` and `artifactId` defaulting to `null` and `details` to `{}`. Each
- artifact is rebuilt with only `id`, `kind`, `at` and `body`.
- **New `server/src/lib/factoryHistory.ts`:**
- - `export interface FactoryHistory { record(artifacts: FactoryArtifact[], events: FactoryEvent[]): Promise<void> }`.
- Ids it already has are skipped; the first copy stays.
- - `MemoryFactoryHistory`: two public read-only `Map`s, `artifacts` and `events`, keyed by id; `record` sets only
- keys not already present.
- - `PostgresFactoryHistory(sequelize)`: `record` runs at most two statements, each skipped when its array is empty:
- 1. `INSERT INTO factory_artifacts (id, kind, at, body) SELECT id, kind, at, body FROM jsonb_to_recordset($rows::jsonb) AS r(id uuid, kind text, at timestamptz, body jsonb) ON CONFLICT (id) DO NOTHING`
- 2. The same for `factory_events` with columns `id, run_id, at, repo, design, pr, type, details, artifact_id`,
- mapping `runId` → `run_id` and `artifactId` → `artifact_id` in the rows passed as `$rows`.
- 
- Rows are passed with `bind: { rows: JSON.stringify(rows) }`, as `PostgresKV` binds its values.
- - `export async function createFactoryHistory(config: Config): Promise<FactoryHistory>`: memory when
- `config.kvBackend === 'memory'`, otherwise Postgres via `getSequelize()`, throwing the same error as `createKv`
- when there is no database.
- **New `server/src/v1/factory.ts`** exports two routers.
- - **`factoryReportRouter(deps: AppDeps): Router`** with one route, `POST /v1/factory/sync`:
- 1. A local `requireFactoryToken` middleware sends `401 { error: 'unauthorized' }` when any of these holds:
- - `deps.config.factoryReportToken` is null;
- - the `Authorization` header does not match `/^Bearer (\S+)$/`;
- - the SHA-256 digest of the sent token differs from the digest of the configured one, compared with
- `crypto.timingSafeEqual`.
- 2. Then the route's own `express.json({ limit: '5mb' })` parses the body. A router-level error handler placed
- after the route sends `400 { error: 'invalid_sync' }` when `err.type === 'entity.parse.failed'` (malformed
- JSON, or a bare `null` or number, which the parser's strict mode refuses), `413 { error: 'invalid_sync' }`
- when `err.type === 'entity.too.large'`, and passes any other error to `next(err)`.
- 3. `const sync = parseSync(req.body)`; if it is `null`, send `400 { error: 'invalid_sync' }` and store nothing.
- 4. `await deps.factoryHistory.record(sync.artifacts, sync.events)`.
- 5. `await deps.kv.put(FACTORY_SNAPSHOT_KEY, JSON.stringify({ catalog: sync.catalog, snapshot: sync.snapshot, receivedAt: new Date().toISOString() }), FACTORY_SNAPSHOT_TTL_SECONDS)`.
- 6. Send `204`. A thrown error goes to `next(err)`.
- - **`v1FactoryRouter(deps: AppDeps): Router`** with one route, `GET /factory/snapshot`, behind the existing
- `requireAuth`:
- 1. Read `deps.kv.get(FACTORY_SNAPSHOT_KEY)`.
- 2. If the row is missing, send `200 { catalog: null, snapshot: null, receivedAt: null, serverNow }`.
- 3. Otherwise send `200 { ...JSON.parse(row), serverNow }`.
- 4. `serverNow` is `new Date().toISOString()`. A thrown error goes to `next(err)`.
- **`server/src/v1/index.ts`:** mount `v1FactoryRouter(deps)` after `v1AuthRouter(deps)`.
- **`server/src/app.ts`:**
- - Add `factoryHistory: FactoryHistory` to `AppDeps`.
- - `app.use(factoryReportRouter(deps))` right after `app.use(helmet())` and before `app.use(express.json())`, with
- a one-line comment saying the factory token is checked before any body parsing. Nothing else in `app.ts` moves.
- **`server/src/server.ts`:** `const factoryHistory = await createFactoryHistory(config)` after `createKv`, passed to
- `buildApp`.
- **Every existing `buildApp({ … })` call in `server/test/`** (11 files) gains `factoryHistory: new MemoryFactoryHistory()`.
- No other change to those tests.
- **`render.yaml`:** add `FACTORY_REPORT_TOKEN` to the `production` env group as `sync: false`. Its existing
- `preDeployCommand: npm run migrate` runs the new migration on deploy; nothing else changes.
- **`server/.env.example`:** add a commented-out `# FACTORY_REPORT_TOKEN=` with a short comment, in the style of
- `JWT_SECRET`. The comment says: the factory machine sends this token with each push; unset means pushes
- are refused; the same value goes in the factory machine's `~/.factory/env`.

**Tests**

- New `server/test/factorySync.test.ts` (mocha + supertest, built like `server/test/v1.test.ts`):
- - Setup: `JWT_SECRET` is set the same way as in `v1.test.ts`, and `FACTORY_REPORT_TOKEN: 'factory-token'` is
- passed to `loadConfig`. Each app gets a fresh `MemoryKV` and `MemoryFactoryHistory` the test can inspect.
- - A `validSync()` helper returns the example in ApiContract.md, with one event and one artifact.
- **Auth:**
- - `POST` with the factory token and a valid body returns 204.
- - A following `GET` with a signed marge token returns 200. Its `catalog` and `snapshot` deep-equal what was sent,
- including an extra unknown field on a build. `receivedAt` lies between the times before and after the `POST`.
- `serverNow` is an ISO string no earlier than `receivedAt`.
- - `GET` before any `POST` returns 200 `{ catalog: null, snapshot: null, receivedAt: null }` and a `serverNow`.
- - A second `POST` replaces the latest state: the `GET` returns only the second snapshot.
- - `POST` with no `Authorization` header, with a wrong token, or with a valid marge token returns 401
- `unauthorized`.
- - With `FACTORY_REPORT_TOKEN` unset, `POST` with `Bearer factory-token` returns 401 `unauthorized`.
- - `GET` with no token, and `GET` with `Bearer factory-token`, return 401 `unauthorized`.
- - A `POST` with a wrong token and an invalid body returns 401, not 400; so does one with a raw body of `{`, and one
- with a raw body of `null`.
- - A `POST` with the factory token and a raw body of `{` returns 400 `invalid_sync`, and so does one with `null`;
- a following `GET` still returns the earlier snapshot and the history is unchanged.
- - A `POST` with the factory token and a body over 5 MB returns 413 `invalid_sync`.
- **History:**
- - After a valid `POST`, the history holds the one artifact and the one event, with `details` and `artifactId` as
- sent and no unknown fields.
- - Sending the same body twice returns 204 both times and leaves exactly one event and one artifact.
- - Resending an event id with a different `type` keeps the first `type`.
- - An event without `pr`, `details` or `artifactId` is stored with `null`, `{}` and `null`.
- - A heartbeat (`events: []`, `artifacts: []`) returns 204, updates `receivedAt` and adds nothing.
- **Validation:** after a valid `POST`, each of the following bodies returns 400 `invalid_sync`, and `GET` still
- returns the first snapshot with the history unchanged (table-driven `it` per case):
- - no `catalog`, `catalog.statuses: []`, 21 statuses
- - a status key `"Needs you"`, two statuses with the same key, a 31-char `label`, a 13-char `shortLabel`, an empty
- `role`
- - no `snapshot.builds`, 51 builds, two builds with the same `runId`, `runId: "abc"`
- - a build whose `status` is not a catalog key
- - `designNumber: "14"`; empty `designName`, and a 121-char `designName`
- - `stages: []`, 11 stages, and a stage `""`
- - `currentStage` equal to `stages.length`, `-1`, and `1.5`
- - a 301-char `reason`
- - `pr.position: 0`, and `position > total`; `number` set with `url: null`; `url` starting `http://`
- - `lastEventAt: "yesterday"`, `"Thu, 01 Jan 1970 00:00:00 GMT"`, `"2026-02-30T12:00:00Z"`,
- `"2026-13-21T17:32:10Z"` and `"2026-11-21T25:32:10Z"`
- - `counts.done: -1`; no `counts`
- - no `events`; 501 events; two events with the same `id`; an event `id` in upper case; an event with
- `at: "2026-02-30T12:00:00Z"`; an empty `type`; `pr: 0`; `details: []`
- - an event whose `artifactId` is not in this body's `artifacts`
- - no `artifacts`; 51 artifacts; two artifacts with the same `id`; an artifact `body` that is a string; an artifact
- `body` over 262,144 bytes as UTF-8 JSON; a `body` of `{ text: 'é'.repeat(140000) }` (under the limit in characters,
- over it in bytes)
- - a body that is a JSON array
- **Accepted edge values:**
- - A sync with `builds: []` returns 204.
- - A catalog status with `role: "waiting"` (one marge has no look for) returns 204 and comes back unchanged.
- - Two builds with the same `repo` and `designNumber` but different `runId` return 204.
- - `lastEventAt: "2026-11-21T17:32:10.123456Z"` returns 204, and `GET` returns that exact string.
- **Storage:** with a `MemoryKV` whose `put` is wrapped to record its arguments, a valid `POST` stores key
- `factory:snapshot` with TTL `31536000`.
- **Failed push, then resend:** after one good push (body A), push body B with a `MemoryKV` whose `put` throws once.
- The answer is 500 with the app's usual error body, `GET` still returns body A's snapshot, and B's event and
- artifact are already in the history. Sending B again returns 204, `GET` returns B's snapshot, and the history holds
- exactly one copy of B's event and artifact.
- **New `server/test/factoryHistory.test.ts`**, run only when `DATABASE_URL` is set, like `PostgresKV` in
- `kv.test.ts`. It never touches the real tables or the migration records:
- - `before` creates a throwaway schema `factory_history_test_<random>`, opens a `Sequelize` on `DATABASE_URL` with
- `dialectOptions: { options: '-c search_path=<that schema>' }`, and calls the migration module's `up` directly
- as sequelize-cli does, `up(connection.getQueryInterface(), Sequelize)` (the `Sequelize` class from
- `sequelize`); `after` drops the schema with `CASCADE` and closes the
- connection.
- - `record` stores an artifact and an event that points to it; a `SELECT` returns every column as sent, with `at`
- as the same instant.
- - Recording the same ids again leaves one row each and keeps the first content.
- - `record([], [])` runs no statement and does not throw.
- **`server/test/config.test.ts`:**
- - `FACTORY_REPORT_TOKEN=abc` gives `factoryReportToken: 'abc'`.
- - Unset or `''` gives `null`.
- **Regression:** the full existing `server/` suite (`make test-server`) and `make lint-server` pass, with only the
- `factoryHistory` line added to existing tests. Run the migration against the compose Postgres (`make migrate`),
- run `factoryHistory.test.ts` with `DATABASE_URL` set, confirm `npm run migrate:undo` drops both tables, then run
- `make migrate` again.

**Screenshots it must match**

- none

**"Done when" items it delivers**

- 18. 18. Every event and report the factory sends is kept in marge's database exactly once, even when the factory sends it again, ready for the build detail screen.

## PR 2 — feature: show what the factory is building and what needs attention

Once merged, `/factory` shows every build in flight, which stage each one is at, and whether it needs you, has
stopped or has gone quiet, using the factory's own status list. It refreshes itself every 30 seconds and says
plainly when the factory machine has stopped reporting or hasn't reported yet.

**Changes**

- **`client/src/auth/session.ts`:** add `export function readToken(): string | null`, which returns
- `localStorage.getItem('token')`. This keeps the key name in one file.
- **New `client/src/factory/snapshot.ts`:**
- - Types, exactly as in ApiContract.md (the client reads no history):
- - `CatalogStatus` (`key`, `label`, `shortLabel`, `role`) and `FactoryCatalog` (`statuses: CatalogStatus[]`)
- - `FactoryBuild` (with `runId: string` and
- `pr: { position: number; total: number; number: number | null; url: string | null }`)
- - `FactorySnapshot` (`builds`, `counts`)
- - `SnapshotResponse`: either `{ catalog: FactoryCatalog; snapshot: FactorySnapshot; receivedAt: string; serverNow: string }`
- or `{ catalog: null; snapshot: null; receivedAt: null; serverNow: string }`
- - `fetchFactorySnapshot(): Promise<SnapshotResponse>`. It `axios.get`s
- `${import.meta.env.VITE_SERVER_BASE_URL}/v1/factory/snapshot` with
- `headers: { Authorization: \`Bearer ${readToken()}\` }` and `timeout: 15_000`, and returns `data`. A request
- with no answer after 15 s fails like a network error, so the page shows "Couldn't load" (ApiContract.md, no
- answer).
- **New `client/src/factory/overview.ts`** (pure functions, no React). The server guarantees every build's status
- is in the catalog (ApiContract.md), so these functions never invent a label.
- - `const ROLES = ['attention', 'failure', 'quiet', 'active', 'complete']`, the roles marge has a look for
- (Design.md decision 5).
- - `statusOf(catalog, key)`: the catalog entry with that key.
- - `roleClass(role)`: `role-<role>` for a role in `ROLES`, otherwise `role-neutral` (Design.md decision 6).
- - `sortBuilds(catalog, builds)`: returns a new array with every `complete`-role build after every other build, and
- within those two groups ordered by the status's index in `catalog.statuses`, then `lastEventAt` ascending (compared by `Date.parse`), then `repo` ascending, then `designNumber` ascending.
- - `inFlight(catalog, builds)`: the builds whose status's role is not `complete`.
- - `countLine(catalog, builds)`: one entry per status present among `inFlight(catalog, builds)`, in catalog order,
- each `{ key, count, label, shortLabel, role }` with the catalog's `label` and `shortLabel`.
- - `formatAge(ms)`: Design.md decision 16, with negative values treated as 0.
- - `< 60 000` → "N s"
- - `< 3 600 000` → "N min"
- - otherwise "H h M min", or "H h" when M is 0
- - `ageMs(serverNow, at)`: `Date.parse(serverNow) − Date.parse(at)`.
- - `OUT_OF_DATE_MS = 3 * 60 * 1000`
- - `isOutOfDate(response)`: true when `receivedAt` is set and `ageMs(serverNow, receivedAt) > OUT_OF_DATE_MS`.
- - `repoName(repo)`: the part after the last `/`.
- **New `client/src/factory/useFactorySnapshot.ts`:** the hook returns
- `{ state: { kind: 'loading' } | { kind: 'error' } | { kind: 'loaded'; data: SnapshotResponse }, retry: () => void }`.
- - **First fetch:** the state starts at `loading`. On mount it fetches at once only if
- `document.visibilityState === 'visible'`; otherwise the first fetch waits for the tab to become visible
- (Design.md decision 10), and `loading` shows until then.
- - **Polling:** while `document.visibilityState === 'visible'`, a `setInterval` fetches every 30 000 ms. On
- `visibilitychange`:
- - to hidden: clear the interval;
- - to visible: fetch at once and start the interval again. If a fetch is still pending (sent at most 15 s ago,
- given the timeout), no second one is sent: that pending answer is the fresh one, and the interval restarts.
- - **Overlap:** a fetch starts only when none is in flight (tracked with a ref), so answers never arrive out of order.
- The ref is cleared in a `finally`, so a failed or timed-out fetch never blocks the next one.
- - **Results:**
- - Success sets `loaded`.
- - Any failure except 401 sets `error`.
- - The loaded list is never kept under an error (Design.md decision 10).
- - `loading` is never set again after the first fetch.
- - **401:** call `clearSession()` and `navigate('/?redirectTo=%2Ffactory', { replace: true })`.
- - **`retry`:** fetches at once, following the same in-flight rule.
- - **Unmount:** clears the interval and the listener, and ignores later answers.
- **New `client/src/factory/FactoryOverview.tsx`:** renders the body below the "Software Factory" heading for each
- state, matching the screenshots. All ages use `serverNow` from the answer.
- - **`loading`:** a placeholder bar where the count line goes and three placeholder rows, with
- `aria-busy="true"` and an accessible label "Loading the factory".
- - **`error`:**
- - The panel: "Couldn't load the factory" / "marge's server didn't answer. Nothing has changed in the factory
- itself."
- - A "Try again" button that calls `retry`.
- - **`loaded` with `snapshot: null`:**
- - Under the heading: "No report yet".
- - The panel: "Not connected yet" / "The factory machine hasn't sent its first report. This page fills in once
- it does."
- - No "Updated" time and no footer.
- - **`loaded` with `inFlight(catalog, builds)` empty:**
- - Under the heading: "Nothing running", plus "Updated … ago" (orange when out of date, as below).
- - The panel: "Nothing in flight" / "No design is being built right now. A design starts here once its plan is
- finished and merged."
- - Below the panel, one `BuildRow` per `complete` build in `sortBuilds` order (none when there are none).
- - The footer.
- - **`loaded` with builds in flight:**
- - **Count line:** per `countLine` entry, a dot in the role's colour and "{label} {count}" ("Needs you 2"). The
- phone shows "{shortLabel} {count}" ("You 2").
- - **"Updated … ago":** "Updated" is desktop-only; the time turns orange when out of date.
- - **Desktop column headings:** Status, Design, Stage, Last news.
- - **Rows:** one `BuildRow` per build (complete ones included, last) in `sortBuilds` order, keyed by `runId`.
- - **Footer:** "NOT IN FLIGHT" (desktop-only) and "Up next N · Plan not finished N · Done N".
- - **Out-of-date banner:** for any non-null snapshot (with or without builds in flight) when `isOutOfDate`, above
- the list or panel. Desktop reads "The factory machine hasn't reported
- for {formatAge}." / "This is what it said last. Builds may have moved on since." Phone reads "Factory machine
- silent for {formatAge}" / "Showing its last report. Builds may have moved on since." The list
- below (or the panel and done rows when nothing is in flight) gets a dimmed class (`opacity: 0.5`), and its links
- keep working. The footer is outside the dimmed block and stays at full strength, as in the screenshots.
- - **`BuildRow`:**
- - **Status chip:** the catalog `label`, styled by `roleClass(role)`. A `quiet` chip appends " {whole hours} h"
- when `ageMs(serverNow, lastEventAt) ≥ 1 h`.
- - **Design:** "{designNumber} {designName}".
- - **Line under the design:** "{repoName} · PR {position} of {total}" (desktop). On the phone the repo moves next
- to the chip.
- - **Stage track:** one segment per stage. Every segment shows its label on desktop only. Each segment's style
- follows its index `i` against `currentStage`:
- - `i < currentStage` (passed): bar `#AEB9D080`, label `--text-muted`.
- - `i === currentStage` (current): bar and label in the status colour, and `aria-current="step"`.
- - `i > currentStage` (still to come): bar `#FFFFFF14`, label `--dim`.
- - For a `complete` role, every bar is green (`#4CC38A99`), every label `--text-muted`, and no segment is
- current.
- - **Motion (Design.md decision 18):** only when the status's role is `active` and the page is not out of date, the row
- gets a `build-row--moving` class. Under it, a "live dot" inside the chip pulses and a highlight sweeps across
- the current segment, both CSS `@keyframes` on a ~2 s loop. A `@media (prefers-reduced-motion: reduce)` rule
- turns both animations off. No other row has the class.
- - **Reason line:** the reason. On the phone it is prefixed by a mobile-only span "{current stage name} · PR x of
- y — ".
- - **"Last news":** "{formatAge} ago".
- - **Link:** only when the status's role is `attention` and `pr.url` is set, an
- `<a href={pr.url} target="_blank" rel="noopener noreferrer">` reading "Open PR #{number} ↗".
- - **Row edge:** coloured for `attention`, `failure` and `quiet`; none for `active`, `complete` and
- `role-neutral`.
- - **Colours:** `--danger #b42318`, `--no-progress #f0a35e`, `--surface #1c2b4b`, `--dim #5c6a88`,
- `--sky-deep #5e9fd0`, `--done #4cc38a` and `--done-text #7ee0ae` are added to `:root` in `styles.css` where the
- canvas uses them. By role: `attention` uses `--sun`, `failure` `--danger`, `quiet` `--no-progress`, `active`
- `--sky`, `complete` a `--done` chip at 20% with `--done-text` text, and `role-neutral` a `--text-muted` chip on
- `--ink`.
- **`client/src/pages/FactoryPage.tsx`:**
- - Keep the header and the `<h1>`.
- - Replace the `empty-panel` section with `<FactoryOverview {...useFactorySnapshot()} />`.
- - Remove the `FactoryIcon` import only if nothing uses it any more.
- **`client/src/styles.css`:**
- - Add the overview styles in the file's existing BEM style.
- - Add a `.mobile-only` class (hidden above 768px), the counterpart to `.desktop-only`.
- - Reuse `.empty-panel` for the three message panels.
- - Each state matches its screenshots at 1440×900 and 390×844, with no sideways scrolling.

**Tests**

- **New `client/src/factory/overview.test.ts`** (a `catalog()` helper returns the catalog in ApiContract.md):
- - **`sortBuilds`:**
- - Orders builds by catalog position: needs_you, stopped, no_progress, running, then done.
- - With the catalog reordered (running first), running builds come first.
- - With `done` moved ahead of `running` in the catalog, done builds still come last.
- - Within one status, the oldest `lastEventAt` comes first: the busy screenshots' needs-you rows (25 min, then
- 8 min) and running rows (6, 4, 2, then 1 min) come out in that order.
- - Ties in both fall back to `repo`, then `designNumber`.
- - Does not mutate its input.
- - **`roleClass`:** each of the five roles gives `role-<role>`; "waiting" gives `role-neutral`.
- - **`countLine`:**
- - Lists only the statuses present, in catalog order, with the right counts, labels and short labels; two
- needs_you builds give `{ label: 'Needs you', shortLabel: 'You', count: 2 }`.
- - A status added to the catalog (`paused`, label "Paused", role `waiting`) gets its own entry.
- - A `complete` build adds no entry.
- - **`formatAge`:**
- - 12 000 → "12 s"
- - 59 999 → "59 s"
- - 60 000 → "1 min"
- - 3 599 999 → "59 min"
- - 3 600 000 → "1 h"
- - 4 200 000 → "1 h 10 min"
- - −5 000 → "0 s"
- - **`isOutOfDate`:**
- - false at exactly 3 min;
- - true at 3 min 1 s;
- - false when `receivedAt` is null.
- **`client/src/App.test.tsx` and `client/src/pages/LandingPage.test.tsx`:** both assert the removed text "Control
- panel not built yet". Mock `client/src/factory/snapshot.ts` (`vi.mock('./factory/snapshot')` in `App.test.tsx`,
- `vi.mock('../factory/snapshot')` in `LandingPage.test.tsx`; `fetchFactorySnapshot` resolving to the all-null "not connected
- yet" response), and change those two assertions to wait for "Not connected yet". The test names become
- "/factory signed in shows the factory overview" and keep their routing checks (the `/factory` path after the
- redirect) unchanged.
- **New `client/src/factory/snapshot.test.ts`** (axios mocked as in `signIn.test.ts`): `fetchFactorySnapshot` calls
- `…/v1/factory/snapshot` with `Authorization: Bearer <stored token>` and returns the response data, passing `timeout: 15000`.
- **`client/src/pages/FactoryPage.test.ts(x)`:** extend the existing file. `axios.get` is mocked; the existing
- heading, back-link and sign-out tests stay and pass with a normal response.
- - **Normal:**
- - The two builds from ApiContract.md (plus a running and a stopped build) appear in sort order with their
- chips, "{number} {name}", repo, "PR x of y", reason and "… ago" text.
- - The current stage is marked with `aria-current="step"`.
- - For the running build at stage 1 of 5 ("Review gate"), segment 0 has the passed class, segment 1 the current
- class and segments 2–4 the still-to-come class.
- - **Count line:** reads "Needs you 1", "Stopped 1", "No progress 1" and "Running 1"; with two needs_you builds it
- reads "Needs you 2".
- - **Updated time:** "Updated 12 s ago" when `serverNow − receivedAt` is 12 s.
- - **Open PR:**
- - Only the needs_you build with a PR shows a link named "Open PR #812".
- - Its `href` is the PR url, `target="_blank"` and `rel` includes `noopener`.
- - A needs_you build with `pr.url: null` shows no link.
- - **No-progress chip:** with `lastEventAt` 70 min before `serverNow`, the chip reads "No progress 1 h".
- - **Status the factory added:** with `{ key: 'paused', label: 'Paused', shortLabel: 'Paused', role: 'waiting' }`
- placed after no_progress in the catalog:
- - A `paused` build shows a "Paused" chip with the `role-neutral` class, between the no_progress and running
- builds, with no row edge and no `build-row--moving` class.
- - The count line includes "Paused 1".
- - **Renamed status:** with the catalog label for `running` changed to "Building", the running chip and count line
- read "Building".
- - **Footer:** shows "Up next 3", "Plan not finished 1" and "Done 22".
- - **Done build:** a `done` build is listed last with a "Done" chip, no link, no marked current stage, and the
- count line has no "done" entry.
- - **Motion:**
- - Only the running build's row has the `build-row--moving` class.
- - With the page out of date, no row has it.
- - **Out of date:**
- - With `receivedAt` 14 min before `serverNow`, the banner reads "The factory machine hasn't reported for
- 14 min" and the builds are still listed.
- - At 2 min, there is no banner.
- - With `builds: []` and with only a `done` build, at 14 min the banner shows, the "Updated" time has the orange
- class, the panel has the dimmed class and the footer does not.
- - **Nothing in flight:**
- - `builds: []` shows "Nothing in flight" and the footer counts, but not "Not connected yet".
- - With only a `done` build, "Nothing in flight" shows and the done build is listed below it.
- - **Not connected yet:** `catalog: null, snapshot: null` shows "Not connected yet" and "No report yet", with no footer and no
- "Updated".
- - **Loading:** while the first `get` is pending, the loading placeholder (by its label) is shown.
- - **Error:**
- - A 500 shows "Couldn't load the factory".
- - Clicking "Try again" with a good answer queued shows the builds.
- - A network error shows the same message.
- - **Stalled request** (fake timers): a first `get` that never settles shows "Couldn't load the factory" after
- 15 s (axios's timeout, simulated by rejecting with `ECONNABORTED`), and the next poll at 30 s with a good answer
- shows the builds.
- - **Refresh failure** (fake timers):
- - After a good first load, a failing fetch at 30 s replaces the list with "Couldn't load the factory".
- - A good fetch at 60 s brings the list back.
- - **Polling** (fake timers):
- - `get` is called again after 30 s.
- - With `document.visibilityState` stubbed to `hidden` and `visibilitychange` dispatched, no call happens over
- the next 60 s.
- - Switching back to `visible` calls at once.
- - Hiding while a call is pending and switching back before it answers sends no second call; when it resolves the
- page shows its data, and the next call comes 30 s after the switch.
- - **Mounted while hidden:** with `document.visibilityState` stubbed to `hidden` before render, no call happens
- over the next 60 s and the loading placeholder shows; switching to `visible` calls at once and shows the
- builds.
- - **401:** clears `localStorage` and lands on `/` with `redirectTo=%2Ffactory` in the search.
- **Regression:** the full existing `client/` suite (`npm test`), `npm run lint` and `npm run build` pass.
- **Browser check before opening the PR** (layout, motion and the screenshots cannot be checked in jsdom):
- 1. Start a fresh server with the values from `server/.env.example` (`BASE_URL`, `CLIENT_ORIGINS`), plus
- `KV_BACKEND=memory`, `NODE_ENV=development`, any `JWT_SECRET` and `FACTORY_REPORT_TOKEN=dev-token`, and the
- client with `VITE_SERVER_BASE_URL` pointing at it; sign in through `/dev-user`. Before any push,
- capture the not-connected state.
- 2. For each of the normal, busy, nothing-in-flight-with-one-done and out-of-date states, `POST /v1/factory/sync`
- with `Bearer dev-token` and a body that reproduces it, then reload. For out of date, stop pushing and wait past
- 3 minutes.
- 3. Stop the server and, on the same port, run a listener that accepts connections and never answers (a few lines
- of `python3` with `socket`). Reload: the request hangs, so capture the loading state at once; after 15 seconds
- the request times out, so capture the couldn't-load state.
- 4. Capture each state at 1440×900 and 390×844 with the gstack `/browse` skill as full-page captures (the busy
- states scroll vertically, as their screenshots do), compare each with its screenshot,
- and attach the captures to the PR.
- 5. At 390 wide, check `document.documentElement.scrollWidth <= 390` in every state.
- 6. Check that the running rows' dot and current segment animate, that nothing animates once the page is out of
- date, and that nothing animates with `prefers-reduced-motion: reduce` emulated.

**Screenshots it must match**

- `screenshots/overview--normal-desktop.png`
- `screenshots/overview--normal-mobile.png`
- `screenshots/overview--busy-desktop.png`
- `screenshots/overview--busy-mobile.png`
- `screenshots/overview--out-of-date-desktop.png`
- `screenshots/overview--out-of-date-mobile.png`
- `screenshots/overview--nothing-in-flight-desktop.png`
- `screenshots/overview--nothing-in-flight-mobile.png`
- `screenshots/overview--not-connected-desktop.png`
- `screenshots/overview--not-connected-mobile.png`
- `screenshots/overview--loading-desktop.png`
- `screenshots/overview--loading-mobile.png`
- `screenshots/overview--error-desktop.png`
- `screenshots/overview--error-mobile.png`

**"Done when" items it delivers**

- 1. 1. With the factory reporting, `/factory` lists every build in flight with its status chip, design number and name, repo, "PR x of y", stage track with the current stage highlighted, reason line and "Last news … ago", on desktop and phone.
- 2. 2. Builds are ordered by the factory's status list (today: needs you, stopped, no progress, running, done), and within each status the one with the oldest news comes first.
- 3. 3. The count line under the heading shows each status present with how many builds have it ("Needs you 2 · Running 4"), and "Updated … ago" shows how long ago marge heard from the factory.
- 4. 4. A "needs you" build with a pull request shows "Open PR #N ↗", which opens that pull request on GitHub in a new tab; no other row shows a button.
- 5. 5. The footer shows "Up next", "Plan not finished" and "Done" counts from the factory.
- 6. 6. When marge hasn't heard from the factory for more than 3 minutes, the page shows the out-of-date banner with how long it has been silent, the "Updated" time turns orange and the last list stays visible dimmed.
- 7. 7. When the factory reports no builds in flight, the page shows "Nothing in flight" with the footer counts, and any build finished in the last day below it.
- 8. 8. Before the factory has ever reported, the page shows "Not connected yet", not "Nothing in flight".
- 9. 9. While the first fetch is in progress, the page shows placeholder rows.
- 10. 10. When marge's server can't be reached, the page shows "Couldn't load the factory" with "Try again", and it recovers by itself once the server answers.
- 11. 11. With the tab left open, the list updates within 30 seconds of a new report, and it stops fetching while the tab is hidden.
- 12. 12. A status the factory adds or renames shows on the page with the factory's label and in the factory's order after its next push, with no change to marge; one whose role marge has no look for shows on a grey chip with no motion.
- 13. 13. A report sent without the factory token, or with a wrong one, is refused and the page keeps showing the previous report.
- 14. 14. If the server rejects the stored sign-in, the page returns to the landing page and signing in again comes back to `/factory`.
- 15. 15. Every state fits a 390-pixel-wide phone with no sideways scrolling.
- 16. 16. A running build visibly moves (pulsing dot, shimmering current stage); no other row moves, nothing moves while the page is out of date, and nothing moves on a device set to reduce motion.
- 17. 17. A build the factory finished in the last day shows at the bottom of the list with a green "Done" chip and a fully green track, and is not counted in the line under the heading.

<!-- factory: finished plan for design 16693d066d08b92179e7f8dbea21483e5bd98873b4eefaf5d3b834f05a76566b, plan f4c82f85846f2a060dd6ab9312500c08ad145ac428ca26f8421611800369e08b. Any edit to this file or the design undoes it; run "factory finalize" again. -->
