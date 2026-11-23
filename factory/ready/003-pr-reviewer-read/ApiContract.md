# 003 — PR Reviewer: API contract

All endpoints are owned by marge-web (`server/`). New endpoints mount under `/v1/pr-reviewer` behind the existing `authenticate` middleware (Bearer marge JWT, HS256, payload `{ email, name }`). The user's identity for reviewed marks is the JWT `email`.

GitHub reads (PR metadata, merge base, head SHA) happen server-side with marge-reviewer GitHub App installation tokens; the client never talks to GitHub in this slice.

When the server runs without the reviewer configured (no database — the existing `KV_BACKEND=memory` mode — or missing reviewer credentials), every `/v1/pr-reviewer` route answers `503 { "error": "pr_reviewer_unavailable" }`; the rest of marge-web is unaffected.

## The `run` JSON (shared by every endpoint that returns a run)

```json
{
  "id": "0d4f8a1e-6c2b-4b4e-9a1a-2f6f1f1f9b3c",
  "org": "playola-radio",
  "repo": "playola",
  "prNumber": 123,
  "headSha": "ef9d1d7a8c0b4a5d9e2f3a4b5c6d7e8f9a0b1c2d",
  "baseSha": "2f26b5d1c3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8",
  "pipelineVersion": "1",
  "status": "generating",
  "progress": { "stage": "write", "completedChapters": 3, "totalChapters": 7 },
  "failure": null,
  "failureDetail": null,
  "pr": {
    "title": "Fix flaky tests by cutting slow git setup work",
    "url": "https://github.com/playola-radio/playola/pull/123",
    "baseRef": "main",
    "headRef": "brian-keane/chapters-flaky-test-fix",
    "commits": 3
  },
  "createdAt": "2026-11-22T17:30:00.000Z",
  "updatedAt": "2026-11-22T17:31:12.000Z"
}
```

- `status` is one of `queued | generating | ready | failed`.
- `progress.stage` is one of `fetch | extract | outline | write | summarize`; `completedChapters`/`totalChapters` are present only during `write`.
- `failure` is a plain-English line when `status` is `failed` ("Generation failed while writing chapter 3"), else null. `failureDetail` is the underlying error text (for the failed screen's collapsed detail), else null.
- `pr` is the metadata pinned at run creation (stored `pr_meta`) — present on **every** run response, so the generating and failed screens can render their header without a ready document.

## GET `/v1/pr-reviewer/:org/:repo/pulls/:prNumber/runs/latest` — new

The page's entry point and the **freshness check**. Resolves the PR live via GitHub (App installation token) and returns its current revision alongside the run to read — `run`: the newest **ready** run for the PR when one exists, otherwise the most recently created run whatever its status (`null` when the PR has no runs) — plus `newerRun`: the most recently created run (full run JSON, so the client has its id and status), present **only** when it differs from `run`. Preferring ready for `run` keeps chapters readable on a fresh load while someone else's newer run is still generating; `newerRun` is how the client learns that newer run exists and offers **View latest** without replacing the readable document. **Read-only: never creates or enqueues anything.**

Response `200`:

```json
{
  "pr": {
    "title": "Fix flaky tests by cutting slow git setup work",
    "url": "https://github.com/playola-radio/playola/pull/123",
    "baseRef": "main",
    "headRef": "brian-keane/chapters-flaky-test-fix",
    "commits": 3,
    "currentHeadSha": "aa11bb22…",
    "currentBaseSha": "2f26b5d1…"
  },
  "run": { "…": "run JSON above, or null when the PR has no runs yet" },
  "newerRun": { "…": "run JSON of the most recently created run — only present when it differs from run" }
}
```

The page compares `run.headSha` with `pr.currentHeadSha` and `run.baseSha` with `pr.currentBaseSha`: the run is current only when both match; otherwise show the superseded banner with **Generate for latest**. Offer **View latest** instead only when the newer run matches both current SHAs; report its status and open it on that explicit action. An outdated newer run does not replace **Generate for latest**. The client re-checks on page load and when the window regains focus.

Errors: `404 { "error": "pr_not_found" }` (no such open PR, or repo not readable by the App installation); `401` from middleware.

## POST `/v1/pr-reviewer/:org/:repo/pulls/:prNumber/runs` — new

Find or create the run for the PR's **current** head revision. Resolves the PR via GitHub, pins `headSha`/`baseSha`, and either returns the existing run for that revision (`200`) or creates one and enqueues generation (`201`). Called on first visit when `runs/latest` returned `run: null`, and by **Generate for latest**.

Empty-diff detection happens during that GitHub resolution, before any run row exists: the same `base…head` compare call that yields the merge-base `baseSha` also reports the net changed files, so a branch whose commits cancel out (a change followed by its revert) answers `422 empty_diff` — commit count is never used, and no git work runs in the request path. Find-or-create is atomic on the revision's unique key (insert with unique-conflict recovery), so two concurrent first visits both receive the same run and exactly one row and one enqueued generation exist.

Request body: none (everything comes from the path and GitHub).

Response `200`/`201`: `{ "run": { … } }` (run JSON above).

Errors: `404 { "error": "pr_not_found" }`; `422 { "error": "empty_diff" }` (no changes between merge base and head — no run is created); `401` from middleware.

## GET `/v1/pr-reviewer/runs/:runId` — new

Poll a run's status while `queued`/`generating`. Response `200`: `{ "run": { … } }`.

Errors: `404 { "error": "run_not_found" }`.

## POST `/v1/pr-reviewer/runs/:runId/retry` — new

Re-enqueue **this** failed run — the same pinned revision, even if the PR has since gained commits (Design.md: Retry retries the same revision; cached stage outputs make it cheap). Resets the run to `queued`, resets `attempt` to 0 (renewing the runner's automatic-attempt budget), and clears `failure`/`failureDetail`.

Response `200`: `{ "run": { … } }`.

Errors: `404 { "error": "run_not_found" }`; `409 { "error": "run_not_failed" }` when the run isn't `failed`.

## GET `/v1/pr-reviewer/runs/:runId/chapters` — new

The full reading document for a `ready` run, plus the caller's reviewed marks.

Response `200`:

```json
{
  "run": { "…": "run JSON above" },
  "document": { "…": "the stored chapters document, verbatim" },
  "reviewed": ["setup-timeouts", "retry-logic"]
}
```

`document` is the **chapters.json version 1 schema from `reference/chapters-mvp-design.md` §7, served verbatim** — `version`, `repo`, `branch`, `baseRef`/`baseSha`/`headSha`, `generatedAt`, `model`, `promptVersion`, `fallbacks[]`, `title`, `summary`, `commits[]`, `files[]` (with hunks and per-line `runId`), `runs[]`, `chapters[]` (`key`, `number`, `headline`, `intro`, `runIds`, `steps[]`), `excluded[]` — plus the PR-mode extension `pr: { number, title, url, host, owner, repo }` from `reference/chapters-pr-mode-design.md` §5. The pipeline assembles exactly this document and it is stored and served without reshaping, so the client renders it unchanged. The "not in a chapter" rail section comes from `document.excluded`; the file-order view from `document.files`/`document.runs`.

`reviewed` lists the `chapters[].key` values the **calling user** has marked on this run.

Errors: `404 { "error": "run_not_found" }`; `409 { "error": "run_not_ready", "run": { … } }` when the run is not `ready` (client goes back to polling).

## GET `/v1/pr-reviewer/runs/:runId/files?path=<path>` — new

The full text of one changed **markdown** file at the run's pinned `headSha`, for the rendered-markdown view (`reference/chapters-markdown-rendered-diff-design.md` §2). Served from rows persisted at publish time, so it keeps working after git-cache eviction and redeploys.

Response `200`: `{ "path": "README.md", "text": "…whole file…" }`.

Allow-list and caps are applied at capture time, per the reference's §1/§2 rules: only non-deleted, non-binary `.md`/`.markdown` files in the run's diff, at most 1 MB, are stored. Errors: `404 { "error": "file_not_available" }` for any other path (the client falls back to the code view per the reference's §5); `404 run_not_found`.

## PUT `/v1/pr-reviewer/runs/:runId/chapters/:chapterKey/reviewed` — new

Idempotently mark a chapter reviewed for the calling user. Response `204`. Errors: `404` (run unknown, or `chapterKey` not in the run's document).

## DELETE `/v1/pr-reviewer/runs/:runId/chapters/:chapterKey/reviewed` — new

Idempotently clear the mark. Response `204`. Errors: `404` (run or chapter unknown; deleting an absent mark is still `204`).

## Existing endpoints the page uses — unchanged

- `POST /v1/auth/google/signin` — existing Google sign-in; issues the marge JWT. Unchanged. Request: `{ "code": "google-authorization-code" }`. Response `200`: `{ "margeToken": "<JWT>" }`. Errors: `400 { "error": "invalid_request" }` (missing or invalid code); `401 { "error": "sign_in_failed" }` (Google rejects the code or email is unverified); `403 { "error": "not_approved" }` (email not allowlisted); `500 { "error": "internal_error" }` (configuration or unexpected exchange failure).
- `GET /v1/me` — existing identity check used by `ProtectedRoute`. Response: `{ "user": { "email": "user@playola.fm", "name": "User Name", "iat": 1795380000, "exp": 1795989600 } }`. Unchanged.

## Client-side model changes

None stored. The page holds fetch/poll state only; reviewed marks are optimistically toggled and reconciled from the server response. The Rendered/Code toggle per markdown block is component state, lost on reload (reference §1).
