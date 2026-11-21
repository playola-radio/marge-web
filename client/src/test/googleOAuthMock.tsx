/* eslint-disable react-refresh/only-export-components -- mirrors @react-oauth/google, which exports hooks beside its provider */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

type LoginOptions = {
  onSuccess: (response: { code: string }) => void | Promise<void>;
  onError?: () => void;
  onNonOAuthError?: (error: { type: string }) => void;
};

// Test handle for the mocked @react-oauth/google module: it captures the options the page
// passes to useGoogleLogin so a test can fire Google's callbacks itself.
export const google = {
  login: vi.fn(),
  options: undefined as LoginOptions | undefined,
  loadScript: () => {},
  failScript: () => {},
  reset() {
    this.login = vi.fn();
    this.options = undefined;
  },
};

const ScriptContext = createContext({ scriptLoadedSuccessfully: true });

export function GoogleOAuthProvider({
  children,
  onScriptLoadError,
}: {
  clientId: string;
  onScriptLoadError?: () => void;
  children: ReactNode;
}) {
  const [scriptLoadedSuccessfully, setLoaded] = useState(false);

  useEffect(() => {
    google.loadScript = () => setLoaded(true);
    google.failScript = () => onScriptLoadError?.();
  }, [onScriptLoadError]);

  return (
    <ScriptContext.Provider value={{ scriptLoadedSuccessfully }}>{children}</ScriptContext.Provider>
  );
}

export function useGoogleOAuth() {
  return useContext(ScriptContext);
}

export function useGoogleLogin(options: LoginOptions) {
  google.options = options;
  return google.login;
}
