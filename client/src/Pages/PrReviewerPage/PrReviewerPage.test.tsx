import { act, fireEvent, screen, within } from "@testing-library/react";
import axios from "axios";
import { saveSession } from "../../utils/session";
import { renderApp } from "../../test/renderApp";
import { makeToken } from "../../test/tokens";
import { httpError, networkError } from "../../test/axios";
import {
  BASE_B,
  HEAD_B,
  README_TEXT,
  RUN_A,
  RUN_B,
  fixtureDocument,
  latest,
  makeRun,
  mixedDocument,
} from "../../test/prReviewerFixtures";
import type {
  ChaptersDocument,
  ChaptersResponse,
  LatestResponse,
  Run,
} from "../../Services/PrReviewerService";

vi.mock("@react-oauth/google", () => import("../../test/googleOAuthMock"));
vi.mock("axios", async (importOriginal) => {
  const actual = await importOriginal<typeof import("axios")>();
  return {
    ...actual,
    default: {
      ...actual.default,
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    },
  };
});

const get = vi.mocked(axios.get);
const post = vi.mocked(axios.post);
const put = vi.mocked(axios.put);
const del = vi.mocked(axios.delete);

const PAGE = "/pr-reviewer/playola-radio/playola/pulls/123";

/** The fake API: one mock per endpoint, answering with the response body. */
const api = {
  latest: vi.fn<() => Promise<LatestResponse>>(),
  create: vi.fn<() => Promise<Run>>(),
  poll: vi.fn<(runId: string) => Promise<Run>>(),
  retry: vi.fn<(runId: string) => Promise<Run>>(),
  chapters: vi.fn<(runId: string) => Promise<ChaptersResponse>>(),
  file: vi.fn<
    (runId: string, path: string) => Promise<{ path: string; text: string }>
  >(),
  mark: vi.fn<(runId: string, key: string) => Promise<void>>(),
  unmark: vi.fn<(runId: string, key: string) => Promise<void>>(),
};

const runIdOf = (url: string) => /\/runs\/([^/]+)/.exec(url)![1];
const keyOf = (url: string) =>
  decodeURIComponent(/\/chapters\/([^/]+)\/reviewed$/.exec(url)![1]);

function wireApi() {
  get.mockImplementation(async (url: string, config?: { params?: unknown }) => {
    if (url.endsWith("/runs/latest")) return { data: await api.latest() };
    if (url.endsWith("/chapters"))
      return { data: await api.chapters(runIdOf(url)) };
    if (url.endsWith("/files")) {
      const { path } = config!.params as { path: string };
      return { data: await api.file(runIdOf(url), path) };
    }
    return { data: { run: await api.poll(runIdOf(url)) } };
  });
  post.mockImplementation(async (url: string) => {
    if (url.endsWith("/retry"))
      return { data: { run: await api.retry(runIdOf(url)) } };
    return { data: { run: await api.create() } };
  });
  put.mockImplementation(async (url: string) => {
    await api.mark(runIdOf(url), keyOf(url));
    return { status: 204 };
  });
  del.mockImplementation(async (url: string) => {
    await api.unmark(runIdOf(url), keyOf(url));
    return { status: 204 };
  });
}

function chaptersOf(
  run: Run,
  document: ChaptersDocument = fixtureDocument(),
  reviewed: string[] = [],
): ChaptersResponse {
  return { run, document, reviewed };
}

const creates = () =>
  post.mock.calls.filter(([url]) => !String(url).endsWith("/retry"));
const lookups = () =>
  get.mock.calls.filter(([url]) => String(url).endsWith("/runs/latest"));

beforeEach(() => {
  localStorage.clear();
  vi.resetAllMocks();
  saveSession(makeToken({ email: "brian@playola.fm" }));
  wireApi();
  api.latest.mockResolvedValue(latest(makeRun()));
  api.chapters.mockImplementation(async (runId) =>
    chaptersOf(makeRun({ id: runId })),
  );
  api.file.mockImplementation(async (_runId, path) => ({
    path,
    text: README_TEXT,
  }));
  api.mark.mockResolvedValue(undefined);
  api.unmark.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

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

async function renderReady() {
  const view = renderApp(PAGE);
  await screen.findByText("What this PR does");
  return view;
}

async function focusWindow() {
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });
}

const reviewedButton = (headline: string) =>
  screen.getByRole("button", { name: `Reviewed: ${headline}` });
const chapterToggle = (headline: string) =>
  screen
    .getAllByRole("button", { name: new RegExp(`^${headline}`) })
    .find((b) => b.hasAttribute("aria-expanded"))!;
const CH1 = "Share one fixture repository and give setup more time";
const CH2 = "Retry flaky calls a bounded number of times";

/* ---------------- Generation flow ---------------- */

describe("first visit", () => {
  test("with no run, posts run creation, shows the stages, and polls until the chapters show", async () => {
    vi.useFakeTimers();
    api.latest.mockResolvedValue(latest(null));
    api.create.mockResolvedValue(makeRun({ status: "queued" }));
    renderApp(PAGE);
    await flush();
    expect(creates()).toHaveLength(1);
    expect(String(creates()[0][0])).toMatch(
      /\/v1\/pr-reviewer\/playola-radio\/playola\/pulls\/123\/runs$/,
    );
    expect(
      screen.getByText("Waiting to start generating chapters…"),
    ).toBeInTheDocument();
    expect(screen.getByText("Fetching the repo")).toBeInTheDocument();
    expect(screen.getByText("Summarizing")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Fix flaky tests by cutting slow git setup work",
      }),
    ).toBeInTheDocument();

    api.poll.mockResolvedValueOnce(
      makeRun({
        status: "generating",
        progress: { stage: "write", completedChapters: 1, totalChapters: 2 },
      }),
    );
    await advance(3_000);
    const current = screen.getByText("Writing chapters (1 of 2)");
    expect(current.closest("li")).toHaveAttribute("aria-current", "step");
    expect(screen.getByText("Outlining").closest("li")).toHaveClass(
      "progress__stage--done",
    );
    expect(
      screen.getByText(/generation keeps going on the server/),
    ).toBeInTheDocument();

    api.poll.mockResolvedValueOnce(makeRun({ status: "ready" }));
    await advance(3_000);
    expect(screen.getByText("What this PR does")).toBeInTheDocument();
    expect(api.chapters).toHaveBeenCalledWith(RUN_A);
    expect(creates()).toHaveLength(1);
  });

  test("a chapters request that answers run_not_ready goes back to polling", async () => {
    vi.useFakeTimers();
    api.chapters.mockRejectedValueOnce(
      httpError(409, {
        error: "run_not_ready",
        run: makeRun({ status: "generating" }),
      }),
    );
    renderApp(PAGE);
    await flush();
    expect(screen.getByText("Generating chapters…")).toBeInTheDocument();
    api.poll.mockResolvedValueOnce(makeRun());
    await advance(3_000);
    expect(screen.getByText("What this PR does")).toBeInTheDocument();
  });
});

describe("ready page", () => {
  test("renders the header, summary, ordered chapters, split diffs with owner commits, and the excluded section", async () => {
    await renderReady();
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Fix flaky tests by cutting slow git setup work",
      }),
    ).toBeInTheDocument();
    const header = screen.getByRole("region", { name: "Pull request" });
    expect(header).toHaveTextContent(
      "main ← brian-keane/chapters-flaky-test-fix · 2 commits · generated for ef9d1d7",
    );
    const link = within(header).getByRole("link", {
      name: "PR #123: Fix flaky tests by cutting slow git setup work",
    });
    expect(link).toHaveAttribute(
      "href",
      "https://github.com/playola-radio/playola/pull/123",
    );

    expect(screen.getByText(fixtureDocument().summary)).toBeInTheDocument();
    expect(
      screen.getByText("Written from 2 commits and the diff"),
    ).toBeInTheDocument();

    const headings = screen
      .getAllByRole("heading", { level: 3 })
      .map((h) => h.textContent);
    expect(headings).toEqual([`${CH1}▾`, `${CH2}▸`]);
    expect(
      screen.getByText("src/setup.ts · +2 −1 · commit 1111111"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "The setup timeout goes from 5 to 30 seconds so a cold clone can finish.",
      ),
    ).toBeInTheDocument();

    // Split diff: the old line on the left, the new on the right, with numbers.
    const added = screen
      .getAllByText("export const TIMEOUT_MS = 30000;")[0]
      .closest(".diff__cell")!;
    expect(added).toHaveClass("diff__cell--add", "diff__cell--this");
    const row = added.closest(".diff__row")!;
    expect(row.querySelector(".diff__cell--del")).toHaveTextContent(
      "2−export const TIMEOUT_MS = 5000;",
    );

    const rail = screen.getByRole("complementary", { name: "Chapters" });
    expect(rail).toHaveTextContent("0 of 2 reviewed");
    expect(within(rail).getByText(CH1).closest("button")).toHaveAttribute(
      "aria-current",
      "true",
    );
    expect(rail).toHaveTextContent("1 file · +2 −1");
    const excluded = within(rail).getByRole("region", {
      name: "Not in a chapter",
    });
    expect(excluded).toHaveTextContent("package-lock.json");
    expect(excluded).toHaveTextContent("Generated lockfile change");
  });

  test("clicking an excluded change shows its plain diff", async () => {
    await renderReady();
    fireEvent.click(
      screen.getByRole("button", { name: "Generated lockfile change" }),
    );
    const panel = screen.getByRole("region", {
      name: "Change not in a chapter",
    });
    expect(panel).toHaveTextContent(
      "Not in a chapter: Generated lockfile change",
    );
    expect(
      within(panel)
        .getByText('"version": "1.0.1",', { exact: false })
        .closest(".diff__cell"),
    ).toHaveAttribute("data-role", "this");
    fireEvent.click(within(panel).getByRole("button", { name: "Close" }));
    expect(
      screen.queryByRole("region", { name: "Change not in a chapter" }),
    ).toBeNull();
  });

  test("two excluded runs in one file are told apart by their lines", async () => {
    const doc = fixtureDocument();
    doc.runs.push({
      id: "run-lockfile-2",
      path: "package-lock.json",
      commitSha: "2".repeat(40),
      added: 2,
      removed: 0,
      newRange: [8, 9],
    });
    doc.excluded.push({
      runId: "run-lockfile-2",
      reason: "Generated lockfile change",
    });
    api.chapters.mockResolvedValue(chaptersOf(makeRun(), doc));
    await renderReady();
    expect(
      screen.getByRole("button", {
        name: "Generated lockfile change (line 2)",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Generated lockfile change (lines 8–9)",
      }),
    ).toBeInTheDocument();
  });

  test("with nothing excluded, the rail says every change is in a chapter", async () => {
    api.chapters.mockResolvedValue(
      chaptersOf(makeRun(), { ...fixtureDocument(), excluded: [] }),
    );
    await renderReady();
    expect(
      screen.getByText("Every change is in a chapter."),
    ).toBeInTheDocument();
  });
});

/* ---------------- Reviewed marks ---------------- */

describe("reviewed", () => {
  test("toggling calls PUT then DELETE with the chapter key and updates the count", async () => {
    await renderReady();
    fireEvent.click(reviewedButton(CH1));
    expect(reviewedButton(CH1)).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("1 of 2 reviewed")).toBeInTheDocument();
    await act(async () => {});
    expect(api.mark).toHaveBeenCalledWith(RUN_A, "setup-timeouts");

    fireEvent.click(reviewedButton(CH1));
    await act(async () => {});
    expect(api.unmark).toHaveBeenCalledWith(RUN_A, "setup-timeouts");
    expect(screen.getByText("0 of 2 reviewed")).toBeInTheDocument();
    expect(reviewedButton(CH1)).toHaveAttribute("aria-pressed", "false");
  });

  test("the flip shows before the server answers", async () => {
    api.mark.mockReturnValue(new Promise(() => {}));
    await renderReady();
    fireEvent.click(reviewedButton(CH2));
    expect(reviewedButton(CH2)).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("1 of 2 reviewed")).toBeInTheDocument();
  });

  test("a quick undo waits for the mark's save, so the saves land in click order", async () => {
    let finishMark = () => {};
    api.mark.mockReturnValue(new Promise<void>((r) => (finishMark = r)));
    await renderReady();
    fireEvent.click(reviewedButton(CH1));
    fireEvent.click(reviewedButton(CH1));
    await act(async () => {});
    expect(api.unmark).not.toHaveBeenCalled();
    await act(async () => finishMark());
    expect(api.unmark).toHaveBeenCalledWith(RUN_A, "setup-timeouts");
    expect(reviewedButton(CH1)).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("0 of 2 reviewed")).toBeInTheDocument();
  });

  test("a failed save with newer clicks queued behind it leaves the newest click standing", async () => {
    let failMark: (e: unknown) => void = () => {};
    api.mark
      .mockReturnValueOnce(new Promise<void>((_r, j) => (failMark = j)))
      .mockResolvedValue(undefined);
    await renderReady();
    fireEvent.click(reviewedButton(CH1));
    fireEvent.click(reviewedButton(CH1));
    fireEvent.click(reviewedButton(CH1));
    await act(async () => failMark(networkError()));
    await act(async () => {});
    expect(api.unmark).toHaveBeenCalledWith(RUN_A, "setup-timeouts");
    expect(api.mark).toHaveBeenCalledTimes(2);
    expect(reviewedButton(CH1)).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("1 of 2 reviewed")).toBeInTheDocument();
    expect(screen.queryByText(/Couldn't save your Reviewed mark/)).toBeNull();
  });

  test("marks come from the chapters response on load", async () => {
    api.chapters.mockResolvedValue(
      chaptersOf(makeRun(), fixtureDocument(), ["retry-logic"]),
    );
    await renderReady();
    expect(reviewedButton(CH2)).toHaveAttribute("aria-pressed", "true");
    expect(reviewedButton(CH1)).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("1 of 2 reviewed")).toBeInTheDocument();
  });

  test.each([
    ["a network error", () => networkError()],
    ["a 5xx", () => httpError(500, { error: "internal_error" })],
  ])(
    "a PUT that fails with %s reverts the toggle and count and shows a dismissible note",
    async (_label, error) => {
      api.mark.mockRejectedValue(error());
      await renderReady();
      fireEvent.click(reviewedButton(CH1));
      await act(async () => {});
      expect(reviewedButton(CH1)).toHaveAttribute("aria-pressed", "false");
      expect(screen.getByText("0 of 2 reviewed")).toBeInTheDocument();
      expect(
        screen.getByText("Couldn't save your Reviewed mark. Please try again."),
      ).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
      expect(screen.queryByText(/Couldn't save your Reviewed mark/)).toBeNull();
    },
  );

  test("a failed DELETE restores the mark and the count", async () => {
    api.chapters.mockResolvedValue(
      chaptersOf(makeRun(), fixtureDocument(), ["setup-timeouts"]),
    );
    api.unmark.mockRejectedValue(httpError(503, { error: "unavailable" }));
    await renderReady();
    expect(screen.getByText("1 of 2 reviewed")).toBeInTheDocument();
    fireEvent.click(reviewedButton(CH1));
    await act(async () => {});
    expect(reviewedButton(CH1)).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("1 of 2 reviewed")).toBeInTheDocument();
    expect(
      screen.getByText("Couldn't save your Reviewed mark. Please try again."),
    ).toBeInTheDocument();
  });

  test("marking a chapter reviewed collapses it and opens the next unreviewed chapter", async () => {
    await renderReady();
    expect(chapterToggle(CH1)).toHaveAttribute("aria-expanded", "true");
    expect(chapterToggle(CH2)).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(reviewedButton(CH1));
    expect(chapterToggle(CH1)).toHaveAttribute("aria-expanded", "false");
    expect(chapterToggle(CH2)).toHaveAttribute("aria-expanded", "true");
    expect(
      within(screen.getByRole("complementary", { name: "Chapters" }))
        .getByText(CH2)
        .closest("button"),
    ).toHaveAttribute("aria-current", "true");
    await act(async () => {});
  });
});

/* ---------------- Failed run ---------------- */

test("a failed run shows the failure with collapsed detail, and Retry calls the retry endpoint", async () => {
  vi.useFakeTimers();
  const failed = makeRun({
    status: "failed",
    failure: "Generation failed while writing chapter 3",
    failureDetail: "Error: 529 overloaded",
  });
  api.latest.mockResolvedValue(latest(failed));
  api.retry.mockResolvedValue(makeRun({ status: "queued" }));
  renderApp(PAGE);
  await flush();
  expect(
    screen.getByText("Generation failed while writing chapter 3"),
  ).toBeInTheDocument();
  const details = screen.getByText("Error: 529 overloaded").closest("details")!;
  expect(details).not.toHaveAttribute("open");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await flush();
  expect(api.retry).toHaveBeenCalledWith(RUN_A);
  expect(creates()).toHaveLength(0);
  expect(
    screen.getByText("Waiting to start generating chapters…"),
  ).toBeInTheDocument();
  api.poll.mockResolvedValueOnce(makeRun());
  await advance(3_000);
  expect(screen.getByText("What this PR does")).toBeInTheDocument();
});

/* ---------------- Freshness ---------------- */

describe("superseded revision", () => {
  test.each([
    ["head", { currentHeadSha: HEAD_B }],
    ["merge base", { currentBaseSha: BASE_B }],
  ])("a different %s shows the banner without any POST", async (_label, pr) => {
    api.latest.mockResolvedValue(latest(makeRun(), pr));
    await renderReady();
    expect(
      screen.getByText(/These chapters were generated for/),
    ).toHaveTextContent(
      "These chapters were generated for ef9d1d7; the PR has changed.",
    );
    expect(
      screen.getByRole("button", { name: "Generate for latest" }),
    ).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  test("Generate for latest posts a new run and follows it", async () => {
    api.latest.mockResolvedValue(latest(makeRun(), { currentHeadSha: HEAD_B }));
    api.create.mockResolvedValue(
      makeRun({
        id: RUN_B,
        headSha: HEAD_B,
        status: "queued",
        createdAt: "2026-11-23T10:00:00.000Z",
      }),
    );
    await renderReady();
    fireEvent.click(
      screen.getByRole("button", { name: "Generate for latest" }),
    );
    await act(async () => {});
    expect(creates()).toHaveLength(1);
    expect(
      screen.getByText("Waiting to start generating chapters…"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Generate for latest" }),
    ).toBeNull();
  });

  test("an outdated newer run does not hide Generate for latest", async () => {
    const outdated = makeRun({
      id: RUN_B,
      headSha: HEAD_B,
      status: "generating",
      createdAt: "2026-11-23T10:00:00.000Z",
    });
    api.latest.mockResolvedValue(
      latest(makeRun(), { currentHeadSha: "c".repeat(40) }, outdated),
    );
    await renderReady();
    expect(
      screen.getByRole("button", { name: "Generate for latest" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "View latest" })).toBeNull();
  });
});

describe("view latest", () => {
  const runB = (overrides: Partial<Run> = {}) =>
    makeRun({
      id: RUN_B,
      headSha: HEAD_B,
      status: "generating",
      progress: { stage: "outline" },
      createdAt: "2026-11-23T10:00:00.000Z",
      ...overrides,
    });
  const docB = (): ChaptersDocument => ({
    ...fixtureDocument(),
    headSha: HEAD_B,
    summary: "Run B's summary of the newer revision.",
  });

  test("a focus lookup with a newer generating run keeps A on screen and offers View latest, which polls B by id", async () => {
    vi.useFakeTimers();
    renderApp(PAGE);
    await flush();
    expect(screen.getByText(fixtureDocument().summary)).toBeInTheDocument();

    api.latest.mockResolvedValue(
      latest(makeRun(), { currentHeadSha: HEAD_B }, runB()),
    );
    await focusWindow();
    await flush();
    expect(screen.getByText(fixtureDocument().summary)).toBeInTheDocument();
    expect(
      screen.getByText("Chapters for the latest revision are generating."),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Generate for latest" }),
    ).toBeNull();

    api.poll.mockResolvedValue(runB());
    fireEvent.click(screen.getByRole("button", { name: "View latest" }));
    await flush();
    expect(api.poll).toHaveBeenCalledWith(RUN_B);
    expect(screen.queryByText(fixtureDocument().summary)).toBeNull();
    expect(screen.getByText("Outlining").closest("li")).toHaveAttribute(
      "aria-current",
      "step",
    );
    expect(post).not.toHaveBeenCalled();

    // A later focus lookup naming B as the newer run offers nothing backward.
    await focusWindow();
    await flush();
    expect(screen.queryByRole("button", { name: "View latest" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Generate for latest" }),
    ).toBeNull();
    expect(screen.getByText("Outlining").closest("li")).toHaveAttribute(
      "aria-current",
      "step",
    );
    expect(api.chapters).not.toHaveBeenCalledWith(RUN_B);
  });

  test("a lookup returning a ready B as its run keeps A, and switches only on View latest with no POST", async () => {
    await renderReady();
    api.latest.mockResolvedValue(
      latest(runB({ status: "ready", progress: null }), {
        currentHeadSha: HEAD_B,
      }),
    );
    await focusWindow();
    expect(
      await screen.findByText("Chapters for the latest revision are ready."),
    ).toBeInTheDocument();
    expect(screen.getByText(fixtureDocument().summary)).toBeInTheDocument();

    api.poll.mockResolvedValue(runB({ status: "ready", progress: null }));
    api.chapters.mockImplementation(async (runId) =>
      runId === RUN_B
        ? chaptersOf(runB({ status: "ready", progress: null }), docB())
        : chaptersOf(makeRun()),
    );
    fireEvent.click(screen.getByRole("button", { name: "View latest" }));
    expect(
      await screen.findByText("Run B's summary of the newer revision."),
    ).toBeInTheDocument();
    expect(screen.queryByText(fixtureDocument().summary)).toBeNull();
    expect(screen.getByText(/generated for/)).toHaveTextContent(
      "generated for aa11bb2",
    );
    expect(post).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "View latest" })).toBeNull();
  });

  test("switching from A to B renders B's markdown text, fetched by B's run id", async () => {
    // Both runs change README.md; chapter 2 (the README step) is open.
    api.chapters.mockImplementation(async (runId) =>
      runId === RUN_B
        ? chaptersOf(runB({ status: "ready", progress: null }), docB(), [
            "setup-timeouts",
          ])
        : chaptersOf(makeRun(), fixtureDocument(), ["setup-timeouts"]),
    );
    api.file.mockImplementation(async (runId, path) => ({
      path,
      text:
        runId === RUN_B
          ? README_TEXT.replace("Flaky calls", "B's flaky calls")
          : README_TEXT,
    }));
    const { container } = await renderReady();
    await screen.findByText(/Flaky calls retry up to/);
    expect(api.file).toHaveBeenCalledWith(RUN_A, "README.md");

    api.latest.mockResolvedValue(
      latest(runB({ status: "ready", progress: null }), {
        currentHeadSha: HEAD_B,
      }),
    );
    await focusWindow();
    api.poll.mockResolvedValue(runB({ status: "ready", progress: null }));
    fireEvent.click(await screen.findByRole("button", { name: "View latest" }));
    await screen.findByText("Run B's summary of the newer revision.");
    await screen.findByText(/B's flaky calls retry up to/);
    expect(api.file).toHaveBeenCalledWith(RUN_B, "README.md");
    expect(container.querySelector(".md-view")).not.toHaveTextContent(
      /^Flaky calls/,
    );
  });
});

/* ---------------- Messages and errors ---------------- */

describe("messages", () => {
  test("an empty diff renders its message and starts nothing", async () => {
    api.latest.mockResolvedValue(latest(null));
    api.create.mockRejectedValue(httpError(422, { error: "empty_diff" }));
    renderApp(PAGE);
    expect(await screen.findByText("Nothing to narrate.")).toBeInTheDocument();
    expect(
      screen.getByText(/no changes between its merge base and its head/),
    ).toBeInTheDocument();
  });

  test("an unknown PR renders the lookup failure", async () => {
    api.latest.mockRejectedValue(httpError(404, { error: "pr_not_found" }));
    renderApp(PAGE);
    expect(
      await screen.findByText("Couldn't find that pull request."),
    ).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  test("an initial 503 renders the unavailable card, and Try again re-reads without any POST", async () => {
    api.latest.mockRejectedValue(
      httpError(503, { error: "pr_reviewer_unavailable" }),
    );
    renderApp(PAGE);
    expect(
      await screen.findByText(
        "The PR reviewer isn't available on this server.",
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("The PR reviewer isn't available on this server.");
    expect(lookups()).toHaveLength(2);
    expect(post).not.toHaveBeenCalled();
  });

  test("a failed first lookup, then a Try again with no run, waits for Generate chapters", async () => {
    api.latest.mockRejectedValueOnce(networkError());
    renderApp(PAGE);
    expect(await screen.findByText("The request failed.")).toBeInTheDocument();
    expect(
      screen.getByText("Network Error").closest("details"),
    ).not.toHaveAttribute("open");

    api.latest.mockResolvedValue(latest(null));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    const button = await screen.findByRole("button", {
      name: "Generate chapters",
    });
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Fix flaky tests by cutting slow git setup work",
      }),
    ).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();

    api.create.mockResolvedValue(makeRun({ status: "queued" }));
    fireEvent.click(button);
    expect(
      await screen.findByText("Waiting to start generating chapters…"),
    ).toBeInTheDocument();
    expect(creates()).toHaveLength(1);
  });

  test("a failed freshness lookup keeps the chapters and shows a dismissible note", async () => {
    await renderReady();
    api.latest.mockRejectedValue(networkError());
    await focusWindow();
    expect(
      await screen.findByText("Couldn't check the PR for new commits."),
    ).toBeInTheDocument();
    expect(screen.getByText(fixtureDocument().summary)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(
      screen.queryByText("Couldn't check the PR for new commits."),
    ).toBeNull();
  });

  test("a failed poll keeps the progress on screen with a note and keeps polling", async () => {
    vi.useFakeTimers();
    api.latest.mockResolvedValue(
      latest(makeRun({ status: "generating", progress: { stage: "fetch" } })),
    );
    renderApp(PAGE);
    await flush();
    api.poll.mockRejectedValueOnce(networkError());
    await advance(3_000);
    expect(
      screen.getByText("Couldn't check on generation. Still trying."),
    ).toBeInTheDocument();
    expect(screen.getByText("Fetching the repo")).toBeInTheDocument();
    api.poll.mockResolvedValueOnce(makeRun());
    await advance(3_000);
    expect(screen.getByText("What this PR does")).toBeInTheDocument();
  });

  test("a 401 signs out back to the landing page", async () => {
    api.latest.mockRejectedValue(httpError(401, { error: "unauthorized" }));
    renderApp(PAGE);
    expect(
      await screen.findByRole("button", { name: /sign in with google/i }),
    ).toBeInTheDocument();
    expect(window.location.search).toContain("redirectTo=%2Fpr-reviewer");
  });

  test("the first fetch shows Loading…", () => {
    api.latest.mockReturnValue(new Promise(() => {}));
    renderApp(PAGE);
    expect(screen.getByRole("status")).toHaveTextContent("Loading…");
  });
});

/* ---------------- Renderer ---------------- */

describe("chapter diffs", () => {
  beforeEach(() => {
    api.chapters.mockResolvedValue(chaptersOf(makeRun(), mixedDocument()));
  });

  const cellOf = (text: string) =>
    screen.getByText(text).closest(".diff__cell")!;

  test("lines from other chapters carry their chapter's tag, and roles are marked", async () => {
    await renderReady();
    // Chapter 1 is open: its own line, a later chapter's line, and the excluded run.
    expect(cellOf("const b = 2;")).toHaveAttribute("data-role", "this");
    expect(cellOf("const c = 3;")).toHaveAttribute("data-role", "later");
    expect(cellOf("const c = 3;")).toHaveTextContent("ch 2");
    expect(cellOf('const v = "2";')).toHaveAttribute("data-role", "excluded");
    expect(cellOf('const v = "2";')).toHaveTextContent("not in a chapter");

    fireEvent.click(chapterToggle("Add c and late"));
    const chapter2 = screen.getByRole("listitem", { name: /Add c and late/ });
    const earlier = within(chapter2)
      .getByText("const b = 2;")
      .closest(".diff__cell")!;
    expect(earlier).toHaveAttribute("data-role", "earlier");
    expect(earlier.querySelector(".diff__tag")).toBeNull();
  });

  test("lines outside the step's ±3 window collapse to a bar that expands on click", async () => {
    await renderReady();
    expect(screen.queryByText("export const late = true;")).toBeNull();
    const bar = screen.getByRole("button", {
      name: "▸ 22 lines · 1 from ch 2",
    });
    fireEvent.click(bar);
    expect(screen.getByText("export const late = true;")).toBeInTheDocument();
    expect(document.activeElement).toHaveClass("diff__row");
    expect(document.activeElement).toHaveTextContent("filler 0");
    expect(cellOf("export const late = true;")).toHaveTextContent("ch 2");
    expect(screen.queryByRole("button", { name: /22 lines/ })).toBeNull();
  });

  test("the file order view badges every changed line with its chapter, or — when excluded", async () => {
    await renderReady();
    fireEvent.click(screen.getByRole("button", { name: "File order" }));
    expect(screen.getByRole("button", { name: "File order" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const badge = (text: string) =>
      cellOf(text).querySelector(".diff__badge")?.textContent;
    expect(badge("const b = 2;")).toBe("1");
    expect(badge("const c = 3;")).toBe("2");
    expect(badge('const v = "1";')).toBe("—");
    expect(badge('const v = "2";')).toBe("—");
    expect(badge("export const late = true;")).toBe("2");
    expect(
      screen
        .getAllByText("filler 3")[0]
        .closest(".diff__cell")!
        .querySelector(".diff__badge"),
    ).toBeNull();
  });
});

describe("markdown blocks", () => {
  /** Chapter 2's README step open, with the given README hunk and file text. */
  function readmeDoc(
    lines: ChaptersDocument["files"][number]["hunks"][number]["lines"],
  ) {
    const doc = fixtureDocument();
    const readme = doc.files.find((f) => f.path === "README.md")!;
    readme.hunks = [{ ...readme.hunks[0], lines }];
    return doc;
  }

  function serve(doc: ChaptersDocument, text: string) {
    api.chapters.mockResolvedValue(
      chaptersOf(makeRun(), doc, ["setup-timeouts"]),
    );
    api.file.mockResolvedValue({ path: "README.md", text });
  }

  test("defaults to Rendered, from the full file text, and toggles to Code", async () => {
    serve(fixtureDocument(), README_TEXT);
    const { container } = await renderReady();
    await screen.findByText(/Flaky calls retry up to/);
    const rendered = screen.getByRole("button", { name: "Rendered" });
    expect(rendered).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Code" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    const view = container.querySelector(".md-view")!;
    expect(view.querySelector("strong")).toHaveTextContent("three");
    expect(view.querySelector("p.md-this")).toHaveTextContent(
      "Run npm test. Flaky calls retry up to three times:",
    );
    // A replaced line is highlighted, with no removal marker.
    expect(view).not.toHaveTextContent(/removed/);
    expect(view).toHaveTextContent("changed in this step");

    fireEvent.click(screen.getByRole("button", { name: "Code" }));
    expect(container.querySelector(".md-view")).toBeNull();
    expect(
      screen.getByText("Run `npm test`.").closest(".diff__cell"),
    ).toHaveClass("diff__cell--del");
  });

  test("a fence opened above the hunk renders as a fence", async () => {
    const text = "# Setup\n\n```sh\nnpm ci\nnpm test\nnpm run lint\n```\n";
    serve(
      readmeDoc([
        { kind: " ", oldNo: 4, newNo: 4, text: "npm ci" },
        { kind: "-", oldNo: 5, text: "npm t", runId: "run-readme" },
        { kind: "+", newNo: 5, text: "npm test", runId: "run-readme" },
        { kind: " ", oldNo: 6, newNo: 6, text: "npm run lint" },
        { kind: " ", oldNo: 7, newNo: 7, text: "```" },
      ]),
      text,
    );
    const { container } = await renderReady();
    const code = await screen.findByText(/npm test/, { selector: "code" });
    expect(code.closest("pre")).not.toBeNull();
    expect(code).toHaveClass("md-this");
    expect(container.querySelector(".md-view")).not.toHaveTextContent("```");
    // The heading above sits behind a bar.
    expect(
      screen.getByRole("button", { name: "▸ 1 block" }),
    ).toBeInTheDocument();
  });

  test("a pure deletion shows one marker with its count where the text was", async () => {
    const text = "## Testing\n\nRun tests.\n";
    serve(
      readmeDoc([
        { kind: " ", oldNo: 1, newNo: 1, text: "## Testing" },
        { kind: " ", oldNo: 2, newNo: 2, text: "" },
        { kind: "-", oldNo: 3, text: "Old paragraph a", runId: "run-readme" },
        { kind: "-", oldNo: 4, text: "Old paragraph b", runId: "run-readme" },
        { kind: "-", oldNo: 5, text: "", runId: "run-readme" },
        { kind: " ", oldNo: 6, newNo: 3, text: "Run tests." },
      ]),
      text,
    );
    const { container } = await renderReady();
    const marker = await screen.findByText("− 3 lines removed");
    expect(marker.nextElementSibling).toHaveTextContent("Run tests.");
    expect(marker.previousElementSibling).toHaveTextContent("Testing");
    expect(container.querySelectorAll(".md-marker")).toHaveLength(1);
    expect(container.querySelector(".md-view")).not.toHaveTextContent(
      "Old paragraph",
    );
  });

  test("falls back to the code diff with a note when the file fetch 404s, and Rendered retries", async () => {
    serve(fixtureDocument(), README_TEXT);
    api.file.mockRejectedValueOnce(
      httpError(404, { error: "file_not_available" }),
    );
    await renderReady();
    expect(
      await screen.findByText(
        "Couldn't render this file: the file isn't available.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Run `npm test`.").closest(".diff__cell"),
    ).toHaveClass("diff__cell--del");
    fireEvent.click(screen.getByRole("button", { name: "Rendered" }));
    await screen.findByText(/Flaky calls retry up to/);
    expect(api.file).toHaveBeenCalledTimes(2);
  });

  test("after a failed fetch, going to Code and back to Rendered fetches again", async () => {
    serve(fixtureDocument(), README_TEXT);
    api.file.mockRejectedValueOnce(networkError());
    await renderReady();
    await screen.findByText("Couldn't render this file: the request failed.");
    fireEvent.click(screen.getByRole("button", { name: "Code" }));
    fireEvent.click(screen.getByRole("button", { name: "Rendered" }));
    await screen.findByText(/Flaky calls retry up to/);
    expect(api.file).toHaveBeenCalledTimes(2);
  });

  test("raw HTML is escaped, javascript: links get no href, and images render as text", async () => {
    const text = README_TEXT.replace(
      "Flaky calls retry up to **three** times:",
      "<script>alert(1)</script> [bad](javascript:alert(1)) ![pixel](https://t.example/p.gif)",
    );
    serve(fixtureDocument(), text);
    const { container } = await renderReady();
    await screen.findByText(/\[image: pixel\]/);
    const view = container.querySelector(".md-view")!;
    expect(view.querySelector("script")).toBeNull();
    expect(view).toHaveTextContent("<script>alert(1)</script>");
    expect(view.querySelector("img")).toBeNull();
    expect(view.querySelector('a[href^="javascript"]')).toBeNull();
    expect(view.querySelectorAll("a[href]")).toHaveLength(0);
  });
});
