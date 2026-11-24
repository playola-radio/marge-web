# Demo Environment

## What this is

One local copy of marge (Postgres, API server and website) for recording the factory's demo videos. It runs
in Docker on this machine and never writes to production. The only time it talks to production is to read a
copy of the production database, in a read-only session.

It runs the code that is checked out when you bring it up. To record a branch, check it out first, then
bring the environment up.

## Prerequisites

- Docker Desktop, running (Docker Compose v2).
- `make` and `curl`.
- Optional, for real data: `MARGE_PROD_DATABASE_URL`, the production database's connection string.
  - Where to get it: Render dashboard → `marge-api-db` → **Connect** → **External Database URL**.
  - Where it lives: `~/factory/secrets.env`, which the factory sources and `make demo-env` reads on its
    own if the variable is not already set:
    ```bash
    MARGE_PROD_DATABASE_URL=postgres://<user>:<password>@<host>.render.com/<db>
    ```
  - Never commit it. Without it, the environment comes up with sample data instead.

No other secret is needed: no GitHub App key and no Anthropic API key. The demo server uses fixed,
local-only values (`JWT_SECRET=demo-secret`, `FACTORY_REPORT_TOKEN=demo-factory-token`), the PR reviewer
runs on offline stand-ins (see [PR reviewer](#pr-reviewer)), and the server never sees a production secret:
`docker-compose.demo.yml` lists every variable it gets.

## Bring it up

```bash
make demo-env
```

It starts Postgres, rebuilds the `marge_demo` database (from production or sample data), builds the server and
website from the checked-out code, runs migrations, resets the PR reviewer's canned pull requests, waits until
everything answers, then prints the URLs. It fails loudly if the PR reviewer is off (its endpoints answer 503).
First run takes about a minute (image builds); a re-run takes a few seconds. It is safe to re-run at any time;
each run starts the database over.

Record at: **http://localhost:5180/dev-user**. It signs you in as `dev@marge.local` and opens `/home`;
the Software Factory is at http://localhost:5180/factory.

| Piece    | Address                                              |
| -------- | ---------------------------------------------------- |
| Website  | http://localhost:5180                                |
| API      | http://localhost:3030 (health: `/v1/healthCheck`)    |
| Postgres | `postgres://postgres:demo@localhost:5433/marge_demo` |

Logs: `docker compose -p marge-demo -f docker-compose.demo.yml logs -f`.

## PR reviewer

The server runs the PR reviewer (design 003) with two offline stand-ins, set in `docker-compose.demo.yml`:

- `PR_REVIEWER_GITHUB=fake`: canned pull requests (`server/src/lib/prReviewer/demoFixture.ts`) in place of
  GitHub. Each is built into a real git repository inside the server container, with fixed authors and dates
  (the same commit IDs on every reset), and served to the git cache over `file://`. No network, no token.
- `PR_REVIEWER_LLM=fake`: scripted answers in place of the LLM, written from the pull request's own commits. One
  chapter per commit, headed by its subject and introduced by its message, lockfiles left out ("not in a
  chapter"), and a 1.5 s pause per answer so the stage progress shows on screen.

| Pull request                                        | Use it for                     |
| --------------------------------------------------- | ------------------------------ |
| `playola-demo/station-scheduler` **#42**, 4 commits | reading, reviewing, a new push |
| `playola-demo/station-scheduler` **#43**, 2 commits | a failed run and **Retry**     |

Record at **http://localhost:5180/pr-reviewer/playola-demo/station-scheduler/pulls/42** after signing in
at `/dev-user`. (The page arrives with design 003's last PR; until then the
`/v1/pr-reviewer` endpoints answer.) For each Done-when item:

1. **First visit generates.** Open #42; the stages tick through until the chapters show.
2. **The finished page.** Summary, chapters with diffs, and `package-lock.json` under "not in a chapter".
3. **Reviewed marks persist.** Mark a chapter, refresh.
4. **A second user.** In a second browser profile (separate storage), open
   http://localhost:5180/dev-user?as=second (`dev2@marge.local`), then #42: same chapters, no new
   generation, its own marks.
5. **A new push.** `make demo-pr-push` moves #42's branch to one more commit ("Cap the top-songs list at
   ten"). Reload: the page says the chapters are for an older revision; **Generate for latest**.
6. **Failure and Retry.** `make demo-llm-outage`, then open #43: the summary stage fails, the runner retries
   twice (about 45 s), and the page shows the failure. `make demo-llm-restore`, then **Retry**: only the
   summary runs again.
7. **Survives a redeploy.** `make demo-clear-git-cache` and/or
   `docker compose -p marge-demo -f docker-compose.demo.yml restart server`, then reload #42.

`make demo-env` resets all of this: the canned repositories, the git cache and the outage switch.

## Data

**With `MARGE_PROD_DATABASE_URL` set: a read-only copy of production.** Render has no read replica for this
database (free plan), so the copy is read from the primary:

- `pg_dump` and the snapshot read run with `default_transaction_read_only=on`, so production refuses any
  write in those sessions. `pg_dump` only reads anyway.
- The copy streams straight into the local `marge_demo` database inside the demo Postgres container; nothing
  is written to disk in the repo.
- The relay's pending sign-in sessions in `kv_store` (sealed OAuth codes) are left out. Only the
  `factory:snapshot` row is copied and available through `GET /v1/factory/snapshot` after sign-in.
  The `/factory` page is still a placeholder and does not display this data.
- Migrations then run on top, so a branch with a new migration demos against production data plus its change.

**Without it: sample data.** After the server starts, the script sends `scripts/demo-seed.json` (the example
push from design 002's ApiContract: two builds, one event, one report) through the real
`POST /v1/factory/sync` endpoint.

Either way, sign-in uses the dev user (`/dev-user`, only on in development mode), so no Google account or
allow-list is involved.

**Isolation from other local environments:**

| Thing           | Demo value                               | `make launch` / others        |
| --------------- | ---------------------------------------- | ----------------------------- |
| Compose project | `marge-demo` (`docker-compose.demo.yml`) | the checkout's directory name |
| Docker volume   | `marge-demo_pgdata`                      | `<project>_pgdata`            |
| Database        | `marge_demo`                             | `margedev`                    |
| Postgres port   | `127.0.0.1:5433`                         | 5432                          |
| API port        | `127.0.0.1:3030`                         | 3000                          |
| Website port    | `127.0.0.1:5180`                         | 5173                          |

All ports bind to `127.0.0.1` only.

## Reset / tear down

```bash
make demo-env-down
```

Stops and removes the demo containers and deletes the `marge-demo_pgdata` volume. The next `make demo-env`
starts from nothing.
