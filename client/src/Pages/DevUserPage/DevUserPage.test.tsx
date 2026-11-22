import axios from "axios";
import { screen } from "@testing-library/react";
import { renderApp } from "../../test/renderApp";
import { httpError } from "../../test/axios";
import { makeToken } from "../../test/tokens";

vi.mock("@react-oauth/google", () => import("../../test/googleOAuthMock"));
vi.mock("axios", async (importOriginal) => {
  const actual = await importOriginal<typeof import("axios")>();
  return { ...actual, default: { ...actual.default, post: vi.fn() } };
});

const post = vi.mocked(axios.post);

beforeEach(() => {
  localStorage.clear();
  post.mockReset();
});

test("a successful dev sign-in shows the title screen with dev@marge.local", async () => {
  post.mockResolvedValue({
    data: { margeToken: makeToken({ email: "dev@marge.local" }) },
  });
  renderApp("/dev-user");
  expect(await screen.findByText("dev@marge.local")).toBeInTheDocument();
  expect(window.location.pathname).toBe("/home");
  expect(post).toHaveBeenCalledTimes(1);
});

test('a failed dev sign-in shows "Dev sign-in failed" and stores nothing', async () => {
  post.mockRejectedValue(httpError(404, {}));
  renderApp("/dev-user");
  expect(await screen.findByText("Dev sign-in failed")).toBeInTheDocument();
  expect(localStorage.length).toBe(0);
});
