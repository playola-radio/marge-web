import axios from "axios";
import { fetchFactorySnapshot } from "./FactoryService";
import { saveSession } from "../utils/session";
import { makeToken } from "../test/tokens";

vi.mock("axios", async (importOriginal) => {
  const actual = await importOriginal<typeof import("axios")>();
  return { ...actual, default: { ...actual.default, get: vi.fn() } };
});

const get = vi.mocked(axios.get);

beforeEach(() => {
  localStorage.clear();
  get.mockReset();
});

test("fetchFactorySnapshot sends the stored token with a 15 s timeout and returns the data", async () => {
  const token = makeToken();
  saveSession(token);
  const data = {
    catalog: null,
    snapshot: null,
    receivedAt: null,
    serverNow: "2026-11-21T18:43:02.000Z",
  };
  get.mockResolvedValue({ data });

  await expect(fetchFactorySnapshot()).resolves.toEqual(data);
  expect(get).toHaveBeenCalledWith(
    expect.stringMatching(/\/v1\/factory\/snapshot$/),
    { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 },
  );
});
