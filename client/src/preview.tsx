import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import LandingView, { type LandingStatus } from './Pages/LandingPage/LandingView';
import './styles.css';

const status = (new URLSearchParams(window.location.search).get('status') ??
  'idle') as LandingStatus;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LandingView status={status} disabled={status === 'signing-in'} onSignIn={() => {}} />
  </StrictMode>,
);
