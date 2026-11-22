import { screen } from "@testing-library/react";
import { saveSession } from "./utils/session";
import { renderApp } from "./test/renderApp";
import { expiredToken, makeToken } from "./test/tokens";

vi.mock("@react-oauth/google", () => import("./test/googleOAuthMock"));

beforeEach(() => localStorage.clear());

const landingShown = () =>
  screen.getByRole("button", { name: /sign in with google/i });
const titleShown = () =>
  screen.getByRole("link", { name: /software factory/i });

test("/ signed out shows the landing page", () => {
  renderApp("/");
  expect(landingShown()).toBeInTheDocument();
});

test("/ signed in redirects to the title screen", () => {
  saveSession(makeToken());
  renderApp("/");
  expect(window.location.pathname).toBe("/home");
  expect(titleShown()).toBeInTheDocument();
});

test("/home signed out shows the landing page with redirectTo in the address", () => {
  renderApp("/home");
  expect(landingShown()).toBeInTheDocument();
  expect(window.location.pathname).toBe("/");
  expect(window.location.search).toBe("?redirectTo=%2Fhome");
});

test("/factory signed in shows the not-built-yet panel", () => {
  saveSession(makeToken());
  renderApp("/factory");
  expect(screen.getByText("Control panel not built yet")).toBeInTheDocument();
});

test("an expired stored token on /home shows the landing page", () => {
  localStorage.setItem("token", expiredToken());
  renderApp("/home");
  expect(landingShown()).toBeInTheDocument();
});

test("an unknown path shows the landing page when signed out", () => {
  renderApp("/nowhere");
  expect(window.location.pathname).toBe("/");
  expect(landingShown()).toBeInTheDocument();
});

test("an unknown path shows the title screen when signed in", () => {
  saveSession(makeToken());
  renderApp("/nowhere");
  expect(window.location.pathname).toBe("/home");
  expect(titleShown()).toBeInTheDocument();
});

test("/?redirectTo=/ signed in shows the title screen", () => {
  saveSession(makeToken());
  renderApp("/?redirectTo=%2F");
  expect(window.location.pathname).toBe("/home");
  expect(titleShown()).toBeInTheDocument();
});
