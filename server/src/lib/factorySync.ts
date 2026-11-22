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
  pr: { position: number; total: number; number: number | null; url: string | null };
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
