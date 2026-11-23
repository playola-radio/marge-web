import { assert } from "chai";
import { QueryTypes, Sequelize } from "sequelize";

// Checks the PR reviewer tables that migration 20261123000000-pr-reviewer.cjs
// creates. Runs only when DATABASE_URL is set, against an already-migrated
// database (CI's server-db job runs `npm run migrate` before `npm test`):
//   DATABASE_URL=postgres://postgres:pass@127.0.0.1:5432/margedev npm test
// It only reads the catalog; it never runs `down` or drops anything.
const dbUrl = process.env.DATABASE_URL;

type Column = { column_name: string; data_type: string; is_nullable: string };

const expectedColumns: Record<string, Record<string, [string, boolean]>> = {
  pr_reviewer_runs: {
    id: ["uuid", false],
    org: ["text", false],
    repo: ["text", false],
    pr_number: ["integer", false],
    head_sha: ["text", false],
    base_sha: ["text", false],
    pipeline_version: ["text", false],
    status: ["text", false],
    progress: ["jsonb", true],
    failure: ["text", true],
    failure_detail: ["text", true],
    lease_expires_at: ["timestamp with time zone", true],
    lease_token: ["uuid", true],
    attempt: ["integer", false],
    pr_meta: ["jsonb", false],
    created_at: ["timestamp with time zone", false],
    updated_at: ["timestamp with time zone", false],
  },
  pr_reviewer_stage_outputs: {
    cache_key: ["character", false],
    stage: ["text", false],
    output: ["jsonb", false],
    created_at: ["timestamp with time zone", false],
  },
  pr_reviewer_documents: {
    run_id: ["uuid", false],
    document: ["jsonb", false],
    created_at: ["timestamp with time zone", false],
  },
  pr_reviewer_run_files: {
    run_id: ["uuid", false],
    path: ["text", false],
    text: ["text", false],
    created_at: ["timestamp with time zone", false],
  },
  pr_reviewer_chapter_reviews: {
    run_id: ["uuid", false],
    chapter_key: ["text", false],
    user_email: ["text", false],
    created_at: ["timestamp with time zone", false],
  },
};

const expectedPrimaryKeys: Record<string, string[]> = {
  pr_reviewer_runs: ["id"],
  pr_reviewer_stage_outputs: ["cache_key"],
  pr_reviewer_documents: ["run_id"],
  pr_reviewer_run_files: ["run_id", "path"],
  pr_reviewer_chapter_reviews: ["run_id", "chapter_key", "user_email"],
};

const childTables = [
  "pr_reviewer_documents",
  "pr_reviewer_run_files",
  "pr_reviewer_chapter_reviews",
];

(dbUrl ? describe : describe.skip)("PR reviewer schema", () => {
  let sequelize: Sequelize;

  before(() => {
    sequelize = new Sequelize(dbUrl as string, {
      dialect: "postgres",
      logging: false,
    });
  });

  after(async () => {
    await sequelize.close();
  });

  // Ordered key columns of every index on a table, with its uniqueness.
  const indexesOf = async (table: string) =>
    sequelize.query<{ name: string; unique: boolean; columns: string[] }>(
      `SELECT i.relname AS name, ix.indisunique AS unique,
              array_agg(a.attname::text ORDER BY k.ord) AS columns
         FROM pg_index ix
         JOIN pg_class t ON t.oid = ix.indrelid
         JOIN pg_class i ON i.oid = ix.indexrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
         CROSS JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
        WHERE t.relname = :table AND n.nspname = current_schema()
        GROUP BY i.relname, ix.indisunique`,
      { replacements: { table }, type: QueryTypes.SELECT },
    );

  for (const [table, columns] of Object.entries(expectedColumns)) {
    it(`${table} has the expected columns`, async () => {
      const rows = await sequelize.query<Column>(
        `SELECT column_name, data_type, is_nullable
           FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = :table`,
        { replacements: { table }, type: QueryTypes.SELECT },
      );
      const actual = Object.fromEntries(
        rows.map((r) => [
          r.column_name,
          [r.data_type, r.is_nullable === "YES"] as [string, boolean],
        ]),
      );
      assert.deepEqual(actual, columns);
    });

    it(`${table} has the expected primary key`, async () => {
      const rows = await sequelize.query<{ column_name: string }>(
        `SELECT kcu.column_name
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON kcu.constraint_name = tc.constraint_name
            AND kcu.table_schema = tc.table_schema
          WHERE tc.table_schema = current_schema()
            AND tc.table_name = :table
            AND tc.constraint_type = 'PRIMARY KEY'
          ORDER BY kcu.ordinal_position`,
        { replacements: { table }, type: QueryTypes.SELECT },
      );
      assert.deepEqual(
        rows.map((r) => r.column_name),
        expectedPrimaryKeys[table],
      );
    });
  }

  it("pr_reviewer_stage_outputs.cache_key is CHAR(64)", async () => {
    const [row] = await sequelize.query<{ len: number }>(
      `SELECT character_maximum_length AS len
         FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'pr_reviewer_stage_outputs'
          AND column_name = 'cache_key'`,
      { type: QueryTypes.SELECT },
    );
    assert.strictEqual(row.len, 64);
  });

  it("pr_reviewer_runs defaults id to a v4 UUID and attempt to 0", async () => {
    const rows = await sequelize.query<{
      column_name: string;
      column_default: string | null;
    }>(
      `SELECT column_name, column_default
         FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'pr_reviewer_runs'
          AND column_name IN ('id', 'attempt')`,
      { type: QueryTypes.SELECT },
    );
    const defaults = Object.fromEntries(
      rows.map((r) => [r.column_name, r.column_default]),
    );
    assert.strictEqual(defaults.id, "gen_random_uuid()");
    assert.strictEqual(defaults.attempt, "0");
  });

  for (const table of childTables) {
    it(`${table}.run_id references pr_reviewer_runs(id) ON DELETE CASCADE`, async () => {
      const rows = await sequelize.query<{
        column_name: string;
        foreign_table: string;
        foreign_column: string;
        delete_rule: string;
      }>(
        `SELECT kcu.column_name, ccu.table_name AS foreign_table,
                ccu.column_name AS foreign_column, rc.delete_rule
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON kcu.constraint_name = tc.constraint_name
            AND kcu.table_schema = tc.table_schema
           JOIN information_schema.referential_constraints rc
             ON rc.constraint_name = tc.constraint_name
            AND rc.constraint_schema = tc.table_schema
           JOIN information_schema.constraint_column_usage ccu
             ON ccu.constraint_name = tc.constraint_name
            AND ccu.constraint_schema = tc.table_schema
          WHERE tc.table_schema = current_schema()
            AND tc.table_name = :table
            AND tc.constraint_type = 'FOREIGN KEY'`,
        { replacements: { table }, type: QueryTypes.SELECT },
      );
      assert.deepEqual(rows, [
        {
          column_name: "run_id",
          foreign_table: "pr_reviewer_runs",
          foreign_column: "id",
          delete_rule: "CASCADE",
        },
      ]);
    });
  }

  it("pr_reviewer_runs has a unique index on the find-or-create key", async () => {
    const indexes = await indexesOf("pr_reviewer_runs");
    const match = indexes.find(
      (ix) =>
        ix.unique &&
        JSON.stringify(ix.columns) ===
          JSON.stringify([
            "org",
            "repo",
            "pr_number",
            "head_sha",
            "base_sha",
            "pipeline_version",
          ]),
    );
    assert.exists(match, JSON.stringify(indexes));
  });

  it("pr_reviewer_runs has an index on (status, lease_expires_at)", async () => {
    const indexes = await indexesOf("pr_reviewer_runs");
    const match = indexes.find(
      (ix) =>
        JSON.stringify(ix.columns) ===
        JSON.stringify(["status", "lease_expires_at"]),
    );
    assert.exists(match, JSON.stringify(indexes));
  });
});
