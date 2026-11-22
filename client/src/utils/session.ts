import { jwtDecode } from "jwt-decode";

export type SessionUser = { email: string; name: string; exp: number };

const TOKEN_KEY = "token";
const USER_KEY = "user";

export function saveSession(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(jwtDecode(token)));
}

export function readSession(): SessionUser | null {
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) {
    clearSession();
    return null;
  }
  try {
    const { email, name, exp } = jwtDecode<SessionUser>(token);
    if (typeof exp !== "number" || exp * 1000 <= Date.now()) {
      clearSession();
      return null;
    }
    return { email, name, exp };
  } catch {
    clearSession();
    return null;
  }
}

export function clearSession(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}
