# 003 — PR Reviewer: model changes

Five new tables in marge-web's Postgres, one migration, no backfill. Naming follows the existing migrations (snake_case, `created_at`/`updated_at` timestamps). Nothing existing changes.

## `pr_reviewer_runs` — new

One row per generation of one PR revision. The row is also the job: its status, lease and attempt columns drive the in-process runner (D8).

| column | type | null | value comes from |
|---|---|---|---|
| `id` | UUID, PK, default v4 | no | generated |
| `org` | TEXT | no | URL path |
| `repo` | TEXT | no | URL path |
| `pr_number` | INTEGER | no | URL path |
| `head_sha` | TEXT | no | GitHub at run creation (pinned) |
| `base_sha` | TEXT | no | GitHub merge base at run creation (pinned) |
| `pipeline_version` | TEXT | no | code constant; bumping it lets a reshaped pipeline regenerate without colliding with old runs |
| `status` | TEXT | no | runner: `queued` → `generating` → `ready` / `failed` |
| `progress` | JSONB | yes | runner; `{ stage, completedChapters?, totalChapters? }` while generating, null otherwise |
| `failure` | TEXT | yes | runner; plain-English failure line when `failed` |
| `failure_detail` | TEXT | yes | runner; underlying error text for the failed screen's collapsed detail |
| `lease_expires_at` | TIMESTAMPTZ | yes | runner heartbeat; null when unclaimed — expired leases get reclaimed on startup/poll |
| `lease_token` | UUID | yes | runner; a fresh token minted on every claim, never reused — every later write by that worker is fenced on it, so a stalled worker whose run was reclaimed (or retried) can never overwrite the new claimant |
| `attempt` | INTEGER, default 0 | no | runner; bounds automatic retries only; an explicit Retry resets it to 0 |
| `pr_meta` | JSONB | no | GitHub at creation: `{ title, url, baseRef, headRef, commits }` — returned on every run response so non-ready screens can render their header |
| `created_at` / `updated_at` | TIMESTAMPTZ | no | standard |

Unique index on `(org, repo, pr_number, head_sha, base_sha, pipeline_version)` — this is the find-or-create key that makes two visitors share one run. Index on `(status, lease_expires_at)` for the runner's claim query.

## `pr_reviewer_stage_outputs` — new

Content-addressed cache of validated LLM stage results — the crash-recovery and cheap-retry mechanism. Rows are written as each stage call completes and read by any later attempt with the same inputs. Not tied to a run: the key already encodes everything that determines the output.

| column | type | null | value comes from |
|---|---|---|---|
| `cache_key` | CHAR(64), PK | no | sha256(stage, prompt version, model, effort, canonical stage input) — ported from chapters (reference §6.3) |
| `stage` | TEXT | no | pipeline (`outline` / `write` / `summarize`); for observability and cleanup, not lookup |
| `output` | JSONB | no | `{ output, fallbackUsed }` — the schema-validated stage result or its deterministic fallback, with its provenance, so a cache hit on recovery restores `document.fallbacks[]` correctly |
| `created_at` | TIMESTAMPTZ | no | standard |

## `pr_reviewer_documents` — new

The assembled reading document — the extended chapters.json v1 (reference §7 + PR-mode `pr` field), **stored verbatim as the Assemble stage emits it and served verbatim by the chapters endpoint**. One document per run. Persisted so reading survives git-cache eviction and redeploys (D4).

| column | type | null | value comes from |
|---|---|---|---|
| `run_id` | UUID, PK, FK → `pr_reviewer_runs` ON DELETE CASCADE | no | runner at publish |
| `document` | JSONB | no | the assembled chapters document |
| `created_at` | TIMESTAMPTZ | no | standard |

Written in one transaction together with setting the run `ready` and the `pr_reviewer_run_files` rows — a run is never `ready` without its complete document.

## `pr_reviewer_run_files` — new

Full text of the run's changed **markdown** files at the pinned `headSha`, for the rendered-markdown view (markdown reference §2). Captured during extraction, while the git cache directory is still pinned, under the reference's rules: non-deleted, non-binary `.md`/`.markdown` paths in the diff, at most 1 MB each; persisted in the publish transaction. A file outside those rules gets no row, and the client falls back to the code view.

| column | type | null | value comes from |
|---|---|---|---|
| `run_id` | UUID, FK → `pr_reviewer_runs` ON DELETE CASCADE | no | runner at publish |
| `path` | TEXT | no | the file's diff path |
| `text` | TEXT | no | full file content at the run's `head_sha` |
| `created_at` | TIMESTAMPTZ | no | standard |

PK `(run_id, path)`.

## `pr_reviewer_chapter_reviews` — new

Per-user reviewed marks. Row presence means reviewed (D7). Keyed by the document's stable `chapters[].key`.

| column | type | null | value comes from |
|---|---|---|---|
| `run_id` | UUID, FK → `pr_reviewer_runs` ON DELETE CASCADE | no | URL |
| `chapter_key` | TEXT | no | URL (`chapters[].key` from the run's document) |
| `user_email` | TEXT | no | marge JWT `email` (lowercased at sign-in) |
| `created_at` | TIMESTAMPTZ | no | standard |

PK `(run_id, chapter_key, user_email)`.

## Considered and left out

- **FK to `users` for reviews** — the `users` table exists but no code writes rows to it; the JWT email is the identity actually in use everywhere. Adding the FK would mean building user-row provisioning this slice doesn't need.
- **Per-chapter rows instead of one document** — the ported UI renders the whole document at once (reference behavior); splitting it would add a reassembly step and an adapter schema for no reader benefit.
- **A `summary` column on runs** — the document holds `title`/`summary`; copying them onto the run row would be a denormalized copy.
- **A separate `jobs` table** — the run row already carries status/lease/attempt; a second table would duplicate its lifecycle.
- **`reviewed_count` on runs** — derivable by counting `pr_reviewer_chapter_reviews`.
- **Raw diff storage** — the diff lines live inside the document's `files[].hunks`; storing them again would be a denormalized copy.
- **Clone/cache bookkeeping columns** — the git cache is ephemeral by design (D4); recording its paths in durable storage would invert that.
- **`run_id` on `stage_outputs`** — the cache is content-addressed and shared across attempts; tying rows to a run would break reuse on retry.

## Deploy-time impact

- **Migration:** one new migration file creating the five tables (runs automatically via Render's `preDeployCommand: npm run migrate`).
- **INFRA:** `render.yaml` moves `marge-api-db` from `plan: free` to `plan: basic-256mb` (D5 — free Postgres expires after 30 days with no backups). Render applies plan changes from the blueprint, but verify the upgrade took effect in the dashboard on the first deploy.
- **INFRA:** the production server image must install `git` (the pipeline shells out to it); today's Dockerfile does not include it.
- **ENV:** `ANTHROPIC_API_KEY` (LLM calls), `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY` (marge-reviewer App installation tokens for reads) added to the `production` env var group as dashboard-managed secrets (`sync: false`).
