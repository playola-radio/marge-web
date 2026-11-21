import { Link } from 'react-router-dom';
import { readSession } from '../auth/session';
import BrandLine from '../components/BrandLine';
import SignOutButton from '../components/SignOutButton';
import { ChevronRightIcon, FactoryIcon } from '../components/Icons';
import margeFace from '../assets/marge-face.jpeg';

export default function TitlePage() {
  const email = readSession()?.email;

  return (
    <main className="title">
      <div className="title__portrait">
        <img src={margeFace} alt="Marge" />
      </div>
      <div className="title__panel">
        <BrandLine />
        <div className="title__main">
          <h1 className="wordmark title__wordmark">marge</h1>
          <nav className="menu" aria-label="Main menu">
            <Link to="/factory" className="menu__item">
              <span className="icon-tile" aria-hidden="true">
                <FactoryIcon size={24} />
              </span>
              <span className="menu__text">
                <span className="menu__title">Software Factory</span>
                <span className="menu__subtitle">Designs, builds and pull requests</span>
              </span>
              <ChevronRightIcon size={22} className="menu__chevron" />
            </Link>
          </nav>
        </div>
        <div className="title__footer">
          <span className="signed-in-email">{email}</span>
          <SignOutButton />
        </div>
      </div>
    </main>
  );
}
