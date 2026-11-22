import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useSearchParams } from 'react-router-dom';
import { readSession } from './utils/session';
import { safeRedirectTo } from './utils/redirectTo';
import ProtectedRoute from './Routes/ProtectedRoute';
import LandingPage from './Pages/LandingPage/LandingPage';
import TitlePage from './Pages/TitlePage/TitlePage';
import FactoryPage from './Pages/FactoryPage/FactoryPage';

function devUserRoute() {
  if (!import.meta.env.DEV) return null;
  const DevUserPage = lazy(() => import('./Pages/DevUserPage/DevUserPage'));
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
            <ProtectedRoute>
              <TitlePage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/factory"
          element={
            <ProtectedRoute>
              <FactoryPage />
            </ProtectedRoute>
          }
        />
        {devUser}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
