import { describe, it, expect } from 'vitest';
import { readFileSync } from "fs";
import { resolve } from "path";
import { buildAppWithApiRoutes } from "../app";
import { listRoutes } from "../debug/printRoutes";
import {
  ApplicationStage,
  LEGAL_TRANSITIONS,
  PIPELINE_STATES,
} from "../modules/applications/pipelineState";
import {
  PROCESSING_STAGES,
  getProcessingStageFlags,
} from "../modules/applications/processingStage.service";
import { createApplication } from "../modules/applications/applications.repo";
import { transitionPipelineState } from "../modules/applications/applications.service";
import { pool } from "../db";
import { seedUser } from "./helpers/users";
import { ROLES } from "../auth/roles";
import { randomUUID } from "crypto";

type RouteContract = {
  method: string;
  path: string;
  classification: string;
};

type ContractFile = {
  version: string;
  routes: {
    client: RouteContract[];
    portal: RouteContract[];
  };
};

type FlowMapFile = {
  version: string;
  pipelineStages: string[];
  legalTransitions: Record<string, string[]>;
  processingStages: string[];
  processingStageFlags: Record<
    string,
    {
      ocrCompleted: boolean;
      bankingCompleted: boolean;
      documentsCompleted: boolean;
      creditSummaryCompleted: boolean;
    }
  >;
};

function readJson<T>(relativePath: string): T {
  const fullPath = resolve(__dirname, "..", relativePath);
  return JSON.parse(readFileSync(fullPath, "utf-8")) as T;
}

function normalizeRoutes(routes: Array<{ method: string; path: string }>) {
  return [...routes].sort(
    (a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method)
  );
}

beforeEach(async () => {
  await pool.query("delete from application_stage_events");
  await pool.query("delete from applications");
});

describe("server v1 contracts", () => {
  it("enumerates all /api/client and /api/portal routes", () => {
    const contract = readJson<ContractFile>(
      "_artifacts/server-v1-contract.json"
    );
    const app = buildAppWithApiRoutes();
    const routes = listRoutes(app);

    const actualClient = normalizeRoutes(
      routes
        .filter((route) => route.path.startsWith("/api/client"))
        .map(({ method, path }) => ({ method, path }))
    );
    const actualPortal = normalizeRoutes(
      routes
        .filter((route) => route.path.startsWith("/api/portal"))
        .map(({ method, path }) => ({ method, path }))
    );

    const expectedClient = normalizeRoutes(
      contract.routes.client.map(({ method, path }) => ({ method, path }))
    );
    const expectedPortal = normalizeRoutes(
      contract.routes.portal.map(({ method, path }) => ({ method, path }))
    );

    expect(actualClient).toEqual(expectedClient);
    expect(actualPortal).toEqual(expectedPortal);
  });

  it("locks pipeline + processing transitions to V1", () => {
    const flowMap = readJson<FlowMapFile>(
      "_artifacts/server-v1-flow-map.json"
    );

    expect(flowMap.pipelineStages).toEqual(PIPELINE_STATES);
    expect(flowMap.legalTransitions).toEqual(LEGAL_TRANSITIONS);
    expect(flowMap.processingStages).toEqual(PROCESSING_STAGES);

    const expectedFlags = Object.fromEntries(
      PROCESSING_STAGES.map((stage) => [stage, getProcessingStageFlags(stage)])
    );
    expect(flowMap.processingStageFlags).toEqual(expectedFlags);
  });

  it("blocks invalid pipeline transitions", async () => {
    const phoneSuffix = String(Date.now()).slice(-7);
    const user = await seedUser({
      phoneNumber: `+1415${phoneSuffix}`,
      email: `contract-${randomUUID()}@example.com`,
      role: ROLES.STAFF,
    });
    const application = await createApplication({
      ownerUserId: user.id,
      name: "Contract Guard",
      metadata: null,
      productType: "standard",
      trigger: "contract_guard",
      triggeredBy: "test",
    });

    await expect(
      transitionPipelineState({
        applicationId: application.id,
        nextState: ApplicationStage.ACCEPTED,
        actorUserId: null,
        actorRole: null,
        trigger: "invalid_transition_test",
      })
    ).rejects.toMatchObject({ code: "invalid_transition" });
  });
});
