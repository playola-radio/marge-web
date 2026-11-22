import { useState } from "react";
import { GoogleOAuthProvider } from "@react-oauth/google";
import App from "./App";

export default function GoogleSignInBoundary() {
  const [scriptLoadFailed, setScriptLoadFailed] = useState(false);

  return (
    <GoogleOAuthProvider
      clientId={import.meta.env.VITE_GOOGLE_CLIENT_ID ?? ""}
      onScriptLoadError={() => setScriptLoadFailed(true)}
    >
      <App scriptLoadFailed={scriptLoadFailed} />
    </GoogleOAuthProvider>
  );
}
