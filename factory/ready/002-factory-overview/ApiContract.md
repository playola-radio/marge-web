# 002 — API contract

The factory machine (a Mac mini behind a home router) pushes to marge's server. Each push carries three things:
- **the latest state:** every build in flight, plus the status list it uses. Marge keeps only the newest copy.
- **new history:** events and reports since the last push. Marge keeps every one, once each.
- **a heartbeat:** the push itself tells marge the machine is alive.

Data flows one way. Nothing here sends anything back to the Mac; commands are design 004, which adds its own resource
and leaves these two endpoints alone. No screen in 002 reads the history; it is stored now so design 003 can show it
(Design.md decision 20).

```
factory watch (Mac)  ──POST /v1/factory/sync──▶  marge server (Render)  ◀──GET /v1/factory/snapshot──  /factory page
                       every change + every 60 s     latest state: one kv_store row     every 30 s while visible
                                                     history: factory_events,
                                                              factory_artifacts
```

The sending side (`factory watch` building and pushing the sync) is built in the factory repo from its own spec, not
by this design (Design.md decision 3). Until it ships, `GET` answers "never reported" and the page shows
"Not connected yet".

## Sync body

```json
{
  "catalog": {
    "statuses": [
      { "key": "needs_you", "label": "Needs you", "shortLabel": "You", "role": "attention" },
      { "key": "stopped", "label": "Stopped", "shortLabel": "Stopped", "role": "failure" },
      { "key": "no_progress", "label": "No progress", "shortLabel": "Quiet", "role": "quiet" },
      { "key": "running", "label": "Running", "shortLabel": "Running", "role": "active" },
      { "key": "done", "label": "Done", "shortLabel": "Done", "role": "complete" }
    ]
  },
  "snapshot": {
    "sequence": 42,
    "builds": [
      {
        "runId": "98093cbb-16c0-43a9-b026-cc9b1d91c47a",
        "repo": "playola-radio/playola",
        "designNumber": "014",
        "designName": "Recorded shows",
        "status": "needs_you",
        "stages": ["Implement", "Review gate", "PR open", "Reviewers", "Merge"],
        "currentStage": 4,
        "reason": "Reviews answered. Ready for you to merge.",
        "pr": {
          "position": 2,
          "total": 3,
          "number": 812,
          "url": "https://github.com/playola-radio/playola/pull/812"
        },
        "lastEventAt": "2026-11-21T18:34:04.801Z"
      },
      {
        "runId": "3f0e2a51-7b8c-4d2e-9a61-0c5d8e7f1b24",
        "repo": "playola-radio/factory",
        "designNumber": "004",
        "designName": "Notify on pause",
        "status": "no_progress",
        "stages": ["Implement", "Review gate", "PR open", "Reviewers", "Merge"],
        "currentStage": 0,
        "reason": "Still implementing. Nothing new for 1 h 10 min.",
        "pr": { "position": 1, "total": 1, "number": null, "url": null },
        "lastEventAt": "2026-11-21T17:32:10.000Z"
      }
    ],
    "counts": { "upNext": 3, "planNotFinished": 1, "done": 22 }
  },
  "events": [
    {
      "id": "0d841412-1ae9-4af5-9c3d-a2e58a6099f0",
      "runId": "98093cbb-16c0-43a9-b026-cc9b1d91c47a",
      "at": "2026-11-21T18:34:04.801Z",
      "repo": "playola-radio/playola",
      "design": "014-recorded-shows",
      "pr": 2,
      "type": "pr waiting on owner",
      "details": { "number": 812, "url": "https://github.com/playola-radio/playola/pull/812" },
      "artifactId": "0969de36-50de-4b61-9340-408a40d162ae"
    }
  ],
  "artifacts": [
    {
      "id": "0969de36-50de-4b61-9340-408a40d162ae",
      "kind": "pr_report",
      "at": "2026-11-21T18:34:04.801Z",
      "body": { "implementation": {}, "gate": {}, "pullRequest": {}, "review": {} }
    }
  ]
}
```

A push with nothing new sends `"events": []` and `"artifacts": []`. That is the 60-second heartbeat, and the factory
sends it only after a completed scan of its state (Design.md decision 8).

### Catalog: the factory's status list

The factory owns the list of statuses: how many there are, what each is called, their order and what kind of status
each one is. Marge displays whatever the latest push says (Design.md decision 5). To add, rename or reorder a status,
change the factory; marge picks it up on the next push.

| Field | Type | Rule | Meaning |
|---|---|---|---|
| `catalog.statuses` | array | 1–20 entries | The statuses, in the order the page sorts them. |
| `.key` | string | matches `^[a-z][a-z0-9_]{0,39}$`; unique in the list | The word a build's `status` uses. |
| `.label` | string | non-empty, ≤ 30 chars | Chip text and the desktop count line ("Needs you"). |
| `.shortLabel` | string | non-empty, ≤ 12 chars | The phone count line ("You"). |
| `.role` | string | non-empty, ≤ 20 chars | What kind of status this is, which sets its colour and motion on the page: `attention`, `failure`, `quiet`, `active`, `complete`, or any other word (shown grey). Only `complete` means "not in flight". |

The factory never sends colours. Marge maps each role to its own look (Design.md decision 5).

### Snapshot: the latest state

The factory decides every value; marge validates the shape and never recomputes them.

| Field | Type | Rule | Meaning |
|---|---|---|---|
| `snapshot.sequence` | integer | positive safe integer; greater than the factory's last accepted sequence | The completed state scan's order. The factory persists this counter, increments it for each fresh completed scan, and reuses the same value when retrying that scan. |
| `snapshot.builds` | array, ≤ 50 | required, may be empty | One entry per watched repo with a design in flight (claimed, or its repo paused), plus one per design the factory finished in the last 24 hours (a `complete` status, Design.md decision 19). |
| `.runId` | string | lower-case UUID; unique within `builds` | This attempt at building the design. A design that is given up and claimed again gets a new one. |
| `.repo` | string | non-empty, ≤ 200 chars | `owner/name`. The page shows the part after `/`. |
| `.designNumber` | string | three digits | The design folder's number. |
| `.designName` | string | non-empty, ≤ 120 chars | The design's name as the factory wants it read. |
| `.status` | string | one of `catalog.statuses[].key` | The build's status. |
| `.stages` | string[] | 1–10 non-empty strings | The stage names in order, as the factory defines them. |
| `.currentStage` | integer | `0 ≤ currentStage < stages.length` | Index of the current stage. |
| `.reason` | string | ≤ 300 chars | One plain-English line saying why the build has this status. |
| `.pr.position`, `.total` | integer | `1 ≤ position ≤ total` | "PR 2 of 3". |
| `.pr.number`, `.url` | integer, string, or both `null` | both set or both `null`; `url` starts `https://` | The open GitHub pull request, once there is one. |
| `.lastEventAt` | string | a UTC time (see below) | Time of this build's latest event (the factory's "last news"). |
| `snapshot.counts.upNext` | integer ≥ 0 | required | Designs in `factory/ready/` that are buildable and not claimed, across watched repos. |
| `snapshot.counts.planNotFinished` | integer ≥ 0 | required | Designs in `factory/ready/` that are not buildable. |
| `snapshot.counts.done` | integer ≥ 0 | required | Designs in `factory/done/`. |

### Events: what happened

One entry per line the factory adds to its event log, sent once it is written and resent until a push carrying it
gets `204`.

| Field | Type | Rule | Meaning |
|---|---|---|---|
| `events` | array, ≤ 500 | required, may be empty | New events, oldest first. |
| `.id` | string | lower-case UUID; unique within `events` | Set by the factory when it writes the event; the same event always carries the same id. |
| `.runId` | string | lower-case UUID | The build attempt this happened in. |
| `.at` | string | a UTC time | When it happened, by the factory's clock. |
| `.repo` | string | non-empty, ≤ 200 chars | `owner/name`. |
| `.design` | string | non-empty, ≤ 200 chars | The design folder's name (`014-recorded-shows`). |
| `.pr` | integer or `null` | ≥ 1 when set | The PR's position in the design's plan, for PR-level events. |
| `.type` | string | non-empty, ≤ 60 chars | The factory's event type (`design claimed`, `gate clean`, `pr merged`, …). |
| `.details` | object | optional, plain object | Facts that belong to this event only, for example the design name and planned PRs on `design claimed`, or the PR number and URL on `pr opened`. |
| `.artifactId` | string or `null` | lower-case UUID when set; must be the `id` of an entry in this push's `artifacts` | The report captured at this moment. |

### Artifacts: the reports behind events

A copy of the factory's report on a PR (implementation summary, gate rounds and findings, pull request, review rounds)
taken at the moment of an event. The factory keeps a report on the Mac until it receives `204` for a push that includes
the event referencing it; it may delete the report only after that acknowledgement, including after a retry. Marge then
keeps the copy after the design finishes.
Videos and other media stay on GitHub; a report holds their URLs, never the files.

| Field | Type | Rule | Meaning |
|---|---|---|---|
| `artifacts` | array, ≤ 50 | required, may be empty | Reports that new events point to. |
| `.id` | string | lower-case UUID; unique within `artifacts` | Set by the factory; a report never changes once sent. |
| `.kind` | string | non-empty, ≤ 40 chars | `pr_report` today. |
| `.at` | string | a UTC time | When the report was captured. |
| `.body` | object | plain object; ≤ 262,144 bytes as UTF-8 JSON | The report. Marge stores it as sent and does not read inside it. The factory leaves out anything that only means something on the Mac (worktree paths). |

**A UTC time** is an ISO 8601 date-time ending `Z`, matching `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$`, that
names a real calendar moment (no month 13, hour 25 or 30 February), for example `2026-11-21T17:32:10.000Z`. It is
stored as sent.

Fields not listed are allowed. Inside `catalog` and `snapshot` they are stored with the rest; on events and artifacts
they are dropped.

## POST /v1/factory/sync

**Repo:** `marge-web` (`server/`). **Status:** new. **Caller:** `factory watch` on the factory machine.

Auth: `Authorization: Bearer <FACTORY_REPORT_TOKEN>`. The server compares SHA-256 digests of the sent token and its
`FACTORY_REPORT_TOKEN` with `crypto.timingSafeEqual`, before it reads the body. The marge sign-in token
(`JWT_SECRET`) is never accepted here, and the factory token is never accepted on any other route.

Request: the sync body above, `Content-Type: application/json`, at most 5 MB.

Response `204` with no body once everything is stored:

1. **Artifacts, then events,** are added to `factory_artifacts` and `factory_events` (ModelChanges.md). An `id`
   marge already has is skipped: the first copy is kept and a later copy with the same id is ignored, even if it
   differs.
2. **Then the latest state** replaces the `kv_store` row `factory:snapshot` (365-day TTL) only when its
   `snapshot.sequence` is greater than the stored sequence:

   ```json
   { "catalog": { "statuses": [ … ] }, "snapshot": { "sequence": 42, "builds": [ … ], "counts": { … } }, "receivedAt": "2026-11-21T18:42:31.410Z" }
   ```

   `receivedAt` is the server's own clock at that moment. A push with the stored sequence is a retry and leaves this
   row (including `receivedAt`) unchanged; a lower sequence leaves it unchanged too. The server still records any new
   history in either case, then answers `204`.

**Delivery:** the factory resends the exact same completed scan, with its same `snapshot.sequence`, until it gets
`204`; it does not rebuild a retry from a later scan. A later completed scan has a greater sequence, so a delayed
older push cannot replace it. Resending is safe: history already stored is skipped, and a retried snapshot leaves the
stored state and its freshness unchanged. If a push fails partway (say the history is stored but the latest state is
not), the server answers `500` and the resend completes it. Nothing is lost as long as the factory keeps an event and
its referenced report until a push carrying them gets `204`.

| Status | Body | When |
|---|---|---|
| 401 | `{ "error": "unauthorized" }` | Header missing or wrong, or `FACTORY_REPORT_TOKEN` unset on the server. Always 401, whatever the body. |
| 400 | `{ "error": "invalid_sync" }` | The body is not JSON, is a bare `null` or number, or breaks any rule above. Nothing is stored. |
| 413 | `{ "error": "invalid_sync" }` | The body is over 5 MB. Nothing is stored. |
| 500 | `{ "error": "internal_error" }` | Anything else (existing `errorHandler`). The factory resends. |

## GET /v1/factory/snapshot

**Repo:** `marge-web` (`server/`). **Status:** new. **Caller:** the `/factory` page.

Auth: the signed-in marge token, `Authorization: Bearer <token>`, checked by the existing `requireAuth`.

Response `200` after at least one push:

```json
{
  "catalog": { "statuses": [ … ] },
  "snapshot": { "builds": [ … ], "counts": { "upNext": 3, "planNotFinished": 1, "done": 22 } },
  "receivedAt": "2026-11-21T18:42:31.410Z",
  "serverNow": "2026-11-21T18:43:02.000Z"
}
```

Response `200` before the factory has ever pushed:

```json
{ "catalog": null, "snapshot": null, "receivedAt": null, "serverNow": "2026-11-21T18:43:02.000Z" }
```

The page measures every age against `serverNow`, so a wrong phone clock cannot affect an age and a wrong Mac clock
cannot fake freshness: "Updated … ago" is `serverNow − receivedAt`, and the page is out of date when
`serverNow − receivedAt` is more than 3 minutes. "Last news" is `serverNow − lastEventAt`; because `lastEventAt`
comes from the factory, a wrong Mac clock can affect that display and the quiet chip.

| Status | Body | When | Page shows |
|---|---|---|---|
| 401 | `{ "error": "unauthorized" }` | Token missing, expired or not signed by `JWT_SECRET` | Clears the stored session and goes to `/?redirectTo=%2Ffactory` |
| 500 | `{ "error": "internal_error" }` | Database unreachable or anything else | Overview — Couldn't load |
| (no answer) | — | Network failure, or no answer within 15 s | Overview — Couldn't load |

No endpoint reads the history yet; design 003 adds one.

## Configuration

| Name | Where | Value |
|---|---|---|
| `FACTORY_REPORT_TOKEN` | Render `production` env group (`render.yaml`, `sync: false`) | 32+ random bytes, base64 or hex. Generated by the owner during design (Design.md decision 12). The same value goes in the factory machine's `~/.factory/env`. |
| `FACTORY_REPORT_TOKEN` | `server/.env.example` | Commented out, with a one-line explanation, like `JWT_SECRET`. |

The client uses the existing `VITE_SERVER_BASE_URL`; nothing new is configured on Netlify.
