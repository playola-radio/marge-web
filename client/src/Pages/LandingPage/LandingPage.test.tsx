import { act, fireEvent, render, screen } from "@testing-library/react";

import { signIn } from "../../Services/AuthService";
import { saveSession } from "../../utils/session";
import GoogleSignInBoundary from "../../GoogleSignInBoundary";
import { google } from "../../test/googleOAuthMock";
import { renderApp } from "../../test/renderApp";
import { makeToken } from "../../test/tokens";

vi.mock("@react-oauth/google", () => import("../../test/googleOAuthMock"));
vi.mock("../../Services/AuthService", () => ({
  signIn: vi.fn(),
  devSignIn: vi.fn(),
}));
vi.mock("../../Services/FactoryService", () => ({
  fetchFactorySnapshot: vi.fn().mockResolvedValue({
    catalog: null,
    snapshot: null,
    receivedAt: null,
    serverNow: "2026-11-21T18:43:02.000Z",
  }),
}));

const mockedSignIn = vi.mocked(signIn);

beforeEach(() => {
  localStorage.clear();
  google.reset();
  mockedSignIn.mockReset();
});

const signInButton = () =>
  screen.getByRole("button", { name: /sign in with google/i });

test("shows the wordmark and the sign-in button, and no picture", () => {
  renderApp("/");
  expect(screen.getByRole("heading", { name: "marge" })).toBeInTheDocument();
  expect(signInButton()).toBeEnabled();
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
});

test('clicking shows "Signing in…" and a disabled button', async () => {
  renderApp("/");
  fireEvent.click(signInButton());
  expect(google.login).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: /signing in…/i })).toBeDisabled();
});

async function finishGoogleSignIn(result: Awaited<ReturnType<typeof signIn>>) {
  mockedSignIn.mockImplementation(async () => {
    if (result === "ok") saveSession(makeToken());
    return result;
  });
  fireEvent.click(signInButton());
  await act(async () => {
    await google.options!.onSuccess({ code: "google-code" });
  });
}

test("a successful code exchange navigates to /home", async () => {
  renderApp("/");
  await finishGoogleSignIn("ok");
  expect(mockedSignIn).toHaveBeenCalledWith("google-code");
  expect(window.location.pathname).toBe("/home");
  expect(screen.getByText("brian@playola.fm")).toBeInTheDocument();
});

test("with ?redirectTo=/factory it navigates to /factory", async () => {
  renderApp("/?redirectTo=%2Ffactory");
  await finishGoogleSignIn("ok");
  expect(window.location.pathname).toBe("/factory");
  expect(await screen.findByText("Not connected yet")).toBeInTheDocument();
});

test("not_approved shows the not-approved banner and re-enables the button", async () => {
  renderApp("/");
  await finishGoogleSignIn("not_approved");
  expect(screen.getByRole("alert")).toHaveTextContent(
    "This Google account isn't approved for marge. Sign in with an approved account.",
  );
  expect(signInButton()).toBeEnabled();
  expect(window.location.pathname).toBe("/");
});

test("a failed code exchange shows the sign-in-failed banner", async () => {
  renderApp("/");
  await finishGoogleSignIn("failed");
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Sign-in didn't finish. Try again.",
  );
  expect(signInButton()).toBeEnabled();
});

test("closing the popup shows the sign-in-failed banner and re-enables the button", async () => {
  renderApp("/");
  fireEvent.click(signInButton());
  act(() => google.options!.onNonOAuthError!({ type: "popup_closed" }));
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Sign-in didn't finish. Try again.",
  );
  expect(signInButton()).toBeEnabled();
});

test("while the Google script loads the button is disabled; once loaded it starts sign-in", async () => {
  window.history.pushState({}, "", "/");
  render(<GoogleSignInBoundary />);
  expect(signInButton()).toBeDisabled();
  fireEvent.click(signInButton());
  expect(google.login).not.toHaveBeenCalled();
  expect(screen.queryByText("Signing in…")).not.toBeInTheDocument();

  act(() => google.loadScript());
  fireEvent.click(signInButton());
  expect(google.login).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: /signing in…/i })).toBeDisabled();
});

test("a Google script load failure shows the failed banner and leaves the button disabled", () => {
  window.history.pushState({}, "", "/");
  render(<GoogleSignInBoundary />);
  act(() => google.failScript());
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Sign-in didn't finish. Try again.",
  );
  expect(signInButton()).toBeDisabled();
});
