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

No other secret is needed. The demo server uses fixed, local-only values (`JWT_SECRET=demo-secret`,
`FACTORY_REPORT_TOKEN=demo-factory-token`) and never sees a production secret.

## Bring it up

```bash
make demo-env
```

It starts Postgres, rebuilds the `marge_demo` database (from production or sample data), builds the server and
website from the checked-out code, runs migrations, waits until everything answers, then prints the URL.
First run takes about a minute (image builds); a re-run takes a few seconds. It is safe to re-run at any time;
each run starts the database over.

Record at: **http://localhost:5180/dev-user**. It signs you in as `dev@marge.local` and opens `/home`;
the Software Factory is at http://localhost:5180/factory.

| Piece    | Address                                              |
| -------- | ---------------------------------------------------- |
| Website  | http://localhost:5180                                |
| API      | http://localhost:3030 (health: `/v1/healthCheck`)    |
| Postgres | `postgres://postgres:demo@localhost:5433/marge_demo` |

Logs: `docker compose -f docker-compose.demo.yml logs -f`.

## Data

**With `MARGE_PROD_DATABASE_URL` set: a read-only copy of production.** Render has no read replica for this
database (free plan), so the copy is read from the primary:

- `pg_dump` and the snapshot read run with `default_transaction_read_only=on`, so production refuses any
  write in those sessions. `pg_dump` only reads anyway.
- The copy streams straight into the local `marge_demo` database inside the demo Postgres container; nothing
  is written to disk in the repo.
- The relay's pending sign-in sessions in `kv_store` (sealed OAuth codes) are left out. Only the
  `factory:snapshot` row is copied, so `/factory` shows the real latest factory state.
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
