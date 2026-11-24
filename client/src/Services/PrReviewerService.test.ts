import axios from "axios";
import {
  createRun,
  fetchChapters,
  fetchLatestRun,
  fetchMarkdownFile,
  fetchRun,
  retryRun,
  setChapterReviewed,
} from "./PrReviewerService";
import { saveSession } from "../utils/session";
import { makeToken } from "../test/tokens";

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

let token: string;
const auth = () => ({
  headers: { Authorization: `Bearer ${token}` },
  timeout: 15000,
});

beforeEach(() => {
  localStorage.clear();
  vi.resetAllMocks();
  token = makeToken();
  saveSession(token);
});

test("fetchLatestRun reads runs/latest for the PR with the stored token", async () => {
  const data = { pr: { title: "t" }, run: null };
  get.mockResolvedValue({ data });
  await expect(fetchLatestRun("playola-radio", "playola", "123")).resolves.toBe(
    data,
  );
  expect(get).toHaveBeenCalledWith(
    expect.stringMatching(
      /\/v1\/pr-reviewer\/playola-radio\/playola\/pulls\/123\/runs\/latest$/,
    ),
    auth(),
  );
});

test("createRun posts to the PR's runs with no body and returns the run", async () => {
  const run = { id: "r1" };
  post.mockResolvedValue({ data: { run } });
  await expect(createRun("o", "r", 7)).resolves.toBe(run);
  expect(post).toHaveBeenCalledWith(
    expect.stringMatching(/\/v1\/pr-reviewer\/o\/r\/pulls\/7\/runs$/),
    null,
    auth(),
  );
});

test("fetchRun polls the run by id", async () => {
  const run = { id: "r1" };
  get.mockResolvedValue({ data: { run } });
  await expect(fetchRun("r1")).resolves.toBe(run);
  expect(get).toHaveBeenCalledWith(
    expect.stringMatching(/\/v1\/pr-reviewer\/runs\/r1$/),
    auth(),
  );
});

test("retryRun posts to the run's retry endpoint", async () => {
  const run = { id: "r1" };
  post.mockResolvedValue({ data: { run } });
  await expect(retryRun("r1")).resolves.toBe(run);
  expect(post).toHaveBeenCalledWith(
    expect.stringMatching(/\/v1\/pr-reviewer\/runs\/r1\/retry$/),
    null,
    auth(),
  );
});

test("fetchChapters returns run, document and reviewed", async () => {
  const data = { run: {}, document: {}, reviewed: ["a"] };
  get.mockResolvedValue({ data });
  await expect(fetchChapters("r1")).resolves.toBe(data);
  expect(get).toHaveBeenCalledWith(
    expect.stringMatching(/\/v1\/pr-reviewer\/runs\/r1\/chapters$/),
    auth(),
  );
});

test("fetchMarkdownFile passes the path as a query parameter", async () => {
  const data = { path: "docs/a b.md", text: "# hi" };
  get.mockResolvedValue({ data });
  await expect(fetchMarkdownFile("r1", "docs/a b.md")).resolves.toBe(data);
  expect(get).toHaveBeenCalledWith(
    expect.stringMatching(/\/v1\/pr-reviewer\/runs\/r1\/files$/),
    { ...auth(), params: { path: "docs/a b.md" } },
  );
});

test("setChapterReviewed PUTs to mark and DELETEs to clear, with the key encoded", async () => {
  put.mockResolvedValue({ status: 204 });
  del.mockResolvedValue({ status: 204 });
  await setChapterReviewed("r1", "retry/logic", true);
  expect(put).toHaveBeenCalledWith(
    expect.stringMatching(
      /\/v1\/pr-reviewer\/runs\/r1\/chapters\/retry%2Flogic\/reviewed$/,
    ),
    null,
    auth(),
  );
  await setChapterReviewed("r1", "retry/logic", false);
  expect(del).toHaveBeenCalledWith(
    expect.stringMatching(
      /\/v1\/pr-reviewer\/runs\/r1\/chapters\/retry%2Flogic\/reviewed$/,
    ),
    auth(),
  );
});

test("errors propagate to the caller", async () => {
  get.mockRejectedValue(new Error("boom"));
  await expect(fetchRun("r1")).rejects.toThrow("boom");
});
