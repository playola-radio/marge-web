// The body the factory machine pushes to POST /v1/factory/sync (ApiContract.md).

export interface FactoryStatus {
  key: string;
  label: string;
  shortLabel: string;
  role: string;
  [extra: string]: unknown;
}

export interface FactoryCatalog {
  statuses: FactoryStatus[];
  [extra: string]: unknown;
}

export interface FactoryBuild {
  runId: string;
  repo: string;
  designNumber: string;
  designName: string;
  status: string;
  stages: string[];
  currentStage: number;
  reason: string;
  pr: {
    position: number;
    total: number;
    number: number | null;
    url: string | null;
  };
  lastEventAt: string;
  [extra: string]: unknown;
}

export interface FactorySnapshot {
  builds: FactoryBuild[];
  counts: { upNext: number; planNotFinished: number; done: number };
  [extra: string]: unknown;
}

export interface FactoryEvent {
  id: string;
  runId: string;
  at: string;
  repo: string;
  design: string;
  pr: number | null;
  type: string;
  details: Record<string, unknown>;
  artifactId: string | null;
}

export interface FactoryArtifact {
  id: string;
  kind: string;
  at: string;
  body: Record<string, unknown>;
}

export interface SyncBody {
  catalog: FactoryCatalog;
  snapshot: FactorySnapshot;
  events: FactoryEvent[];
  artifacts: FactoryArtifact[];
}

export const FACTORY_SNAPSHOT_KEY = "factory:snapshot";
export const FACTORY_SNAPSHOT_TTL_SECONDS = 365 * 24 * 60 * 60;

const UTC_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STATUS_KEY = /^[a-z][a-z0-9_]{0,39}$/;
const DESIGN_NUMBER = /^\d{3}$/;
const MAX_ARTIFACT_BODY_BYTES = 262144;

/** An ISO 8601 UTC time ending `Z` that names a real calendar moment. */
export function isUtcTime(value: unknown): value is string {
  if (typeof value !== "string" || !UTC_TIME.test(value)) return false;
  const t = Date.parse(value);
  // Month 13 or hour 25 parse to NaN; 30 February rolls into March and fails the round trip.
  return (
    Number.isFinite(t) &&
    new Date(t).toISOString().slice(0, 19) === value.slice(0, 19)
  );
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

type Obj = Record<string, unknown>;

function isPlainObject(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= max;
}

function isInt(value: unknown, min: number): value is number {
  return Number.isInteger(value) && (value as number) >= min;
}

function isArray(value: unknown, min: number, max: number): value is unknown[] {
  return Array.isArray(value) && value.length >= min && value.length <= max;
}

function allUnique(values: unknown[]): boolean {
  return new Set(values).size === values.length;
}

function isCatalog(catalog: unknown): catalog is FactoryCatalog {
  if (!isPlainObject(catalog)) return false;
  const { statuses } = catalog;
  if (!isArray(statuses, 1, 20)) return false;
  const valid = statuses.every(
    (s) =>
      isPlainObject(s) &&
      typeof s.key === "string" &&
      STATUS_KEY.test(s.key) &&
      isText(s.label, 30) &&
      isText(s.shortLabel, 12) &&
      isText(s.role, 20),
  );
  return valid && allUnique(statuses.map((s) => (s as Obj).key));
}

function isBuildPr(pr: unknown): boolean {
  if (!isPlainObject(pr)) return false;
  if (!isInt(pr.position, 1) || !isInt(pr.total, 1) || pr.position > pr.total)
    return false;
  if (pr.number === null && pr.url === null) return true;
  return (
    isInt(pr.number, 1) &&
    typeof pr.url === "string" &&
    pr.url.startsWith("https://")
  );
}

function isBuild(b: unknown, statusKeys: Set<unknown>): boolean {
  if (!isPlainObject(b)) return false;
  return (
    isUuid(b.runId) &&
    isText(b.repo, 200) &&
    typeof b.designNumber === "string" &&
    DESIGN_NUMBER.test(b.designNumber) &&
    isText(b.designName, 120) &&
    statusKeys.has(b.status) &&
    isArray(b.stages, 1, 10) &&
    b.stages.every((stage) => isText(stage, Infinity)) &&
    isInt(b.currentStage, 0) &&
    b.currentStage < b.stages.length &&
    typeof b.reason === "string" &&
    b.reason.length <= 300 &&
    isBuildPr(b.pr) &&
    isUtcTime(b.lastEventAt)
  );
}

function isSnapshot(
  snapshot: unknown,
  catalog: FactoryCatalog,
): snapshot is FactorySnapshot {
  if (!isPlainObject(snapshot)) return false;
  const { builds, counts } = snapshot;
  const statusKeys = new Set(catalog.statuses.map((s) => s.key));
  if (!isArray(builds, 0, 50) || !builds.every((b) => isBuild(b, statusKeys)))
    return false;
  if (!allUnique(builds.map((b) => (b as Obj).runId))) return false;
  return (
    isPlainObject(counts) &&
    isInt(counts.upNext, 0) &&
    isInt(counts.planNotFinished, 0) &&
    isInt(counts.done, 0)
  );
}

function parseArtifacts(artifacts: unknown): FactoryArtifact[] | null {
  if (!isArray(artifacts, 0, 50)) return null;
  const parsed: FactoryArtifact[] = [];
  for (const a of artifacts) {
    if (!isPlainObject(a)) return null;
    const { id, kind, at, body } = a;
    if (
      !isUuid(id) ||
      !isText(kind, 40) ||
      !isUtcTime(at) ||
      !isPlainObject(body)
    )
      return null;
    if (
      Buffer.byteLength(JSON.stringify(body), "utf8") > MAX_ARTIFACT_BODY_BYTES
    )
      return null;
    parsed.push({ id, kind, at, body });
  }
  return allUnique(parsed.map((a) => a.id)) ? parsed : null;
}

function parseEvents(
  events: unknown,
  artifactIds: Set<string>,
): FactoryEvent[] | null {
  if (!isArray(events, 0, 500)) return null;
  const parsed: FactoryEvent[] = [];
  for (const e of events) {
    if (!isPlainObject(e)) return null;
    const { id, runId, at, repo, design, type } = e;
    const pr = e.pr ?? null;
    const details = e.details === undefined ? {} : e.details;
    const artifactId = e.artifactId ?? null;
    if (
      !isUuid(id) ||
      !isUuid(runId) ||
      !isUtcTime(at) ||
      !isText(repo, 200) ||
      !isText(design, 200) ||
      !isText(type, 60) ||
      !(pr === null || isInt(pr, 1)) ||
      !isPlainObject(details) ||
      !(
        artifactId === null ||
        (typeof artifactId === "string" && artifactIds.has(artifactId))
      )
    ) {
      return null;
    }
    parsed.push({ id, runId, at, repo, design, pr, type, details, artifactId });
  }
  return allUnique(parsed.map((e) => e.id)) ? parsed : null;
}

/**
 * Checks a sync body against every rule in ApiContract.md. Returns `null` when
 * any rule breaks. `catalog` and `snapshot` are kept exactly as sent (unknown
 * fields included); events and artifacts are rebuilt with only their listed fields.
 */
export function parseSync(body: unknown): SyncBody | null {
  if (!isPlainObject(body)) return null;
  const { catalog, snapshot } = body;
  if (!isCatalog(catalog) || !isSnapshot(snapshot, catalog)) return null;
  const artifacts = parseArtifacts(body.artifacts);
  if (!artifacts) return null;
  const events = parseEvents(body.events, new Set(artifacts.map((a) => a.id)));
  if (!events) return null;
  return { catalog, snapshot, events, artifacts };
}
