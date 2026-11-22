import BrandLine from '../../Components/BrandLine/BrandLine';
import { AlertIcon, LockIcon, SpinnerIcon } from '../../Components/Icons/Icons';

export type LandingStatus = 'idle' | 'signing-in' | 'failed' | 'not-approved';

type LandingViewProps = {
  status: LandingStatus;
  disabled: boolean;
  onSignIn: () => void;
};

export default function LandingView({ status, disabled, onSignIn }: LandingViewProps) {
  return (
    <main className="landing">
      <BrandLine />
      <div className="landing__main">
        <div className="landing__intro">
          <h1 className="wordmark landing__wordmark">marge</h1>
          <p className="landing__lede">
            Operations console for the Playola software factory, traces and prompts.
          </p>
        </div>
        {status === 'failed' && (
          <div className="banner" role="alert">
            <AlertIcon size={18} className="banner__icon" />
            <span>Sign-in didn&apos;t finish. Try again.</span>
          </div>
        )}
        {status === 'not-approved' && (
          <div className="banner" role="alert">
            <LockIcon size={18} className="banner__icon" />
            <span>
              This Google account isn&apos;t approved for marge. Sign in with an approved account.
            </span>
          </div>
        )}
        <button type="button" className="google-button" disabled={disabled} onClick={onSignIn}>
          {status === 'signing-in' ? (
            <>
              <SpinnerIcon size={20} className="spinner" />
              Signing in…
            </>
          ) : (
            <>
              <span className="google-button__g" aria-hidden="true">
                G
              </span>
              Sign in with Google
            </>
          )}
        </button>
      </div>
      <p className="landing__note">Approved Playola accounts only</p>
    </main>
  );
}
