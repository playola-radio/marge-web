import axios from "axios";
import { readToken } from "../utils/session";

export type CatalogStatus = {
  key: string;
  label: string;
  shortLabel: string;
  role: string;
};

export type FactoryCatalog = { statuses: CatalogStatus[] };

export type FactoryBuild = {
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
};

export type FactorySnapshot = {
  builds: FactoryBuild[];
  counts: { upNext: number; planNotFinished: number; done: number };
};

export type SnapshotResponse =
  | {
      catalog: FactoryCatalog;
      snapshot: FactorySnapshot;
      receivedAt: string;
      serverNow: string;
    }
  | { catalog: null; snapshot: null; receivedAt: null; serverNow: string };

const serverBaseUrl = import.meta.env.VITE_SERVER_BASE_URL;

export async function fetchFactorySnapshot(): Promise<SnapshotResponse> {
  const { data } = await axios.get<SnapshotResponse>(
    `${serverBaseUrl}/v1/factory/snapshot`,
    { headers: { Authorization: "Bearer " + readToken() }, timeout: 15_000 },
  );
  return data;
}
