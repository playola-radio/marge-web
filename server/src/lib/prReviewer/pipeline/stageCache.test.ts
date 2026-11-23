import { assert } from "chai";
import { randomBytes } from "node:crypto";
import { Sequelize } from "sequelize";
import { PostgresStageCache } from "./stageCache.js";

// Runs only when DATABASE_URL is set, against the migrated database:
//   DATABASE_URL=postgres://postgres:pass@127.0.0.1:5432/margedev npm test
const dbUrl = process.env.DATABASE_URL;

(dbUrl ? describe : describe.skip)("PostgresStageCache", () => {
  let sequelize: Sequelize;
  const keys: string[] = [];
  const key = () => {
    const k = randomBytes(32).toString("hex");
    keys.push(k);
    return k;
  };

  before(() => {
    sequelize = new Sequelize(dbUrl as string, {
      dialect: "postgres",
      logging: false,
    });
  });
  afterEach(async () => {
    await sequelize.query(
      `DELETE FROM pr_reviewer_stage_outputs WHERE cache_key = ANY($keys)`,
      { bind: { keys: keys.splice(0) } },
    );
  });
  after(() => sequelize.close());

  it("misses an unknown key", async () => {
    assert.isNull(await new PostgresStageCache(sequelize).get(key()));
  });

  it("stores the output with its fallback provenance and keeps the first write", async () => {
    const cache = new PostgresStageCache(sequelize);
    const k = key();
    await cache.put(k, "outline", {
      output: { chapters: [{ key: "a" }], excluded: [] },
      fallbackUsed: true,
    });
    await cache.put(k, "outline", {
      output: { other: 1 },
      fallbackUsed: false,
    });
    assert.deepEqual(await cache.get(k), {
      output: { chapters: [{ key: "a" }], excluded: [] },
      fallbackUsed: true,
    });
    const [row] = (await sequelize.query(
      `SELECT stage FROM pr_reviewer_stage_outputs WHERE cache_key = $k`,
      { bind: { k }, plain: false, raw: true },
    )) as [{ stage: string }[], unknown];
    assert.equal(row[0].stage, "outline");
  });
});
