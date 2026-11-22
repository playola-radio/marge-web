import jwt from "jsonwebtoken";

export type GoogleIdentity = {
  email: string;
  emailVerified: boolean;
  name: string;
};

export type ExchangeGoogleCode = (
  code: string,
  client: { clientId: string; clientSecret: string },
) => Promise<GoogleIdentity>;

export class GoogleSignInRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleSignInRejected";
  }
}

const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

export const exchangeGoogleCode: ExchangeGoogleCode = async (code, client) => {
  const res = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: client.clientId,
      client_secret: client.clientSecret,
      redirect_uri: "postmessage",
    }).toString(),
  });
  if (res.status >= 400 && res.status < 500) {
    throw new GoogleSignInRejected(
      `google token exchange rejected (${res.status})`,
    );
  }
  if (!res.ok) throw new Error(`google token exchange failed (${res.status})`);

  const body = (await res.json()) as { id_token?: string };
  // The id_token comes straight from Google over TLS, so it is decoded, not re-verified.
  const decoded = body.id_token ? jwt.decode(body.id_token) : null;
  const claims = decoded && typeof decoded === "object" ? decoded : {};
  const { email, email_verified: emailVerified, name } = claims;
  if (typeof email !== "string" || email.length === 0) {
    throw new GoogleSignInRejected("google id_token has no email");
  }
  return {
    email,
    emailVerified: emailVerified === true,
    name: typeof name === "string" && name.length > 0 ? name : email,
  };
};
