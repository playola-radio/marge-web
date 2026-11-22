import { fireEvent, screen } from "@testing-library/react";
import { saveSession } from "../../utils/session";
import { renderApp } from "../../test/renderApp";
import { makeToken } from "../../test/tokens";

vi.mock("@react-oauth/google", () => import("../../test/googleOAuthMock"));

beforeEach(() => {
  localStorage.clear();
  saveSession(makeToken({ email: "brian@playola.fm" }));
  renderApp("/factory");
});

test("shows the Software Factory heading and the stored email", () => {
  expect(
    screen.getByRole("heading", { level: 1, name: "Software Factory" }),
  ).toBeInTheDocument();
  expect(screen.getByText("brian@playola.fm")).toBeInTheDocument();
});

test('"← marge" goes to /home', () => {
  fireEvent.click(screen.getByRole("link", { name: "marge" }));
  expect(window.location.pathname).toBe("/home");
  expect(screen.getByRole("img", { name: "Marge" })).toBeInTheDocument();
});

test("Sign out clears localStorage and shows the landing page", () => {
  fireEvent.click(screen.getByRole("button", { name: /sign out/i }));
  expect(localStorage.length).toBe(0);
  expect(window.location.pathname).toBe("/");
  expect(
    screen.getByRole("button", { name: /sign in with google/i }),
  ).toBeInTheDocument();
});
