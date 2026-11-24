import type { DemoRepo } from "./fakeGitHub.js";

/**
 * The canned pull requests FakeGitHub serves in the demo environment
 * (factory/DEMO.md): #42 is the one to read, review and push to; #43 is the
 * one to fail and retry.
 */

const lines = (...xs: string[]) => xs.map((x) => `${x}\n`).join("");

const packageJson = (deps: Record<string, string>) =>
  JSON.stringify(
    {
      name: "station-scheduler",
      private: true,
      type: "module",
      scripts: { dev: "vite", test: "vitest run" },
      dependencies: deps,
    },
    null,
    2,
  ) + "\n";

const lockfile = (deps: Record<string, string>) =>
  JSON.stringify(
    {
      name: "station-scheduler",
      lockfileVersion: 3,
      requires: true,
      packages: Object.fromEntries([
        ["", { name: "station-scheduler", dependencies: deps }],
        ...Object.entries(deps).map(([name, range]) => [
          `node_modules/${name}`,
          {
            version: range.replace("^", ""),
            resolved: `https://registry.npmjs.org/${name}/-/${name}-${range.replace("^", "")}.tgz`,
            license: "MIT",
          },
        ]),
      ]),
    },
    null,
    2,
  ) + "\n";

const baseDeps = { express: "^5.0.0", react: "^19.0.0", pg: "^8.13.0" };
const prDeps = { ...baseDeps, "date-fns": "^4.1.0" };

const apiDoc = lines(
  "# Station Scheduler API",
  "",
  "All endpoints answer JSON and require a signed-in listener.",
  "",
  "## GET /stations/:id",
  "",
  "Returns the station's name, its current show and the next three shows.",
  "",
  "```json",
  '{ "id": "kxyz", "name": "KXYZ Austin", "onAir": "Morning Drive" }',
  "```",
);

const stationsRoute = lines(
  'import { Router } from "express";',
  'import { db } from "../db.js";',
  "",
  "export const stations = Router();",
  "",
  'stations.get("/:id", async (req, res) => {',
  "  const station = await db.station(req.params.id);",
  "  if (!station) {",
  '    res.status(404).json({ error: "station_not_found" });',
  "    return;",
  "  }",
  "  res.json(station);",
  "});",
);

const stationsTest = lines(
  'import { describe, expect, it } from "vitest";',
  'import request from "supertest";',
  'import { app } from "../app.js";',
  "",
  'describe("GET /stations/:id", () => {',
  '  it("returns the station", async () => {',
  '    const res = await request(app).get("/stations/kxyz");',
  "    expect(res.status).toBe(200);",
  '    expect(res.body.name).toBe("KXYZ Austin");',
  "  });",
  "",
  '  it("answers 404 for an unknown station", async () => {',
  '    const res = await request(app).get("/stations/nope");',
  "    expect(res.status).toBe(404);",
  "  });",
  "});",
);

const db = lines(
  'import pg from "pg";',
  "",
  "const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });",
  "",
  "export const db = {",
  "  async station(id: string) {",
  "    const { rows } = await pool.query(",
  '      "SELECT id, name, on_air AS \\"onAir\\" FROM stations WHERE id = $1",',
  "      [id],",
  "    );",
  "    return rows[0] ?? null;",
  "  },",
  "",
  "  query: pool.query.bind(pool),",
  "};",
);

const stationPage = (withTopSongs: boolean) =>
  lines(
    'import { useStation } from "./useStation";',
    ...(withTopSongs ? ['import { TopSongs } from "./TopSongs";'] : []),
    "",
    "export function StationPage({ id }: { id: string }) {",
    "  const station = useStation(id);",
    "  if (!station) return <p>Loading…</p>;",
    "  return (",
    "    <main>",
    "      <h1>{station.name}</h1>",
    "      <p>On air: {station.onAir}</p>",
    ...(withTopSongs ? ["      <TopSongs stationId={id} />"] : []),
    "    </main>",
    "  );",
    "}",
  );

const topSongs = (limit: boolean) =>
  lines(
    'import { subDays } from "date-fns";',
    'import { db } from "../db.js";',
    "",
    "export interface TopSong {",
    "  title: string;",
    "  artist: string;",
    "  plays: number;",
    "}",
    "",
    "/** The station's most-played songs over the seven days before `now`. */",
    "export async function topSongs(",
    "  stationId: string,",
    "  now = new Date(),",
    "): Promise<TopSong[]> {",
    "  const { rows } = await db.query(",
    "    `SELECT s.title, s.artist, count(*)::int AS plays",
    "       FROM plays p JOIN songs s ON s.id = p.song_id",
    "      WHERE p.station_id = $1 AND p.played_at >= $2",
    "      GROUP BY s.id",
    `      ORDER BY plays DESC, s.title${limit ? "\n      LIMIT 10" : ""}\`,`,
    "    [stationId, subDays(now, 7)],",
    "  );",
    "  return rows;",
    "}",
  );

const topSongsTest = lines(
  'import { describe, expect, it } from "vitest";',
  'import { seedPlays } from "../testing/seed.js";',
  'import { topSongs } from "./topSongs.js";',
  "",
  'describe("topSongs", () => {',
  '  it("ranks songs by plays in the last seven days", async () => {',
  '    await seedPlays("kxyz", [',
  '      { title: "Harvest Moon", plays: 5, daysAgo: 1 },',
  '      { title: "Wildflowers", plays: 3, daysAgo: 2 },',
  '      { title: "Old News", plays: 9, daysAgo: 10 },',
  "    ]);",
  '    const songs = await topSongs("kxyz");',
  '    expect(songs.map((s) => s.title)).toEqual(["Harvest Moon", "Wildflowers"]);',
  "  });",
  "});",
);

const topSongsComponent = (limit: boolean) =>
  lines(
    'import { useEffect, useState } from "react";',
    'import type { TopSong } from "../../../server/src/plays/topSongs";',
    "",
    "export function TopSongs({ stationId }: { stationId: string }) {",
    "  const [songs, setSongs] = useState<TopSong[] | null>(null);",
    "",
    "  useEffect(() => {",
    "    fetch(`/stations/${stationId}/top-songs`)",
    "      .then((res) => res.json())",
    "      .then((body) => setSongs(body.songs));",
    "  }, [stationId]);",
    "",
    "  if (!songs) return null;",
    "  return (",
    "    <section>",
    `      <h2>${limit ? "Top 10 this week" : "Most played this week"}</h2>`,
    "      <ol>",
    "        {songs.map((s) => (",
    "          <li key={`${s.artist}-${s.title}`}>",
    "            {s.title} — {s.artist} ({s.plays} plays)",
    "          </li>",
    "        ))}",
    "      </ol>",
    "    </section>",
    "  );",
    "}",
  );

export const DEMO_REPO: DemoRepo = {
  org: "playola-demo",
  repo: "station-scheduler",
  history: [
    {
      message: "Start the station scheduler",
      files: {
        "README.md": lines(
          "# Station Scheduler",
          "",
          "Schedules shows and tracks plays for Playola stations.",
        ),
        "package.json": packageJson(baseDeps),
        "package-lock.json": lockfile(baseDeps),
        "docs/api.md": apiDoc,
        "server/src/db.ts": db,
        "server/src/routes/stations.ts": stationsRoute,
        "server/src/routes/stations.test.ts": stationsTest,
        "client/src/StationPage/StationPage.tsx": stationPage(false),
      },
    },
  ],
  pulls: [
    {
      number: 42,
      title: "Show listeners this week's most-played songs",
      headRef: "feature/weekly-top-songs",
      commits: [
        {
          message:
            "Count each song's plays over the last seven days\n\nOne grouped query; older plays are ignored.",
          files: {
            "server/src/plays/topSongs.ts": topSongs(false),
            "server/src/plays/topSongs.test.ts": topSongsTest,
            "package.json": packageJson(prDeps),
            "package-lock.json": lockfile(prDeps),
          },
        },
        {
          message: "Serve the weekly top songs from the stations API",
          files: {
            "server/src/routes/stations.ts":
              stationsRoute.replace(
                'import { db } from "../db.js";\n',
                'import { db } from "../db.js";\nimport { topSongs } from "../plays/topSongs.js";\n',
              ) +
              lines(
                "",
                'stations.get("/:id/top-songs", async (req, res) => {',
                "  res.json({ songs: await topSongs(req.params.id) });",
                "});",
              ),
            "server/src/routes/stations.test.ts": stationsTest.replace(
              /\}\);\n$/,
              lines(
                "",
                '  it("lists the week\'s top songs", async () => {',
                '    const res = await request(app).get("/stations/kxyz/top-songs");',
                "    expect(res.status).toBe(200);",
                "    expect(res.body.songs).toBeInstanceOf(Array);",
                "  });",
                "});",
              ),
            ),
          },
        },
        {
          message: "Show the top songs on the station page",
          files: {
            "client/src/StationPage/TopSongs.tsx": topSongsComponent(false),
            "client/src/StationPage/StationPage.tsx": stationPage(true),
          },
        },
        {
          message: "Document the top-songs endpoint",
          files: {
            "docs/api.md":
              apiDoc +
              lines(
                "",
                "## GET /stations/:id/top-songs",
                "",
                "The station's **most-played songs** over the last seven days, most plays first.",
                "",
                "- Plays older than seven days are not counted.",
                "- Ties are broken by song title.",
                "",
                "```json",
                '{ "songs": [{ "title": "Harvest Moon", "artist": "Neil Young", "plays": 5 }] }',
                "```",
              ),
          },
        },
      ],
      pushedLater: [
        {
          message: "Cap the top-songs list at ten",
          files: {
            "server/src/plays/topSongs.ts": topSongs(true),
            "client/src/StationPage/TopSongs.tsx": topSongsComponent(true),
          },
        },
      ],
    },
    {
      number: 43,
      title: "Show what's on air next",
      headRef: "feature/up-next",
      commits: [
        {
          message: "Look up the station's next show",
          files: {
            "server/src/db.ts": db.replace(
              "  query: pool.query.bind(pool),",
              lines(
                "  async nextShow(stationId: string) {",
                "    const { rows } = await pool.query(",
                '      "SELECT name, starts_at AS \\"startsAt\\" FROM shows WHERE station_id = $1 AND starts_at > now() ORDER BY starts_at LIMIT 1",',
                "      [stationId],",
                "    );",
                "    return rows[0] ?? null;",
                "  },",
                "",
                "  query: pool.query.bind(pool),",
              ).trimEnd(),
            ),
          },
        },
        {
          message: "Show the next show under the one on air",
          files: {
            "client/src/StationPage/StationPage.tsx": stationPage(
              false,
            ).replace(
              "      <p>On air: {station.onAir}</p>\n",
              lines(
                "      <p>On air: {station.onAir}</p>",
                "      {station.upNext && <p>Up next: {station.upNext.name}</p>}",
              ),
            ),
          },
        },
      ],
    },
  ],
};
