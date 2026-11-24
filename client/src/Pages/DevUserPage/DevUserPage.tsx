import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { devSignIn } from "../../Services/AuthService";

export default function DevUserPage() {
  const [failed, setFailed] = useState(false);
  const started = useRef(false);
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const as = params.get("as") ?? undefined;

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    devSignIn(as).then(
      () => navigate("/home", { replace: true }),
      () => setFailed(true),
    );
  }, [navigate, as]);

  return <p>{failed ? "Dev sign-in failed" : "Signing in as the dev user…"}</p>;
}
