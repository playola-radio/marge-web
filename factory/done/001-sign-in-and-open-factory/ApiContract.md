# 001 — API contract

Sign-in copies the Playola web client's flow (`~/playola/playola` @ `5a2d86006`:
`client/src/Pages/LoginPage/LoginPage.tsx`, `client/src/redux/slices/authSlice/authSlice.ts`,
`server/src/api/auth/ENDPOINTS.md` → `POST /google/signin`):

1. The client opens Google's consent popup with `@react-oauth/google`'s `useGoogleLogin({ flow: "auth-code" })`,
   scopes `openid email profile`, triggered by our own button.
2. The client posts the returned `code` to the server.
3. The server exchanges it with Google (redirect URI `postmessage`), checks the verified email against the allowlist,
   and returns a signed token.
4. The client stores the token and the decoded user in `localStorage` (`token`, `user`) and sends
   `Authorization: Bearer <token>` on later API calls. Sign-out removes both keys; there is no sign-out endpoint.

Nothing in this slice calls the server after sign-in: the title and factory pages read the signed-in user from the
stored token.

## POST /v1/auth/google/signin

**Repo:** `marge-web` (`server/`). **Status:** new. No auth. Rate-limited like `/session`.

Request:

```json
{ "code": "4/0AeanS0Z…" }
```

Response `200`:

```json
{ "margeToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…" }
```

Token: HS256 JWT signed with the existing `JWT_SECRET`, `expiresIn: "30d"`, payload:

```json
{
  "email": "brian@playola.fm",
  "name": "Brian Keane",
  "iat": 1795289600,
  "exp": 1797881600
}
```

The existing `requireAuth` middleware (`server/src/middleware/auth.ts`) already verifies this token unchanged.

Errors (same `{ "error": "<code>" }` envelope as the relay):

| Status | Body                             | When                                                                    | Client shows             |
| ------ | -------------------------------- | ----------------------------------------------------------------------- | ------------------------ |
| 400    | `{ "error": "invalid_request" }` | `code` missing or not a string                                          | Landing — Sign-in failed |
| 401    | `{ "error": "sign_in_failed" }`  | Google rejected the code, or the Google account's email is not verified | Landing — Sign-in failed |
| 403    | `{ "error": "not_approved" }`    | Verified email is not in `MARGE_ALLOWED_EMAILS` (case-insensitive)      | Landing — Not approved   |
| 500    | `{ "error": "internal_error" }`  | Anything else (existing `errorHandler`)                                 | Landing — Sign-in failed |

Server-side call to Google (external, unchanged by us):

```
POST https://oauth2.googleapis.com/token
grant_type=authorization_code&code=<code>&client_id=<GOOGLE_SIGNIN_CLIENT_ID>
&client_secret=<GOOGLE_SIGNIN_CLIENT_SECRET>&redirect_uri=postmessage
```

The response's `id_token` (received directly from Google over TLS) supplies `email`, `email_verified` and `name`.

## POST /v1/auth/dev-login

**Repo:** `marge-web` (`server/`). **Status:** new. **Development and test only:** the route is mounted only when
`NODE_ENV` is exactly `development` or `test`. It does not exist anywhere else, including when `NODE_ENV` is unset,
so production answers 404. No auth, no request body. Same sign-in rate limit as `/v1/auth/google/signin`. Copied
from Playola's `POST /v1/auth/dev-login` (`server/src/api/routes.ts`).

Response `200`, a token shaped exactly like a real sign-in's (HS256, `JWT_SECRET`, `expiresIn: "30d"`):

```json
{ "margeToken": "eyJ…" }
```

Payload `{ "email": "dev@marge.local", "name": "Dev User", "iat": …, "exp": … }`. It skips Google and the
allowlist. `500 { "error": "internal_error" }` if `JWT_SECRET` is unset.

The client's `/dev-user` page calls it (Design.md decision 14).

## CORS

The client (`https://marge.playola.fm`, `http://localhost:5173` in dev) and the server
(`https://api.marge.playola.fm`) are different origins. `/v1` routes answer CORS for the origins in a new
`CLIENT_ORIGINS` env var (comma-separated). No credentials mode: the token travels in the `Authorization` header.
The relay's root routes (`/session`, `/authorize`, `/callback`, `/result`, `/healthz`) are unchanged.

## Configuration

| Where                                                    | Name                                                                                                         | Value                                                                                                                  |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| server (Render `production` group, `sync: false`)        | `GOOGLE_SIGNIN_CLIENT_ID`                                                                                    | new Google OAuth **web** client, JS origins `https://marge.playola.fm` and `http://localhost:5173`                     |
| server (Render `production` group, `sync: false`)        | `GOOGLE_SIGNIN_CLIENT_SECRET`                                                                                | that client's secret                                                                                                   |
| server (Render `production` group, `sync: false`)        | `MARGE_ALLOWED_EMAILS`                                                                                       | comma-separated emails                                                                                                 |
| server (`render.yaml`)                                   | `CLIENT_ORIGINS`                                                                                             | `https://marge.playola.fm`                                                                                             |
| local only (`docker-compose.yaml`, `.env.example` files) | `NODE_ENV=development`, `CLIENT_ORIGINS=http://localhost:5173`, `VITE_SERVER_BASE_URL=http://localhost:3000` | enables dev sign-in; no Google secrets needed locally                                                                  |
| client (`netlify.toml`)                                  | `VITE_GOOGLE_CLIENT_ID`                                                                                      | `360017545997-fi7r67lac1bvanjukfd77lrb27q18tet.apps.googleusercontent.com` (same as `GOOGLE_SIGNIN_CLIENT_ID`; public) |

The Google client lives in its own Google Cloud project, "Marge Web" (decision 11). It is separate from the relay's flow: the relay still never holds a client secret.

## Not called

`GET /v1/me` (existing, unchanged) is not used by this slice.
