import type {
  FactoryBuild,
  FactoryCatalog,
  SnapshotResponse,
} from "../Services/FactoryService";
import {
  countLine,
  formatAge,
  inFlight,
  isOutOfDate,
  repoName,
  roleClass,
  sortBuilds,
} from "./factoryOverview";

function catalog(): FactoryCatalog {
  return {
    statuses: [
      {
        key: "needs_you",
        label: "Needs you",
        shortLabel: "You",
        role: "attention",
      },
      {
        key: "stopped",
        label: "Stopped",
        shortLabel: "Stopped",
        role: "failure",
      },
      {
        key: "no_progress",
        label: "No progress",
        shortLabel: "Quiet",
        role: "quiet",
      },
      {
        key: "running",
        label: "Running",
        shortLabel: "Running",
        role: "active",
      },
      { key: "done", label: "Done", shortLabel: "Done", role: "complete" },
    ],
  };
}

const NOW = Date.parse("2026-11-21T18:42:00.000Z");
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

let nextId = 0;
function build(overrides: Partial<FactoryBuild> = {}): FactoryBuild {
  nextId += 1;
  return {
    runId: `00000000-0000-4000-8000-${String(nextId).padStart(12, "0")}`,
    repo: "playola-radio/playola",
    designNumber: "014",
    designName: "Recorded shows",
    status: "running",
    stages: ["Implement", "Review gate", "PR open", "Reviewers", "Merge"],
    currentStage: 1,
    reason: "Working.",
    pr: { position: 1, total: 1, number: null, url: null },
    lastEventAt: minutesAgo(1),
    ...overrides,
  };
}

const statuses = (builds: FactoryBuild[]) => builds.map((b) => b.status);

describe("sortBuilds", () => {
  test("orders builds by catalog position, done last", () => {
    const builds = [
      build({ status: "done" }),
      build({ status: "running" }),
      build({ status: "no_progress" }),
      build({ status: "stopped" }),
      build({ status: "needs_you" }),
    ];
    expect(statuses(sortBuilds(catalog(), builds))).toEqual([
      "needs_you",
      "stopped",
      "no_progress",
      "running",
      "done",
    ]);
  });

  test("follows a reordered catalog", () => {
    const c = catalog();
    c.statuses = [c.statuses[3], ...c.statuses.slice(0, 3), c.statuses[4]];
    const builds = [
      build({ status: "needs_you" }),
      build({ status: "running" }),
      build({ status: "stopped" }),
    ];
    expect(statuses(sortBuilds(c, builds))).toEqual([
      "running",
      "needs_you",
      "stopped",
    ]);
  });

  test("keeps done builds last even when done comes before running in the catalog", () => {
    const c = catalog();
    c.statuses = [...c.statuses.slice(0, 3), c.statuses[4], c.statuses[3]];
    const builds = [build({ status: "done" }), build({ status: "running" })];
    expect(statuses(sortBuilds(c, builds))).toEqual(["running", "done"]);
  });

  test("within one status the oldest news comes first", () => {
    const builds = [
      build({
        status: "running",
        designNumber: "r2",
        lastEventAt: minutesAgo(2),
      }),
      build({
        status: "needs_you",
        designNumber: "n8",
        lastEventAt: minutesAgo(8),
      }),
      build({
        status: "running",
        designNumber: "r6",
        lastEventAt: minutesAgo(6),
      }),
      build({
        status: "running",
        designNumber: "r1",
        lastEventAt: minutesAgo(1),
      }),
      build({
        status: "needs_you",
        designNumber: "n25",
        lastEventAt: minutesAgo(25),
      }),
      build({
        status: "running",
        designNumber: "r4",
        lastEventAt: minutesAgo(4),
      }),
    ];
    expect(sortBuilds(catalog(), builds).map((b) => b.designNumber)).toEqual([
      "n25",
      "n8",
      "r6",
      "r4",
      "r2",
      "r1",
    ]);
  });

  test("ties fall back to repo, then designNumber", () => {
    const at = minutesAgo(3);
    const builds = [
      build({ repo: "b/zeta", designNumber: "001", lastEventAt: at }),
      build({ repo: "a/alpha", designNumber: "009", lastEventAt: at }),
      build({ repo: "a/alpha", designNumber: "002", lastEventAt: at }),
    ];
    expect(
      sortBuilds(catalog(), builds).map((b) => `${b.repo} ${b.designNumber}`),
    ).toEqual(["a/alpha 002", "a/alpha 009", "b/zeta 001"]);
  });

  test("does not mutate its input", () => {
    const builds = [
      build({ status: "running" }),
      build({ status: "needs_you" }),
    ];
    const before = [...builds];
    sortBuilds(catalog(), builds);
    expect(builds).toEqual(before);
  });
});

describe("roleClass", () => {
  test.each(["attention", "failure", "quiet", "active", "complete"])(
    "%s gives role-%s",
    (role) => {
      expect(roleClass(role)).toBe(`role-${role}`);
    },
  );

  test("a role marge has no look for gives role-neutral", () => {
    expect(roleClass("waiting")).toBe("role-neutral");
  });
});

describe("countLine", () => {
  test("lists only the statuses present, in catalog order", () => {
    const builds = [
      build({ status: "running" }),
      build({ status: "needs_you" }),
      build({ status: "needs_you" }),
    ];
    expect(countLine(catalog(), builds)).toEqual([
      {
        key: "needs_you",
        count: 2,
        label: "Needs you",
        shortLabel: "You",
        role: "attention",
      },
      {
        key: "running",
        count: 1,
        label: "Running",
        shortLabel: "Running",
        role: "active",
      },
    ]);
  });

  test("a status the factory adds gets its own entry", () => {
    const c = catalog();
    c.statuses.splice(3, 0, {
      key: "paused",
      label: "Paused",
      shortLabel: "Paused",
      role: "waiting",
    });
    expect(countLine(c, [build({ status: "paused" })])).toEqual([
      {
        key: "paused",
        count: 1,
        label: "Paused",
        shortLabel: "Paused",
        role: "waiting",
      },
    ]);
  });

  test("a complete build adds no entry", () => {
    const builds = [build({ status: "done" }), build({ status: "running" })];
    expect(countLine(catalog(), builds).map((e) => e.key)).toEqual(["running"]);
    expect(inFlight(catalog(), builds)).toHaveLength(1);
  });
});

describe("formatAge", () => {
  test.each([
    [12_000, "12 s"],
    [59_999, "59 s"],
    [60_000, "1 min"],
    [3_599_999, "59 min"],
    [3_600_000, "1 h"],
    [4_200_000, "1 h 10 min"],
    [-5_000, "0 s"],
  ])("%d ms reads %s", (ms, text) => {
    expect(formatAge(ms)).toBe(text);
  });
});

describe("isOutOfDate", () => {
  const response = (ageMs: number): SnapshotResponse => ({
    catalog: catalog(),
    snapshot: {
      builds: [],
      counts: { upNext: 0, planNotFinished: 0, done: 0 },
    },
    receivedAt: new Date(NOW - ageMs).toISOString(),
    serverNow: new Date(NOW).toISOString(),
  });

  test("false at exactly 3 min", () => {
    expect(isOutOfDate(response(180_000))).toBe(false);
  });

  test("true at 3 min 1 s", () => {
    expect(isOutOfDate(response(181_000))).toBe(true);
  });

  test("false when receivedAt is null", () => {
    expect(
      isOutOfDate({
        catalog: null,
        snapshot: null,
        receivedAt: null,
        serverNow: new Date(NOW).toISOString(),
      }),
    ).toBe(false);
  });
});

test("repoName keeps the part after the last slash", () => {
  expect(repoName("playola-radio/playola-radio-ios")).toBe("playola-radio-ios");
});
