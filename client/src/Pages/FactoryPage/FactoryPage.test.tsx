import { act, fireEvent, screen, within } from "@testing-library/react";
import axios, { AxiosError } from "axios";
import { saveSession } from "../../utils/session";
import { renderApp } from "../../test/renderApp";
import { makeToken } from "../../test/tokens";
import { httpError, networkError } from "../../test/axios";
import type {
  CatalogStatus,
  FactoryBuild,
  SnapshotResponse,
} from "../../Services/FactoryService";

vi.mock("@react-oauth/google", () => import("../../test/googleOAuthMock"));
vi.mock("axios", async (importOriginal) => {
  const actual = await importOriginal<typeof import("axios")>();
  return { ...actual, default: { ...actual.default, get: vi.fn() } };
});

const get = vi.mocked(axios.get);

const SERVER_NOW = Date.parse("2026-11-21T18:43:02.000Z");
const ago = (ms: number) => new Date(SERVER_NOW - ms).toISOString();
const SEC = 1000;
const MIN = 60 * SEC;
const STAGES = ["Implement", "Review gate", "PR open", "Reviewers", "Merge"];

function catalog(): CatalogStatus[] {
  return [
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
    { key: "running", label: "Running", shortLabel: "Running", role: "active" },
    { key: "done", label: "Done", shortLabel: "Done", role: "complete" },
  ];
}

const needsYou = (): FactoryBuild => ({
  runId: "98093cbb-16c0-43a9-b026-cc9b1d91c47a",
  repo: "playola-radio/playola",
  designNumber: "014",
  designName: "Recorded shows",
  status: "needs_you",
  stages: STAGES,
  currentStage: 4,
  reason: "Reviews answered. Ready for you to merge.",
  pr: {
    position: 2,
    total: 3,
    number: 812,
    url: "https://github.com/playola-radio/playola/pull/812",
  },
  lastEventAt: ago(8 * MIN),
});

const noProgress = (): FactoryBuild => ({
  runId: "3f0e2a51-7b8c-4d2e-9a61-0c5d8e7f1b24",
  repo: "playola-radio/factory",
  designNumber: "004",
  designName: "Notify on pause",
  status: "no_progress",
  stages: STAGES,
  currentStage: 0,
  reason: "Still implementing. Nothing new for 1 h 10 min.",
  pr: { position: 1, total: 1, number: null, url: null },
  lastEventAt: ago(70 * MIN),
});

const running = (): FactoryBuild => ({
  runId: "1c2d3e4f-0000-4000-8000-000000000001",
  repo: "playola-radio/marge-web",
  designNumber: "001",
  designName: "Sign in and open factory",
  status: "running",
  stages: STAGES,
  currentStage: 1,
  reason: "Review round 2 · 3 fixed, 1 declined",
  pr: { position: 1, total: 2, number: null, url: null },
  lastEventAt: ago(2 * MIN),
});

const stopped = (): FactoryBuild => ({
  runId: "1c2d3e4f-0000-4000-8000-000000000002",
  repo: "playola-radio/playola-radio-ios",
  designNumber: "007",
  designName: "Voicetrack editor",
  status: "stopped",
  stages: STAGES,
  currentStage: 0,
  reason: "Tests failed after 3 attempts. Repo paused.",
  pr: {
    position: 2,
    total: 2,
    number: 640,
    url: "https://github.com/x/y/pull/640",
  },
  lastEventAt: ago(42 * MIN),
});

const done = (): FactoryBuild => ({
  runId: "1c2d3e4f-0000-4000-8000-000000000003",
  repo: "playola-radio/playola",
  designNumber: "009",
  designName: "Station analytics",
  status: "done",
  stages: STAGES,
  currentStage: 4,
  reason: "All 3 PRs merged.",
  pr: {
    position: 3,
    total: 3,
    number: 790,
    url: "https://github.com/x/y/pull/790",
  },
  lastEventAt: ago(3 * 60 * MIN),
});

function response({
  builds = [done(), running(), noProgress(), stopped(), needsYou()],
  statuses = catalog(),
  receivedAgo = 12 * SEC,
}: {
  builds?: FactoryBuild[];
  statuses?: CatalogStatus[];
  receivedAgo?: number;
} = {}): SnapshotResponse {
  return {
    catalog: { statuses },
    snapshot: { builds, counts: { upNext: 3, planNotFinished: 1, done: 22 } },
    receivedAt: ago(receivedAgo),
    serverNow: new Date(SERVER_NOW).toISOString(),
  };
}

const notConnected = (): SnapshotResponse => ({
  catalog: null,
  snapshot: null,
  receivedAt: null,
  serverNow: new Date(SERVER_NOW).toISOString(),
});

const answer = (data: SnapshotResponse) => ({ data });

let visibility: DocumentVisibilityState = "visible";

function setVisibility(value: DocumentVisibilityState) {
  visibility = value;
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

beforeAll(() => {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
});

beforeEach(() => {
  visibility = "visible";
  localStorage.clear();
  get.mockReset();
  saveSession(makeToken({ email: "brian@playola.fm" }));
});

afterEach(() => {
  vi.useRealTimers();
});

async function renderLoaded(data: SnapshotResponse = response()) {
  get.mockResolvedValue(answer(data));
  const view = renderApp("/factory");
  await screen.findByRole("heading", { level: 1, name: "Software Factory" });
  await act(async () => {});
  return view;
}

const rows = () => screen.getAllByRole("listitem", { name: /^\d{3} / });
const rowOf = (name: string) => screen.getByRole("listitem", { name });
const countLineEl = (container: HTMLElement) =>
  container.querySelector(".count-line") as HTMLElement;
const desktopCounts = (container: HTMLElement) =>
  Array.from(
    countLineEl(container).querySelectorAll(".desktop-only"),
    (el) => el.textContent,
  );

async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("page frame", () => {
  test("shows the Software Factory heading and the stored email", async () => {
    await renderLoaded();
    expect(
      screen.getByRole("heading", { level: 1, name: "Software Factory" }),
    ).toBeInTheDocument();
    expect(screen.getByText("brian@playola.fm")).toBeInTheDocument();
  });

  test('"← marge" goes to /home', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole("link", { name: "marge" }));
    expect(window.location.pathname).toBe("/home");
    expect(screen.getByRole("img", { name: "Marge" })).toBeInTheDocument();
  });

  test("Sign out clears localStorage and shows the landing page", async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole("button", { name: /sign out/i }));
    expect(localStorage.length).toBe(0);
    expect(window.location.pathname).toBe("/");
    expect(
      screen.getByRole("button", { name: /sign in with google/i }),
    ).toBeInTheDocument();
  });
});

describe("normal", () => {
  test("lists the builds in sort order with their details", async () => {
    await renderLoaded();
    expect(rows().map((row) => row.getAttribute("aria-label"))).toEqual([
      "014 Recorded shows",
      "007 Voicetrack editor",
      "004 Notify on pause",
      "001 Sign in and open factory",
      "009 Station analytics",
    ]);
    const row = rowOf("014 Recorded shows");
    expect(within(row).getByText("Needs you")).toBeInTheDocument();
    expect(within(row).getByText("014 Recorded shows")).toBeInTheDocument();
    expect(row).toHaveTextContent("playola · PR 2 of 3");
    expect(row).toHaveTextContent("Reviews answered. Ready for you to merge.");
    expect(row).toHaveTextContent("8 min ago");
    expect(
      within(rowOf("007 Voicetrack editor")).getByText("Stopped"),
    ).toBeInTheDocument();
    expect(rowOf("007 Voicetrack editor")).toHaveTextContent(
      "playola-radio-ios · PR 2 of 2",
    );
    expect(rowOf("007 Voicetrack editor")).toHaveTextContent("42 min ago");
    expect(rowOf("004 Notify on pause")).toHaveTextContent("1 h 10 min ago");
    expect(
      within(rowOf("001 Sign in and open factory")).getByText("Running"),
    ).toBeInTheDocument();
  });

  test("the current stage is marked with aria-current", async () => {
    await renderLoaded();
    const current = within(rowOf("014 Recorded shows"))
      .getAllByRole("listitem")
      .filter((li) => li.getAttribute("aria-current") === "step");
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveTextContent("Merge");
  });

  test("the track marks passed, current and still-to-come stages", async () => {
    await renderLoaded();
    const segments = within(rowOf("001 Sign in and open factory")).getAllByRole(
      "listitem",
    );
    expect(segments).toHaveLength(5);
    expect(segments[0]).toHaveClass("stage--passed");
    expect(segments[1]).toHaveClass("stage--current");
    expect(segments[1]).toHaveAttribute("aria-current", "step");
    for (const segment of segments.slice(2)) {
      expect(segment).toHaveClass("stage--upcoming");
    }
  });

  test("the count line lists each status in flight", async () => {
    const { container } = await renderLoaded();
    for (const text of [
      "Needs you 1",
      "Stopped 1",
      "No progress 1",
      "Running 1",
    ]) {
      expect(desktopCounts(container)).toContain(text);
    }
  });

  test("two needs_you builds read Needs you 2", async () => {
    const second = {
      ...needsYou(),
      runId: "0d841412-1ae9-4af5-9c3d-a2e58a6099f0",
      designNumber: "021",
    };
    const { container } = await renderLoaded(
      response({ builds: [needsYou(), second] }),
    );
    expect(desktopCounts(container)).toContain("Needs you 2");
  });

  test("shows how long ago marge heard from the factory", async () => {
    const { container } = await renderLoaded();
    expect(container.querySelector(".overview__updated")).toHaveTextContent(
      "Updated 12 s ago",
    );
  });

  test("only the needs_you build with a PR shows an Open PR link", async () => {
    await renderLoaded();
    const links = screen
      .getAllByRole("link")
      .filter((link) => /Open PR/.test(link.textContent ?? ""));
    expect(links).toHaveLength(1);
    const link = screen.getByRole("link", { name: "Open PR #812" });
    expect(link).toHaveAttribute(
      "href",
      "https://github.com/playola-radio/playola/pull/812",
    );
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
  });

  test("a needs_you build without a PR url shows no link", async () => {
    const build = {
      ...needsYou(),
      pr: { position: 1, total: 1, number: null, url: null },
    };
    await renderLoaded(response({ builds: [build] }));
    expect(
      screen.queryByRole("link", { name: /Open PR/ }),
    ).not.toBeInTheDocument();
  });

  test("the no-progress chip shows the whole hours since last news", async () => {
    await renderLoaded();
    expect(
      within(rowOf("004 Notify on pause")).getByText("No progress 1 h"),
    ).toBeInTheDocument();
  });

  test("a status the factory added shows grey, in the factory's order, with no edge or motion", async () => {
    const statuses = catalog();
    statuses.splice(3, 0, {
      key: "paused",
      label: "Paused",
      shortLabel: "Paused",
      role: "waiting",
    });
    const paused = {
      ...running(),
      runId: "1c2d3e4f-0000-4000-8000-000000000009",
      designNumber: "002",
      designName: "Paused thing",
      status: "paused",
    };
    const { container } = await renderLoaded(
      response({
        statuses,
        builds: [running(), paused, noProgress()],
      }),
    );
    expect(rows().map((row) => row.getAttribute("aria-label"))).toEqual([
      "004 Notify on pause",
      "002 Paused thing",
      "001 Sign in and open factory",
    ]);
    const row = rowOf("002 Paused thing");
    expect(within(row).getByText("Paused")).toHaveClass("role-neutral");
    expect(row).not.toHaveClass("build-row--edge");
    expect(row).not.toHaveClass("build-row--moving");
    expect(desktopCounts(container)).toContain("Paused 1");
  });

  test("a renamed status shows the factory's new label", async () => {
    const statuses = catalog().map((s) =>
      s.key === "running" ? { ...s, label: "Building" } : s,
    );
    const { container } = await renderLoaded(response({ statuses }));
    expect(
      within(rowOf("001 Sign in and open factory")).getByText("Building"),
    ).toBeInTheDocument();
    expect(desktopCounts(container)).toContain("Building 1");
  });

  test("the footer shows the not-in-flight counts", async () => {
    await renderLoaded();
    expect(screen.getByText("Up next 3")).toBeInTheDocument();
    expect(screen.getByText("Plan not finished 1")).toBeInTheDocument();
    expect(screen.getByText("Done 22")).toBeInTheDocument();
  });

  test("a done build is listed last, still, with no link and no count", async () => {
    const { container } = await renderLoaded();
    const all = rows();
    const row = all[all.length - 1];
    expect(row).toHaveAccessibleName("009 Station analytics");
    expect(within(row).getByText("Done")).toBeInTheDocument();
    expect(within(row).queryByRole("link")).not.toBeInTheDocument();
    expect(row.querySelector("[aria-current]")).toBeNull();
    for (const segment of within(row).getAllByRole("listitem")) {
      expect(segment).toHaveClass("stage--done");
    }
    expect(countLineEl(container)).not.toHaveTextContent("Done");
  });

  test("only the running build moves, and nothing moves when out of date", async () => {
    const { unmount } = await renderLoaded();
    const moving = rows().filter((row) =>
      row.classList.contains("build-row--moving"),
    );
    expect(moving.map((row) => row.getAttribute("aria-label"))).toEqual([
      "001 Sign in and open factory",
    ]);
    unmount();

    await renderLoaded(response({ receivedAgo: 14 * MIN }));
    expect(
      rows().filter((row) => row.classList.contains("build-row--moving")),
    ).toHaveLength(0);
  });
});

describe("out of date", () => {
  test("at 14 min shows the banner and keeps the builds", async () => {
    const { container } = await renderLoaded(
      response({ receivedAgo: 14 * MIN }),
    );
    expect(
      screen.getByText("The factory machine hasn't reported for 14 min."),
    ).toBeInTheDocument();
    expect(rows()).toHaveLength(5);
    expect(container.querySelector(".overview__updated")).toHaveClass(
      "overview__updated--late",
    );
    expect(
      container.querySelector(".overview__content--dimmed"),
    ).toContainElement(rowOf("014 Recorded shows"));
  });

  test("at 2 min there is no banner", async () => {
    await renderLoaded(response({ receivedAgo: 2 * MIN }));
    expect(screen.queryByText(/hasn't reported for/)).not.toBeInTheDocument();
  });

  test.each([
    ["no builds", () => []],
    ["only a done build", () => [done()]],
  ])("with %s, the panel dims and the footer does not", async (_l, builds) => {
    const { container } = await renderLoaded(
      response({ builds: builds(), receivedAgo: 14 * MIN }),
    );
    expect(
      screen.getByText("The factory machine hasn't reported for 14 min."),
    ).toBeInTheDocument();
    expect(container.querySelector(".overview__updated")).toHaveClass(
      "overview__updated--late",
    );
    const dimmed = container.querySelector(".overview__content--dimmed");
    expect(dimmed).toContainElement(screen.getByText("Nothing in flight"));
    expect(dimmed).not.toContainElement(screen.getByText("Done 22"));
  });
});

describe("nothing in flight", () => {
  test("with no builds shows the panel and the footer", async () => {
    await renderLoaded(response({ builds: [] }));
    expect(screen.getByText("Nothing in flight")).toBeInTheDocument();
    expect(screen.getByText("Nothing running")).toBeInTheDocument();
    expect(screen.getByText("Up next 3")).toBeInTheDocument();
    expect(screen.queryByText("Not connected yet")).not.toBeInTheDocument();
  });

  test("with only a done build lists it below the panel", async () => {
    await renderLoaded(response({ builds: [done()] }));
    const panel = screen.getByText("Nothing in flight");
    const row = rowOf("009 Station analytics");
    expect(
      panel.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

test("not connected yet shows its panel, with no footer and no Updated time", async () => {
  const { container } = await renderLoaded(notConnected());
  expect(screen.getByText("Not connected yet")).toBeInTheDocument();
  expect(screen.getByText("No report yet")).toBeInTheDocument();
  expect(screen.queryByText("Nothing in flight")).not.toBeInTheDocument();
  expect(screen.queryByText(/Up next/)).not.toBeInTheDocument();
  expect(container.querySelector(".overview__updated")).toBeNull();
});

test("the first fetch shows the loading placeholder", () => {
  get.mockReturnValue(new Promise(() => {}));
  renderApp("/factory");
  expect(screen.getByLabelText("Loading the factory")).toHaveAttribute(
    "aria-busy",
    "true",
  );
});

describe("couldn't load", () => {
  test("a 500 shows the error, and Try again recovers", async () => {
    get.mockRejectedValueOnce(httpError(500, { error: "internal_error" }));
    renderApp("/factory");
    expect(
      await screen.findByText("Couldn't load the factory"),
    ).toBeInTheDocument();
    get.mockResolvedValueOnce(answer(response()));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("014 Recorded shows")).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load the factory")).toBeNull();
  });

  test("a network error shows the same message", async () => {
    get.mockRejectedValueOnce(networkError());
    renderApp("/factory");
    expect(
      await screen.findByText("Couldn't load the factory"),
    ).toBeInTheDocument();
  });

  test("a stalled request fails after 15 s and the next poll recovers", async () => {
    vi.useFakeTimers();
    get.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          setTimeout(
            () =>
              reject(
                new AxiosError("timeout of 15000ms exceeded", "ECONNABORTED"),
              ),
            15_000,
          );
        }),
    );
    renderApp("/factory");
    await flush();
    expect(screen.getByLabelText("Loading the factory")).toBeInTheDocument();
    await advance(15_000);
    expect(screen.getByText("Couldn't load the factory")).toBeInTheDocument();
    get.mockResolvedValueOnce(answer(response()));
    await advance(15_000);
    expect(screen.getByText("014 Recorded shows")).toBeInTheDocument();
    expect(get).toHaveBeenCalledTimes(2);
  });

  test("a failed refresh replaces the list, and the next one brings it back", async () => {
    vi.useFakeTimers();
    get.mockResolvedValueOnce(answer(response()));
    renderApp("/factory");
    await flush();
    expect(screen.getByText("014 Recorded shows")).toBeInTheDocument();
    get.mockRejectedValueOnce(networkError());
    await advance(30_000);
    expect(screen.getByText("Couldn't load the factory")).toBeInTheDocument();
    expect(screen.queryByText("014 Recorded shows")).toBeNull();
    get.mockResolvedValueOnce(answer(response()));
    await advance(30_000);
    expect(screen.getByText("014 Recorded shows")).toBeInTheDocument();
  });
});

describe("polling", () => {
  test("fetches again after 30 s", async () => {
    vi.useFakeTimers();
    get.mockResolvedValue(answer(response()));
    renderApp("/factory");
    await flush();
    expect(get).toHaveBeenCalledTimes(1);
    await advance(29_999);
    expect(get).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(get).toHaveBeenCalledTimes(2);
  });

  test("stops while hidden and fetches at once when visible again", async () => {
    vi.useFakeTimers();
    get.mockResolvedValue(answer(response()));
    renderApp("/factory");
    await flush();
    setVisibility("hidden");
    await advance(60_000);
    expect(get).toHaveBeenCalledTimes(1);
    setVisibility("visible");
    await flush();
    expect(get).toHaveBeenCalledTimes(2);
  });

  test("a call pending across a hide and show is not sent twice", async () => {
    vi.useFakeTimers();
    get.mockResolvedValueOnce(answer(response({ builds: [] })));
    renderApp("/factory");
    await flush();
    expect(screen.getByText("Nothing in flight")).toBeInTheDocument();

    let resolvePending!: (value: { data: SnapshotResponse }) => void;
    get.mockImplementationOnce(
      () => new Promise((resolve) => (resolvePending = resolve)),
    );
    await advance(30_000);
    expect(get).toHaveBeenCalledTimes(2);
    setVisibility("hidden");
    await advance(5_000);
    setVisibility("visible");
    await flush();
    expect(get).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolvePending(answer(response()));
    });
    expect(screen.getByText("014 Recorded shows")).toBeInTheDocument();

    get.mockResolvedValue(answer(response()));
    await advance(29_999);
    expect(get).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(get).toHaveBeenCalledTimes(3);
  });

  test("mounted while hidden, it waits until shown", async () => {
    vi.useFakeTimers();
    visibility = "hidden";
    get.mockResolvedValue(answer(response()));
    renderApp("/factory");
    await advance(60_000);
    expect(get).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Loading the factory")).toBeInTheDocument();
    setVisibility("visible");
    await flush();
    expect(get).toHaveBeenCalledTimes(1);
    expect(screen.getByText("014 Recorded shows")).toBeInTheDocument();
  });
});

test("a 401 clears the session and returns to the landing page", async () => {
  get.mockRejectedValue(httpError(401, { error: "unauthorized" }));
  renderApp("/factory");
  expect(
    await screen.findByRole("button", { name: /sign in with google/i }),
  ).toBeInTheDocument();
  expect(localStorage.length).toBe(0);
  expect(window.location.pathname).toBe("/");
  expect(window.location.search).toContain("redirectTo=%2Ffactory");
});
