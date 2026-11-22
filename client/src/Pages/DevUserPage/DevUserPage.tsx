import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { devSignIn } from '../../Services/AuthService';

export default function DevUserPage() {
  const [failed, setFailed] = useState(false);
  const started = useRef(false);
  const navigate = useNavigate();

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    devSignIn().then(
      () => navigate('/home', { replace: true }),
      () => setFailed(true),
    );
  }, [navigate]);

  return <p>{failed ? 'Dev sign-in failed' : 'Signing in as the dev user…'}</p>;
}
