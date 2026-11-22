import type {
  FactoryBuild,
  FactoryCatalog,
} from "../../Services/FactoryService";
import {
  ageMs,
  formatAge,
  repoName,
  roleClass,
  statusOf,
} from "../../utils/factoryOverview";
import { ExternalLinkIcon } from "../Icons/Icons";

const EDGE_ROLES = ["attention", "failure", "quiet"];
const HOUR_MS = 60 * 60 * 1000;

type Props = {
  build: FactoryBuild;
  catalog: FactoryCatalog;
  serverNow: string;
  outOfDate: boolean;
};

function stageClass(index: number, current: number, complete: boolean) {
  if (complete) return "stage stage--done";
  if (index < current) return "stage stage--passed";
  if (index === current) return "stage stage--current";
  return "stage stage--upcoming";
}

export default function BuildRow({
  build,
  catalog,
  serverNow,
  outOfDate,
}: Props) {
  const status = statusOf(catalog, build.status);
  const role = roleClass(status.role);
  const complete = status.role === "complete";
  const moving = status.role === "active" && !outOfDate;
  const newsAge = ageMs(serverNow, build.lastEventAt);
  const chipText =
    status.role === "quiet" && newsAge >= HOUR_MS
      ? `${status.label} ${Math.floor(newsAge / HOUR_MS)} h`
      : status.label;
  const title = `${build.designNumber} ${build.designName}`;
  const prText = `PR ${build.pr.position} of ${build.pr.total}`;
  const showLink =
    status.role === "attention" && build.pr.url !== null && !complete;

  const className = [
    "build-row",
    role,
    EDGE_ROLES.includes(status.role) ? "build-row--edge" : "",
    moving ? "build-row--moving" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <li className={className} aria-label={title}>
      <div className="build-row__status">
        <span className={`chip ${role}`}>
          {moving && <span className="chip__dot" aria-hidden="true" />}
          {chipText}
        </span>
        <span className="build-row__repo mobile-only">
          {repoName(build.repo)}
        </span>
      </div>
      <div className="build-row__design">
        <span className="build-row__title">{title}</span>
        <span className="build-row__meta desktop-only">
          {`${repoName(build.repo)} · ${prText}`}
        </span>
      </div>
      <div className="build-row__stage">
        <ol className="stage-track">
          {build.stages.map((stage, index) => {
            const current = !complete && index === build.currentStage;
            return (
              <li
                key={index}
                className={stageClass(index, build.currentStage, complete)}
                aria-current={current ? "step" : undefined}
              >
                <span className="stage__bar" aria-hidden="true" />
                <span className="stage__label desktop-only">{stage}</span>
              </li>
            );
          })}
        </ol>
        <p className="build-row__reason">
          <span className="mobile-only">
            {`${build.stages[build.currentStage]} · ${prText} — `}
          </span>
          {build.reason}
        </p>
      </div>
      <div className="build-row__news">{`${formatAge(newsAge)} ago`}</div>
      {showLink && (
        <div className="build-row__action">
          <a
            className="open-pr"
            href={build.pr.url!}
            target="_blank"
            rel="noopener noreferrer"
          >
            <ExternalLinkIcon size={18} />
            {`Open PR #${build.pr.number}`}
            <span aria-hidden="true"> ↗</span>
          </a>
        </div>
      )}
    </li>
  );
}
