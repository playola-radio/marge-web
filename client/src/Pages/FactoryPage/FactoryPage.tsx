import { Link } from "react-router-dom";
import { readSession } from "../../utils/session";
import SignOutButton from "../../Components/SignOutButton/SignOutButton";
import { ArrowLeftIcon } from "../../Components/Icons/Icons";
import FactoryOverview from "../../Components/FactoryOverview/FactoryOverview";
import { useFactorySnapshot } from "../../hooks/useFactorySnapshot";

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
        <FactoryOverview {...useFactorySnapshot()} />
      </main>
    </div>
  );
}
