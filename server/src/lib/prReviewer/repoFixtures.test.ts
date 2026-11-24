// Test support only (no tests here): temp directories, plus the
// deterministic FixtureRepo that stands in for GitHub.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export { FixtureRepo } from "./fixtureRepo.js";

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `pr-reviewer-${prefix}-`));
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export function lines(...xs: string[]): string {
  return xs.map((x) => `${x}\n`).join("");
}
