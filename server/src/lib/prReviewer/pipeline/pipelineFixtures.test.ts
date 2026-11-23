// Test support only (no tests here): a fixture feature branch and the
// coverage check shared by the pipeline and runner suites.
import { assert } from "chai";
import { extract, type ExtractOutput } from "../extract.js";
import { Git } from "../gitCache.js";
import { FixtureRepo, lines } from "../repoFixtures.test.js";
import type { ChaptersDocument } from "./index.js";

const git = new Git();

/** A three-commit feature branch: code, its docs, its test. */
export async function featureExtract(up: FixtureRepo): Promise<ExtractOutput> {
  const base = up.commit("base", {
    "README.md": lines("# Widgets", "", "Intro."),
    "src/a.ts": lines("export const a = 1;", "export const b = 2;"),
  });
  up.checkout("feature", true);
  up.commit("Add greeting", {
    "src/a.ts": lines(
      "export const a = 1;",
      "export const greet = () => 'hi';",
      "export const b = 2;",
    ),
    "src/b.ts": lines("import { greet } from './a';", "greet();"),
  });
  up.commit("Document greeting", {
    "README.md": lines("# Widgets", "", "Intro.", "", "Call `greet()`."),
  });
  const head = up.commit("Test greeting", {
    "test/a.test.ts": lines("import { greet } from '../src/a';", "greet();"),
  });
  return extract({
    git,
    gitDir: up.dir,
    baseSha: base,
    headSha: head,
    baseRef: "main",
    branch: "feature",
    repo: "widgets",
  });
}

/** Every run is in exactly one step or in `excluded`. */
export function assertCovered(doc: ChaptersDocument): void {
  const placed = [
    ...doc.chapters.flatMap((c) => c.steps.flatMap((s) => s.runIds)),
    ...doc.excluded.map((e) => e.runId),
  ].sort();
  assert.deepEqual(placed, doc.runs.map((r) => r.id).sort());
}
