# 001-sign-in-and-open-factory — Implementation plan

The design files beside this plan are the truth; this plan only says how to build them.

Base branch: `main` (this repo has no `develop`). Two PRs, built in order. PR 1 adds the sign-in endpoint to the
existing Express server (`server/`). PR 2 replaces the placeholder `Dashboard` page in the Vite client (`client/`)
with the landing, title and factory pages, copying Playola's web sign-in flow (ApiContract.md). The Google OAuth web
client and every production setting in ApiContract.md → Configuration were created during design (Design.md
decision 13), so neither PR touches Google Cloud, Render's dashboard or Netlify's dashboard. Decisions made while
planning:

- The Google code exchange is one small module using Node's built-in `fetch` (Playola uses axios for the same
  call). It is passed into `buildApp` through `AppDeps`, so tests stub it and never reach Google.
- The `id_token` comes straight from Google's token endpoint over TLS, so it is read with `jwt.decode` and not
  re-verified (Playola does the same).
- Missing sign-in settings (`GOOGLE_SIGNIN_CLIENT_ID`, `GOOGLE_SIGNIN_CLIENT_SECRET`, `JWT_SECRET`) do not stop the
  server booting, because the relay must keep working without them. The endpoint answers `500 internal_error`
  instead. An empty or missing `MARGE_ALLOWED_EMAILS` means everyone gets `403 not_approved`.
- CORS uses the `cors` package, mounted on `/v1` only.
- The client keeps Playola's two `localStorage` keys, `token` and `user`. No API call in this slice needs the token,
  so no axios Bearer interceptor is added yet. Design 002 adds it with its first authenticated call.
- Styling is one plain CSS file using the canvas's colours and fonts (Bricolage Grotesque and Inter from Google
  Fonts). There is no CSS framework, because the client has none today.

| PR  | Title                                                                       | Depends on | Hard |
| --- | --------------------------------------------------------------------------- | ---------- | ---- |
| 1   | feature: let approved Google accounts sign in to marge's server             | —          | no   |
| 2   | feature: add the marge landing page, sign-in, title screen and factory page | 1          | no   |

## PR 1 — feature: let approved Google accounts sign in to marge's server

Once merged, the server at `api.marge.playola.fm` accepts a Google sign-in code from the marge website. It answers
with a 30-day marge token for allowlisted emails and a clear refusal for everyone else. Nothing a user sees changes
yet.

**Changes**

- `server/package.json`: add dependency `cors` and dev dependency `@types/cors`; run `npm install` in `server/` so
- `server/package-lock.json` updates.
- `server/src/config.ts`: add four fields to `Config`, all read in `loadConfig` without throwing when absent:
- - `googleSignIn: { clientId: string; clientSecret: string } | null` — set only when both
- `GOOGLE_SIGNIN_CLIENT_ID` and `GOOGLE_SIGNIN_CLIENT_SECRET` are present.
- - `allowedEmails: string[]` — from `MARGE_ALLOWED_EMAILS`, split on commas, trimmed, lower-cased, empties dropped.
- - `clientOrigins: string[]` — from `CLIENT_ORIGINS`, split on commas, trimmed, empties dropped.
- - `devLogin: boolean` — true only when `NODE_ENV` is exactly `development` or `test` (case-sensitive; unset is
- false).
- New `server/src/lib/googleSignIn.ts`:
- - Exports `type GoogleIdentity = { email: string; emailVerified: boolean; name: string }`.
- - Exports `type ExchangeGoogleCode = (code: string, client: { clientId: string; clientSecret: string }) => Promise<GoogleIdentity>`.
- - Exports `class GoogleSignInRejected extends Error`.
- - Exports `exchangeGoogleCode: ExchangeGoogleCode`. It `fetch`es `POST https://oauth2.googleapis.com/token` with
- the form body in ApiContract.md (`redirect_uri=postmessage`).
- - A 4xx answer from Google throws `GoogleSignInRejected`. Any other non-OK answer throws a plain `Error`.
- - It reads `email`, `email_verified` and `name` from `jwt.decode(body.id_token)`. A missing `email` throws
- `GoogleSignInRejected`. `name` falls back to `email`.
- `server/src/app.ts`:
- - Add optional `exchangeGoogleCode?: ExchangeGoogleCode` to `AppDeps`, defaulting to the real one.
- - Create a second limiter, `signInLimiter`, with the same `windowMs` and `max` (and the same options) as
- `limiter`. It is a separate instance, so sign-in and the relay never share a per-IP count. The relay's
- `limiter` stays exactly as it is.
- - Add `app.use('/v1', cors({ origin: deps.config.clientOrigins }))`, then `app.use('/v1/auth', signInLimiter)`,
- both before the `/v1` router. CORS comes first, so preflights end before the limiter and a 429 still carries the
- CORS header.
- - Leave every relay route unchanged.
- New `server/src/v1/auth.ts`: `v1AuthRouter(deps)` with `POST /auth/google/signin`, exactly as in ApiContract.md:
- 1. `code` missing or not a non-empty string → `400 { error: 'invalid_request' }`.
- 2. `deps.config.googleSignIn` null, or `process.env.JWT_SECRET` unset → `next(new Error(...))`, which gives 500.
- 3. `GoogleSignInRejected`, or `emailVerified` false → `401 { error: 'sign_in_failed' }`.
- 4. Lower-cased email not in `allowedEmails` → `403 { error: 'not_approved' }`.
- 5. Otherwise `200 { margeToken: jwt.sign({ email, name }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '30d' }) }`.
- 6. Any other thrown error → `next(err)`.
- The same router registers `POST /auth/dev-login` (ApiContract.md) only when `deps.config.devLogin` is true, so
- the route does not exist otherwise and the request falls through to 404. It takes no body. If
- `process.env.JWT_SECRET` is unset it calls `next(new Error(...))`; otherwise it returns
- `200 { margeToken: jwt.sign({ email: 'dev@marge.local', name: 'Dev User' }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '30d' }) }`.
- It sits under `/v1/auth`, so `signInLimiter` and CORS already cover it.
- `server/src/v1/index.ts`: mount `v1AuthRouter(deps)`; the `_deps` parameter becomes `deps`.
- `render.yaml`: add `CLIENT_ORIGINS` = `https://marge.playola.fm` to the `marge-api` service's `envVars`. Add
- `GOOGLE_SIGNIN_CLIENT_ID`, `GOOGLE_SIGNIN_CLIENT_SECRET` and `MARGE_ALLOWED_EMAILS` to the `production` env group
- as `sync: false`. Their values already exist in Render; this only declares them.
- `server/.env.example`: document `GOOGLE_SIGNIN_CLIENT_ID`, `GOOGLE_SIGNIN_CLIENT_SECRET`, `MARGE_ALLOWED_EMAILS`
- and `CLIENT_ORIGINS` (`http://localhost:5173` locally), in the file's existing comment style. Add
- `NODE_ENV=development` with a one-line comment that it turns on dev sign-in (`/dev-user`) and must never be set
- on Render.
- `docker-compose.yaml` `server` service: add `NODE_ENV: development` and `CLIENT_ORIGINS: http://localhost:5173`
- to its `environment`. Leave the `migrate` service as it is.

**Tests**

- New `server/test/signin.test.ts` (mocha + supertest, built like `server/test/v1.test.ts`, with a stub
- `exchangeGoogleCode` passed through `buildApp`):
- - An allowlisted, verified email returns 200 with a `margeToken`. The token verifies with `JWT_SECRET` (HS256),
- carries that `email` and `name`, and has `exp - iat` equal to 30 days.
- - The allowlist match ignores case (`Brian@Playola.FM` matches `brian@playola.fm`).
- - The returned token is accepted by `GET /v1/me`.
- - A missing `code` returns 400 `invalid_request`, and so does a non-string `code`.
- - The stub throwing `GoogleSignInRejected` returns 401 `sign_in_failed`.
- - `emailVerified: false` returns 401 `sign_in_failed`.
- - A verified email not on the list returns 403 `not_approved`.
- - An empty `MARGE_ALLOWED_EMAILS` returns 403 `not_approved`.
- - Missing Google sign-in settings return 500 `internal_error`.
- - The stub throwing a plain `Error` returns 500 `internal_error`.
- - `OPTIONS /v1/auth/google/signin` from an origin in `CLIENT_ORIGINS` answers with
- `Access-Control-Allow-Origin` set to that origin.
- - The same preflight from an unlisted origin has no `Access-Control-Allow-Origin`.
- - A relay route (`GET /healthz`) sends no CORS header.
- - With `rateLimit: { windowMs: 60_000, max: 1 }`, a second POST from an allowed origin gets 429 and still carries
- `Access-Control-Allow-Origin`. Preflight `OPTIONS` requests do not count toward that limit.
- - With `max: 1`, using up the sign-in limit leaves `POST /session` able to answer (not 429), and the reverse
- also holds.
- `server/test/config.test.ts`:
- - `MARGE_ALLOWED_EMAILS=" A@x.com, ,b@y.com "` gives `['a@x.com','b@y.com']`.
- - `CLIENT_ORIGINS` is parsed the same way.
- - `googleSignIn` is null unless both Google settings are set.
- - `devLogin` is true for `NODE_ENV=development` and `NODE_ENV=test`, and false for `production`, unset and
- `Development`.
- - The existing required-variable tests still pass.
- New `server/test/googleSignIn.test.ts`, with `globalThis.fetch` stubbed:
- - Posts the exact form body to Google, including `redirect_uri=postmessage`.
- - Maps the `id_token` claims to `GoogleIdentity`.
- - A 400 from Google throws `GoogleSignInRejected`.
- - A 500 from Google throws a plain `Error`.
- New `server/test/devLogin.test.ts` (built like `signin.test.ts`, setting `NODE_ENV` before `loadConfig` and
- restoring it after):
- - In `development`, `POST /v1/auth/dev-login` returns 200 with a `margeToken` that verifies with `JWT_SECRET`
- (HS256), carries `dev@marge.local` and `Dev User`, and has `exp - iat` equal to 30 days.
- - That token is accepted by `GET /v1/me`.
- - With `NODE_ENV=production`, and with `NODE_ENV` unset, it returns 404.
- - In `development` with `JWT_SECRET` unset, it returns 500 `internal_error`.
- The full existing `server/` suite (`make test-server`) and `make lint-server` pass unchanged.

**Screenshots it must match**

- none

**"Done when" items it delivers**

- none

## PR 2 — feature: add the marge landing page, sign-in, title screen and factory page

Once merged, `marge.playola.fm` shows the landing page. An approved Google account can sign in, land on the title
screen with Marge's picture, open the empty Software Factory page, and sign out, on desktop and phone.

**Changes**

- `client/package.json`: add dependencies `@react-oauth/google` and `jwt-decode` (Playola's versions:
- `^0.12.1`, `^4.0.0`); run `npm install` in `client/` so `client/package-lock.json` updates.
- `client/tsconfig.app.json`: add `"vite/client"` to `compilerOptions.types` (the explicit list currently holds only
- the Vitest and jest-dom types), so `import.meta.env` and the JPEG import type-check in `npm run build`.
- `client/index.html`: load Bricolage Grotesque (weights 600–800, which includes the 800 the wordmarks use) and Inter (400–700) from
- Google Fonts with
- `preconnect`, and set `<meta name="theme-color" content="#14213D">`.
- New `client/src/assets/marge-face.jpeg`: a byte-for-byte copy of `design/marge-face.jpeg`. Never redraw or
- regenerate it.
- New `client/src/styles.css`, imported once in `main.tsx`:
- - The canvas colours as CSS custom properties: `--ink #14213D`, `--ink-soft #3D4A66`, `--sun #FFD43B`,
- `--cream #FFF8E7`, `--sky #8FC3E6`, `--sky-deep #5E9FD0`, `--danger #B42318`.
- - The two font families, at the exact weights each text layer has in `design/marge.pen`.
- - The desktop layouts and one phone breakpoint at `max-width: 768px`.
- - Each screen matches its screenshots at 1440×900 and 390×844, with no sideways scrolling.
- New `client/src/auth/session.ts`, Playola's `localStorage` scheme:
- - Exports `type SessionUser = { email: string; name: string; exp: number }`.
- - `saveSession(token: string)` stores `token` and `JSON.stringify(jwtDecode(token))` under `user`.
- - `readSession(): SessionUser | null` derives email, name and exp by `jwtDecode`-ing the stored `token`; the
- `user` key is written for parity with Playola but never read, so the token is the one source of truth. It
- returns null and removes both keys when `token` is missing or undecodable, or `exp * 1000 <= Date.now()`.
- - `clearSession()` removes both keys.
- New `client/src/auth/signIn.ts`: `signIn(code: string): Promise<'ok' | 'failed' | 'not_approved'>`.
- - It `axios.post`s `{ code }` to `${import.meta.env.VITE_SERVER_BASE_URL}/v1/auth/google/signin`.
- - On 200 it calls `saveSession(margeToken)` and returns `'ok'`.
- - A 403 with `error: 'not_approved'` returns `'not_approved'`.
- - Anything else (other statuses, network failure) returns `'failed'`.
- - It also exports `devSignIn(): Promise<void>`, which `axios.post`s to
- `${import.meta.env.VITE_SERVER_BASE_URL}/v1/auth/dev-login` and calls `saveSession(margeToken)`. Any failure
- rejects.
- New `client/src/pages/DevUserPage.tsx` (Design.md decision 14; not drawn):
- - On mount it calls `devSignIn()` once, then `navigate('/home', { replace: true })`.
- - While waiting it shows the plain text "Signing in as the dev user…"; on failure it shows "Dev sign-in failed".
- New `client/src/auth/redirectTo.ts`: `safeRedirectTo(value: string | null): string`. It returns `value` only when
- it starts with `/`, contains no backslash, does not start with `//`, and its path (the part before any `?` or `#`) is not `/`; otherwise
- it returns `/home`. This keeps sign-in from landing back on the landing page.
- New `client/src/auth/RequireSignIn.tsx`: renders its children when `readSession()` is non-null. Otherwise it
- `<Navigate>`s to `/?redirectTo=<encoded current path>` with `replace`.
- `client/src/main.tsx`: add a small `GoogleSignInBoundary` that wraps `<App />` in
- `<GoogleOAuthProvider clientId={import.meta.env.VITE_GOOGLE_CLIENT_ID}>`. Its `onScriptLoadError` stores one
- `scriptLoadFailed` boolean and passes it into `App`; retrying is a browser-page reload, with no retry loop or
- provider remount.
- `client/src/App.tsx`: three routes, plus one in development builds.
- - `/` → `LandingPage`, with the Google-script-load-failed boolean from `main.tsx`. When
- `readSession()` is non-null, `<Navigate>` to `safeRedirectTo(redirectTo)` instead.
- - `/home` → `<RequireSignIn><TitlePage/></RequireSignIn>`.
- - `/factory` → `<RequireSignIn><FactoryPage/></RequireSignIn>`.
- - `/dev-user` → `DevUserPage`, registered only inside an `import.meta.env.DEV` check, with the page loaded by
- `React.lazy(() => import('./pages/DevUserPage'))` inside that same check (and a `Suspense` around it), so
- `vite build` drops it and its `dev-login` call from the production bundle.
- - Any other path → `<Navigate to="/" replace>`.
- Delete `client/src/pages/Dashboard.tsx`.
- New `client/src/pages/LandingView.tsx`: the landing page's markup only. Props:
- `{ status: 'idle' | 'signing-in' | 'failed' | 'not-approved'; disabled: boolean; onSignIn: () => void }`.
- No hooks besides rendering.
- New `client/src/pages/LandingPage.tsx`, matching the four landing screenshots. It owns the state and the Google
- hook, and renders `LandingView`:
- - Layout (in `LandingView`): the brand line top-left, the centred wordmark "marge", the one-line description, the yellow
- "Sign in with Google" button, and the access note at the bottom. No image.
- - It reads `scriptLoadedSuccessfully` with `useGoogleOAuth()` and calls
- `useGoogleLogin({ flow: 'auth-code', scope: 'openid email profile', onSuccess, onError, onNonOAuthError })`.
- - A `scriptLoadFailed` prop makes its displayed status `failed`, so the existing sign-in-failed banner is shown.
- - It keeps the normal sign-in label and disables the button until `useGoogleOAuth().scriptLoadedSuccessfully` is
- true. Clicking it then sets `signing-in`: a
- spinner, "Signing in…", and the button `disabled`.
- - `onSuccess` awaits `signIn(code)`. `'ok'` navigates to `safeRedirectTo(searchParams.get('redirectTo'))`.
- `'not_approved'` and `'failed'` set the matching banner state.
- - `onError` and `onNonOAuthError` (popup closed or blocked) set `failed`.
- - Banner copy is exactly as in Design.md. The banner sits above the button with `role="alert"`. `onScriptLoadError`
- sets the failed banner; its button stays disabled, and reloading the page retries the script. Other banner states
- re-enable the button.
- New `client/src/pages/TitlePage.tsx`, matching the title screenshots:
- - A navy panel with the brand line, the wordmark and the menu.
- - The menu has one item: "Software Factory" / "Designs, builds and pull requests", a `<Link to="/factory">`.
- - Below the menu: the signed-in email from `readSession()` and a "Sign out" button. Sign out runs
- `clearSession()` and then `navigate('/')`.
- - The `marge-face.jpeg` image (`alt="Marge"`, `object-fit: cover`) sits beside the panel on desktop and above it
- on phone.
- New `client/src/pages/FactoryPage.tsx`, matching the factory screenshots:
- - Header bar (bottom border):
- - Left: a "←" `<Link to="/home">` with the "marge" wordmark.
- - On desktop the left side continues with a "/" separator and "Software Factory" in `--sky` as a breadcrumb.
- - Right: on desktop the signed-in email from `readSession()` then "Sign out"; on phone only "Sign out". Sign out
- behaves as on the title page.
- - Body: an `<h1>` "Software Factory" in Bricolage Grotesque at both sizes. Below it, a bordered, rounded panel
- filling the rest of the page, holding a centred yellow factory icon tile, "Control panel not built yet" and
- "Designs, builds and pull requests will show here. Until then, use the factory command line."
- New dev-only preview harness for the browser check, outside the production build:
- - `client/preview.html`: a copy of `index.html` whose script is `/src/preview.tsx`.
- - `client/src/preview.tsx`: renders `<LandingView status={…} disabled={status === 'signing-in'} onSignIn={() => {}} />`,
- with `status` read from `?status=` (default `idle`), and imports `styles.css`.
- - `vite build` only builds `index.html`, so neither file ships. The dev server serves them at
- `/preview.html?status=signing-in` and so on.
- `netlify.toml`: add `VITE_GOOGLE_CLIENT_ID` under `[build.environment]` with the client ID recorded in
- ApiContract.md → Configuration. It is public, so it lives in the file like `VITE_SERVER_BASE_URL`.
- New `client/.env.example`: `VITE_SERVER_BASE_URL=http://localhost:3000` and `VITE_GOOGLE_CLIENT_ID=` with a
- one-line comment saying the Google ID is only needed to test real Google sign-in locally; `/dev-user` works
- without it.
- `docker-compose.yaml` `client` service: add `VITE_SERVER_BASE_URL: http://localhost:3000` to its `environment`.

**Tests**

- Vitest + Testing Library. `@react-oauth/google` is mocked with `vi.mock`, so `useGoogleLogin` returns a function
- that records its callbacks and the test can fire them. `axios` is mocked with `vi.mock`. Each test resets
- `localStorage`.
- `client/src/auth/session.test.ts`:
- - `saveSession` followed by `readSession` returns the email, name and exp.
- - An expired `token` paired with an unexpired `user` value returns null and clears both keys.
- - A `user` value with a different email than the token: `readSession` returns the token's email.
- - An expired token makes `readSession` return null and clears both keys.
- - A valid token with garbage under `user` still returns the token's email, name and exp.
- - An undecodable `token` returns null and clears both keys.
- - `clearSession` removes both keys.
- `client/src/auth/redirectTo.test.ts`:
- - `/factory` is kept.
- - `/factory?x=1` is kept.
- - `//evil.com`, `/\\evil.com`, `https://evil.com`, `/`, `/?redirectTo=/home`, `null` and `''` all give `/home`.
- `client/src/auth/signIn.test.ts`:
- - 200 saves the session and returns `ok`.
- - 403 `not_approved` returns `not_approved`.
- - 401, 500 and a network error each return `failed`.
- - `devSignIn` posts to `/v1/auth/dev-login` and saves the returned session.
- `client/src/pages/DevUserPage.test.tsx`:
- - A successful dev sign-in shows the title screen with `dev@marge.local`.
- - A failed dev sign-in shows "Dev sign-in failed" and stores nothing.
- `client/src/pages/LandingPage.test.tsx`:
- - Shows "marge" and "Sign in with Google", and no `img`.
- - Clicking shows "Signing in…" and a disabled button.
- - A successful code exchange navigates to `/home`.
- - With `?redirectTo=/factory`, it navigates to `/factory`.
- - `not_approved` shows the not-approved banner and re-enables the button.
- - `onNonOAuthError` shows "Sign-in didn't finish. Try again." and re-enables the button.
- - While the mocked Google script is loading, the sign-in button is disabled and clicking it does not enter
- `signing-in`; after its success callback, the button starts login normally.
- - A mocked Google script load failure shows "Sign-in didn't finish. Try again." and leaves the button disabled.
- `client/src/App.test.tsx`, replacing the Dashboard test:
- - `/` signed out shows the landing page.
- - `/` signed in redirects to the title screen.
- - `/home` signed out shows the landing page and the address carries `redirectTo=%2Fhome`.
- - `/factory` signed in shows "Control panel not built yet".
- - An expired stored token on `/home` shows the landing page.
- - An unknown path shows the landing page when signed out, and the title screen when signed in.
- - `/?redirectTo=/` signed in shows the title screen.
- `client/src/pages/TitlePage.test.tsx`:
- - Shows the stored email and the `Marge` image.
- - The "Software Factory" link goes to `/factory`.
- - "Sign out" clears `localStorage` and shows the landing page.
- `client/src/pages/FactoryPage.test.tsx`:
- - Shows the "Software Factory" heading and the stored email.
- - "← marge" goes to `/home`.
- - "Sign out" clears `localStorage` and shows the landing page.
- `cd client && npm run lint && npm test && npm run build` pass. Then, still inside `client/`, `test -d dist` succeeds
- and `grep -r "dev-login" dist` exits with status 1 (no match); status 0 (found) or 2 (error) fails the check.
- Browser check before opening the PR, because jsdom can't see layout. Run the local server (`NODE_ENV=development`,
- any local `JWT_SECRET`) and `npm run dev`, and use the gstack `/browse` tool at 1440×900 and at 390×844. Open these:
- - Landing states: `/preview.html?status=idle`, `?status=signing-in`, `?status=failed` and
- `?status=not-approved`.
- - Title and factory: open `/dev-user`, which lands on `/home`, then open `/factory`.
- - Compare each against its screenshot.
- - Confirm `document.documentElement.scrollWidth <= innerWidth`.
- - Confirm every button and link is visible and tappable.
- - Attach the twelve captures to the PR.

**Screenshots it must match**

- `screenshots/landing--default-desktop.png`
- `screenshots/landing--default-mobile.png`
- `screenshots/landing--signing-in-desktop.png`
- `screenshots/landing--signing-in-mobile.png`
- `screenshots/landing--sign-in-failed-desktop.png`
- `screenshots/landing--sign-in-failed-mobile.png`
- `screenshots/landing--not-approved-desktop.png`
- `screenshots/landing--not-approved-mobile.png`
- `screenshots/title--default-desktop.png`
- `screenshots/title--default-mobile.png`
- `screenshots/factory--not-built-yet-desktop.png`
- `screenshots/factory--not-built-yet-mobile.png`

**"Done when" items it delivers**

- 1. 1. Opening `marge.playola.fm` signed out shows the landing page with the wordmark and "Sign in with Google", and no picture, on desktop and phone.
- 2. 2. Signing in with an approved Google account lands on the title screen with Marge's picture, the "Software Factory" menu item and the signed-in email.
- 3. 3. Signing in with a Google account not on the allowlist shows "This Google account isn't approved for marge." on the landing page and stays signed out.
- 4. 4. Closing the Google popup without finishing, or failing to load the Google sign-in script, shows "Sign-in didn't
- 5. 5. While sign-in is in progress the button shows a spinner and "Signing in…" and can't be tapped twice.
- 6. 6. Tapping "Software Factory" opens `/factory` showing "Control panel not built yet"; "← marge" returns to the title screen.
- 7. 7. "Sign out" on the title screen or the factory page returns to the landing page, and reloading stays signed out.
- 8. 8. Opening `/factory` signed out shows the landing page, and signing in returns to `/factory`.
- 9. 9. Reloading `/home` or `/factory` while signed in keeps you signed in.
- 10. 10. A stored token older than 30 days is treated as signed out.
- 11. 11. Every screen fits a 390-pixel-wide phone with no sideways scrolling and every button reachable with a thumb.
- 12. 12. On a local development machine, opening `/dev-user` signs in as `dev@marge.local` and shows the title screen; on `marge.playola.fm`, `/dev-user` signs no one in and is handled like any unknown address (landing page when signed out, title screen when signed in).

<!-- factory: finished plan for design 3dd46bd30f6272518e34180aa9cd7f828eb1f35e6413d7516ed6660640b91bd1, plan d69e901b6cecff5b9a795ca0e7feb6195737834ca11e3e998aeb82b2e021d3b9. Any edit to this file or the design undoes it; run "factory finalize" again. -->
