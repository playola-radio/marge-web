import { Link } from 'react-router-dom';
import { readSession } from '../auth/session';
import SignOutButton from '../components/SignOutButton';
import { ArrowLeftIcon, FactoryIcon } from '../components/Icons';

export default function FactoryPage() {
  const email = readSession()?.email;

  return (
    <div className="factory">
      <header className="factory__header">
        <div className="factory__crumbs">
          <Link to="/home" className="back-link">
            <ArrowLeftIcon size={20} />
            <span className="wordmark back-link__wordmark">marge</span>
          </Link>
          <span className="factory__separator desktop-only" aria-hidden="true">
            /
          </span>
          <span className="factory__crumb desktop-only">Software Factory</span>
        </div>
        <div className="factory__account">
          <span className="signed-in-email desktop-only">{email}</span>
          <SignOutButton />
        </div>
      </header>
      <main className="factory__body">
        <h1 className="wordmark factory__heading">Software Factory</h1>
        <section className="empty-panel">
          <span className="icon-tile icon-tile--large" aria-hidden="true">
            <FactoryIcon size={28} />
          </span>
          <h2 className="empty-panel__title">Control panel not built yet</h2>
          <p className="empty-panel__text">
            Designs, builds and pull requests will show here. Until then, use the factory command
            line.
          </p>
        </section>
      </main>
    </div>
  );
}
