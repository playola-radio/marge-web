import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { readSession } from "../utils/session";

export default function ProtectedRoute({ children }: { children: ReactNode }) {
  const location = useLocation();
  if (readSession()) return children;
  const redirectTo = encodeURIComponent(location.pathname + location.search);
  return <Navigate to={`/?redirectTo=${redirectTo}`} replace />;
}
