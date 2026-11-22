# 002 — Model changes

Two new tables keep the factory's build history: every event it reports, and the reports those events point to.
They are written by `POST /v1/factory/sync` (ApiContract.md) and read by nothing in 002. Design 003's build detail
screen reads them (Design.md decision 20). The latest state is not a table: it stays one row in the existing
`kv_store`, replaced on every push.

Migration: `server/src/db/migrations/20261122000000-factory-history.cjs`, in the style of
`20261121000000-kv-store.cjs`. Both tables start empty; there is no backfill on marge's side. Bringing over the history
the factory already has is the factory's job: it sends those old events like new ones (see "Not here" below).

## `factory_artifacts` (new)

One row per report the factory sends. A report never changes once sent.

| Column | Type | Null | Comes from | Why |
|---|---|---|---|---|
| `id` | `uuid` primary key | no | `artifacts[].id` | Identity; a resent report with the same id is skipped. |
| `kind` | `text` | no | `artifacts[].kind` | Tells 003 how to read `body` (`pr_report` today). |
| `at` | `timestamptz` | no | `artifacts[].at` | When the report was captured, for showing alongside it. |
| `body` | `jsonb` | no | `artifacts[].body` | The report itself, as sent. |

Created first, because `factory_events.artifact_id` points at it.

## `factory_events` (new)

One row per event the factory reports.

| Column | Type | Null | Comes from | Why |
|---|---|---|---|---|
| `id` | `uuid` primary key | no | `events[].id` | Identity; a resent event with the same id is skipped. |
| `run_id` | `uuid` | no | `events[].runId` | The build attempt, which is how 003 finds one build's events. |
| `at` | `timestamptz` | no | `events[].at` | When it happened, for the timeline. |
| `repo` | `text` | no | `events[].repo` | Which repo, as the factory's event already says. |
| `design` | `text` | no | `events[].design` | Which design folder, as the factory's event already says. |
| `pr` | `integer` | yes | `events[].pr` | The PR's position in the plan; null for design-level events. |
| `type` | `text` | no | `events[].type` | What happened. |
| `details` | `jsonb` | no, default `'{}'` | `events[].details` | Facts that belong to this one event (the PR's number and URL, the design's name and planned PRs). |
| `artifact_id` | `uuid` | yes, foreign key to `factory_artifacts(id)` | `events[].artifactId` | The report captured at this moment. |

## Considered and left out

- **Tables for repos, designs, PRs, steps, gate rounds and findings.** No screen in 002 or 003 edits any of these, or
  looks one up on its own. The latest state comes from the factory as one whole; the history is events plus
  reports. Splitting them into tables would mean marge re-working the factory's state machine, and the two would
  drift apart. Add a table when a screen first needs one.
- **A status table marge can edit.** The factory owns the status list and sends it with every push (Design.md
  decision 5). A status that only existed in marge could never be reached by a build.
- **PR or design status worked out from the latest event.** Wrong once there are retries or several review rounds,
  as the factory's own log already shows. The factory sends each build's status.
- **An index on `factory_events.run_id`.** Nothing queries it until 003, which adds the index with the screen that
  needs it.
- **A per-machine sequence number with gap detection.** Event ids already prevent duplicates, and the factory
  resends until it gets `204`, so nothing is lost. A gap check would add moving parts on both sides for a one-owner
  dashboard (owner's choice, Design.md decision 21).
- **A sender id or `factory_sources` table.** There is one factory machine and one token. The latest state fits the
  existing `kv_store` row.
- **`received_at` on events.** Ordering and display use `at`; when marge received an event is not shown anywhere.
- **Wrapping the inserts in one transaction.** Each push writes reports, then events, then the latest state.
  A failure partway answers 500, and the factory's resend finishes the job; a skipped duplicate changes nothing.
- **Deleting old history.** At about 25 events and a handful of reports per design, the tables stay small for years.

## Not here

The factory repo's own spec covers its side: an id for every event and report, a `runId` per build attempt, keeping
events until a push carrying them is accepted, and sending the history it already has, once, with ids it derives from
each old line.
