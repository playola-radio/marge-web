import type { ReactNode } from "react";
import type {
  FactoryCatalog,
  FactorySnapshot,
} from "../../Services/FactoryService";
import type { FactorySnapshotState } from "../../hooks/useFactorySnapshot";
import {
  ageMs,
  countLine,
  formatAge,
  inFlight,
  isOutOfDate,
  roleClass,
  sortBuilds,
} from "../../utils/factoryOverview";
import {
  CheckCircleIcon,
  RefreshIcon,
  TriangleAlertIcon,
  UnplugIcon,
  WifiOffIcon,
} from "../Icons/Icons";
import BuildRow from "./BuildRow";

type Props = { state: FactorySnapshotState; retry: () => void };

function Panel({
  icon,
  title,
  text,
  className = "",
  children,
}: {
  icon: ReactNode;
  title: string;
  text: string;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <section className={`empty-panel overview__panel ${className}`.trim()}>
      <span className="overview__panel-icon" aria-hidden="true">
        {icon}
      </span>
      <h2 className="wordmark empty-panel__title overview__panel-title">
        {title}
      </h2>
      <p className="empty-panel__text">{text}</p>
      {children}
    </section>
  );
}

function Loading() {
  return (
    <div
      className="overview__loading"
      role="status"
      aria-busy="true"
      aria-label="Loading the factory"
    >
      <span className="skeleton skeleton--count" />
      {[0, 1, 2].map((i) => (
        <div key={i} className="skeleton-row">
          <span className="skeleton skeleton--chip" />
          <span className="skeleton-row__design">
            <span className="skeleton skeleton--title" />
            <span className="skeleton skeleton--meta" />
          </span>
          <span className="skeleton-row__stage">
            <span className="skeleton skeleton--track" />
            <span className="skeleton skeleton--reason" />
          </span>
          <span className="skeleton skeleton--news desktop-only" />
        </div>
      ))}
    </div>
  );
}

function Updated({ age, late }: { age: string; late: boolean }) {
  return (
    <span
      className={`overview__updated${late ? " overview__updated--late" : ""}`}
    >
      <span className="desktop-only">Updated </span>
      {`${age} ago`}
    </span>
  );
}

function Banner({ age }: { age: string }) {
  return (
    <div className="overview__banner" role="status">
      <WifiOffIcon size={20} className="overview__banner-icon" />
      <div>
        <p className="overview__banner-title">
          <span className="desktop-only">{`The factory machine hasn't reported for ${age}.`}</span>
          <span className="mobile-only">{`Factory machine silent for ${age}`}</span>
        </p>
        <p className="overview__banner-text">
          <span className="desktop-only">
            This is what it said last. Builds may have moved on since.
          </span>
          <span className="mobile-only">
            Showing its last report. Builds may have moved on since.
          </span>
        </p>
      </div>
    </div>
  );
}

function Footer({ counts }: { counts: FactorySnapshot["counts"] }) {
  return (
    <footer className="overview__footer">
      <span className="overview__footer-label desktop-only">Not in flight</span>
      <span>{`Up next ${counts.upNext}`}</span>
      <span className="mobile-only" aria-hidden="true">
        ·
      </span>
      <span>{`Plan not finished ${counts.planNotFinished}`}</span>
      <span className="mobile-only" aria-hidden="true">
        ·
      </span>
      <span>{`Done ${counts.done}`}</span>
    </footer>
  );
}

function Loaded({
  catalog,
  snapshot,
  receivedAt,
  serverNow,
}: {
  catalog: FactoryCatalog;
  snapshot: FactorySnapshot;
  receivedAt: string;
  serverNow: string;
}) {
  const outOfDate = isOutOfDate({ catalog, snapshot, receivedAt, serverNow });
  const silence = formatAge(ageMs(serverNow, receivedAt));
  const sorted = sortBuilds(catalog, snapshot.builds);
  const flying = inFlight(catalog, snapshot.builds);
  const counts = countLine(catalog, snapshot.builds);
  const rows = (builds: typeof sorted) =>
    builds.map((build) => (
      <BuildRow
        key={build.runId}
        build={build}
        catalog={catalog}
        serverNow={serverNow}
        outOfDate={outOfDate}
      />
    ));

  return (
    <>
      <div className="overview__summary">
        {flying.length > 0 ? (
          <ul className="count-line">
            {counts.map((entry) => (
              <li key={entry.key} className="count-line__item">
                <span
                  className={`count-line__dot ${roleClass(entry.role)}`}
                  aria-hidden="true"
                />
                <span className="desktop-only">{`${entry.label} ${entry.count}`}</span>
                <span className="mobile-only">{`${entry.shortLabel} ${entry.count}`}</span>
              </li>
            ))}
          </ul>
        ) : (
          <span className="overview__note">Nothing running</span>
        )}
        <Updated age={silence} late={outOfDate} />
      </div>
      {outOfDate && <Banner age={silence} />}
      <div
        className={`overview__content${outOfDate ? " overview__content--dimmed" : ""}`}
      >
        {flying.length > 0 ? (
          <>
            <div className="build-list__head desktop-only" aria-hidden="true">
              <span>Status</span>
              <span>Design</span>
              <span>Stage</span>
              <span>Last news</span>
            </div>
            <ul className="build-list">{rows(sorted)}</ul>
          </>
        ) : (
          <>
            <Panel
              icon={<CheckCircleIcon size={28} />}
              className="overview__panel--idle"
              title="Nothing in flight"
              text="No design is being built right now. A design starts here once its plan is finished and merged."
            />
            {sorted.length > 0 && (
              <ul className="build-list">{rows(sorted)}</ul>
            )}
          </>
        )}
      </div>
      <Footer counts={snapshot.counts} />
    </>
  );
}

export default function FactoryOverview({ state, retry }: Props) {
  if (state.kind === "loading") return <Loading />;

  if (state.kind === "error") {
    return (
      <Panel
        icon={<TriangleAlertIcon size={28} />}
        className="overview__panel--error"
        title="Couldn't load the factory"
        text="marge's server didn't answer. Nothing has changed in the factory itself."
      >
        <button type="button" className="overview__retry" onClick={retry}>
          <RefreshIcon size={18} />
          Try again
        </button>
      </Panel>
    );
  }

  const { data } = state;
  if (data.snapshot === null) {
    return (
      <>
        <div className="overview__summary">
          <span className="overview__note">No report yet</span>
        </div>
        <Panel
          icon={<UnplugIcon size={28} />}
          title="Not connected yet"
          text="The factory machine hasn't sent its first report. This page fills in once it does."
        />
      </>
    );
  }

  return (
    <Loaded
      catalog={data.catalog}
      snapshot={data.snapshot}
      receivedAt={data.receivedAt}
      serverNow={data.serverNow}
    />
  );
}
