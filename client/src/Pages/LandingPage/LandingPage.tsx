import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useGoogleLogin, useGoogleOAuth } from '@react-oauth/google';
import { signIn } from '../../Services/AuthService';
import { safeRedirectTo } from '../../utils/redirectTo';
import LandingView, { type LandingStatus } from './LandingView';

export default function LandingPage({ scriptLoadFailed }: { scriptLoadFailed: boolean }) {
  const [status, setStatus] = useState<LandingStatus>('idle');
  const { scriptLoadedSuccessfully } = useGoogleOAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const login = useGoogleLogin({
    flow: 'auth-code',
    scope: 'openid email profile',
    onSuccess: async ({ code }) => {
      const result = await signIn(code);
      if (result === 'ok') {
        navigate(safeRedirectTo(searchParams.get('redirectTo')), { replace: true });
      } else {
        setStatus(result === 'not_approved' ? 'not-approved' : 'failed');
      }
    },
    onError: () => setStatus('failed'),
    onNonOAuthError: () => setStatus('failed'),
  });

  const disabled = scriptLoadFailed || !scriptLoadedSuccessfully || status === 'signing-in';

  function startSignIn() {
    if (disabled) return;
    setStatus('signing-in');
    login();
  }

  return (
    <LandingView
      status={scriptLoadFailed ? 'failed' : status}
      disabled={disabled}
      onSignIn={startSignIn}
    />
  );
}
