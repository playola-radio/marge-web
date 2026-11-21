import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useSearchParams } from 'react-router-dom';
import { readSession } from './auth/session';
import { safeRedirectTo } from './auth/redirectTo';
import RequireSignIn from './auth/RequireSignIn';
import LandingPage from './pages/LandingPage';
import TitlePage from './pages/TitlePage';
import FactoryPage from './pages/FactoryPage';

function devUserRoute() {
  if (!import.meta.env.DEV) return null;
  const DevUserPage = lazy(() => import('./pages/DevUserPage'));
  return (
    <Route
      path="/dev-user"
      element={
        <Suspense fallback={null}>
          <DevUserPage />
        </Suspense>
      }
    />
  );
}

const devUser = devUserRoute();

function Home({ scriptLoadFailed }: { scriptLoadFailed: boolean }) {
  const [searchParams] = useSearchParams();
  if (readSession()) {
    return <Navigate to={safeRedirectTo(searchParams.get('redirectTo'))} replace />;
  }
  return <LandingPage scriptLoadFailed={scriptLoadFailed} />;
}

export default function App({ scriptLoadFailed }: { scriptLoadFailed: boolean }) {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home scriptLoadFailed={scriptLoadFailed} />} />
        <Route
          path="/home"
          element={
            <RequireSignIn>
              <TitlePage />
            </RequireSignIn>
          }
        />
        <Route
          path="/factory"
          element={
            <RequireSignIn>
              <FactoryPage />
            </RequireSignIn>
          }
        />
        {devUser}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
