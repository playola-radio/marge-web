import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import axios from "axios";
import {
  fetchFactorySnapshot,
  type SnapshotResponse,
} from "../Services/FactoryService";
import { clearSession } from "../utils/session";

export type FactorySnapshotState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "loaded"; data: SnapshotResponse };

const POLL_MS = 30_000;

export function useFactorySnapshot(): {
  state: FactorySnapshotState;
  retry: () => void;
} {
  const [state, setState] = useState<FactorySnapshotState>({
    kind: "loading",
  });
  const navigate = useNavigate();
  const inFlight = useRef(false);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const data = await fetchFactorySnapshot();
      if (mounted.current) setState({ kind: "loaded", data });
    } catch (error) {
      if (!mounted.current) return;
      if (axios.isAxiosError(error) && error.response?.status === 401) {
        clearSession();
        navigate("/?redirectTo=%2Ffactory", { replace: true });
        return;
      }
      setState({ kind: "error" });
    } finally {
      inFlight.current = false;
    }
  }, [navigate]);

  useEffect(() => {
    mounted.current = true;
    let interval: ReturnType<typeof setInterval> | undefined;

    const startPolling = () => {
      clearInterval(interval);
      void load();
      interval = setInterval(() => void load(), POLL_MS);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        startPolling();
      } else {
        clearInterval(interval);
        interval = undefined;
      }
    };

    if (document.visibilityState === "visible") startPolling();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      mounted.current = false;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [load]);

  const retry = useCallback(() => void load(), [load]);

  return { state, retry };
}
