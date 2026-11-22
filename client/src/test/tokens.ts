function base64Url(value: object): string {
  return btoa(JSON.stringify(value))
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

export function makeToken(
  claims: { email?: string; name?: string; exp?: number } = {},
): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    email: "brian@playola.fm",
    name: "Brian Keane",
    iat: now,
    exp: now + 30 * 24 * 60 * 60,
    ...claims,
  };
  return `${base64Url({ alg: "HS256", typ: "JWT" })}.${base64Url(payload)}.signature`;
}

export function expiredToken(): string {
  return makeToken({ exp: Math.floor(Date.now() / 1000) - 60 });
}
