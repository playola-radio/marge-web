import axios from "axios";
import { saveSession } from "../utils/session";

export type SignInResult = "ok" | "failed" | "not_approved";

const serverBaseUrl = import.meta.env.VITE_SERVER_BASE_URL;

export async function signIn(code: string): Promise<SignInResult> {
  try {
    const { data } = await axios.post<{ margeToken: string }>(
      `${serverBaseUrl}/v1/auth/google/signin`,
      { code },
    );
    saveSession(data.margeToken);
    return "ok";
  } catch (error) {
    if (
      axios.isAxiosError(error) &&
      error.response?.status === 403 &&
      error.response.data?.error === "not_approved"
    ) {
      return "not_approved";
    }
    return "failed";
  }
}

/** `as` picks another dev account (e.g. "second"), for two-user demos. */
export async function devSignIn(as?: string): Promise<void> {
  const query = as ? `?as=${encodeURIComponent(as)}` : "";
  const { data } = await axios.post<{ margeToken: string }>(
    `${serverBaseUrl}/v1/auth/dev-login${query}`,
  );
  saveSession(data.margeToken);
}
