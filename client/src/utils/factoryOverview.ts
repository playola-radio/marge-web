import type {
  CatalogStatus,
  FactoryBuild,
  FactoryCatalog,
  SnapshotResponse,
} from "../Services/FactoryService";

const ROLES = ["attention", "failure", "quiet", "active", "complete"];

export type CountEntry = {
  key: string;
  count: number;
  label: string;
  shortLabel: string;
  role: string;
};

export function statusOf(catalog: FactoryCatalog, key: string): CatalogStatus {
  return catalog.statuses.find((status) => status.key === key)!;
}

export function roleClass(role: string): string {
  return ROLES.includes(role) ? `role-${role}` : "role-neutral";
}

function isComplete(catalog: FactoryCatalog, build: FactoryBuild): boolean {
  return statusOf(catalog, build.status).role === "complete";
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sortBuilds(
  catalog: FactoryCatalog,
  builds: FactoryBuild[],
): FactoryBuild[] {
  const position = (build: FactoryBuild) =>
    catalog.statuses.findIndex((status) => status.key === build.status);
  return [...builds].sort(
    (a, b) =>
      Number(isComplete(catalog, a)) - Number(isComplete(catalog, b)) ||
      position(a) - position(b) ||
      Date.parse(a.lastEventAt) - Date.parse(b.lastEventAt) ||
      compareText(a.repo, b.repo) ||
      compareText(a.designNumber, b.designNumber),
  );
}

export function inFlight(
  catalog: FactoryCatalog,
  builds: FactoryBuild[],
): FactoryBuild[] {
  return builds.filter((build) => !isComplete(catalog, build));
}

export function countLine(
  catalog: FactoryCatalog,
  builds: FactoryBuild[],
): CountEntry[] {
  const flying = inFlight(catalog, builds);
  return catalog.statuses.flatMap(({ key, label, shortLabel, role }) => {
    const count = flying.filter((build) => build.status === key).length;
    return count > 0 ? [{ key, count, label, shortLabel, role }] : [];
  });
}

export function formatAge(ms: number): string {
  const safe = Math.max(0, ms);
  if (safe < 60_000) return `${Math.floor(safe / 1000)} s`;
  if (safe < 3_600_000) return `${Math.floor(safe / 60_000)} min`;
  const hours = Math.floor(safe / 3_600_000);
  const minutes = Math.floor((safe % 3_600_000) / 60_000);
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
}

export function ageMs(serverNow: string, at: string): number {
  return Date.parse(serverNow) - Date.parse(at);
}

export const OUT_OF_DATE_MS = 3 * 60 * 1000;

export function isOutOfDate(response: SnapshotResponse): boolean {
  return (
    response.receivedAt !== null &&
    ageMs(response.serverNow, response.receivedAt) > OUT_OF_DATE_MS
  );
}

export function repoName(repo: string): string {
  return repo.slice(repo.lastIndexOf("/") + 1);
}
