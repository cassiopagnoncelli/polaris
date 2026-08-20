import { describe, expect, it } from "vitest";

import {
  type ActorSource,
  enforceProductionMutationGate,
  type GateEnvironment,
  isGateEnvironment,
  type OperatorGateDenialLabels,
  PRODUCTION_GATE_DENIED_REASON,
  ProductionMutationRefusedError,
  type ResolvedActor,
} from "../src/index.js";

const ACTORS: Record<ActorSource, ResolvedActor> = {
  declared: { source: "declared", label: "alice@polaris.dev", tokenId: "polaris_ot_alice" },
  operator_token: { source: "operator_token", label: "ops@polaris.dev", tokenId: "polaris_ot_ops" },
  cli: { source: "cli", label: "cli" },
  migration: { source: "migration", label: "schema-migration" },
  system: { source: "system", label: "scheduled-job" },
};

const NON_PROD_ENVS: readonly (GateEnvironment | undefined)[] = [
  "development",
  "staging",
  undefined,
];

describe("enforceProductionMutationGate", () => {
  it("denies production + mutates + non-declared (the only rejection case)", () => {
    for (const source of ["cli", "migration", "system"] as const) {
      expect(() =>
        enforceProductionMutationGate({
          command: { id: "destinations.disable", mutates: true },
          environment: "production",
          actor: ACTORS[source],
        }),
      ).toThrow(ProductionMutationRefusedError);
    }
  });

  it("allows production + mutates + authenticated sources", () => {
    for (const source of ["declared", "operator_token"] as const) {
      expect(() =>
        enforceProductionMutationGate({
          command: { id: "destinations.disable", mutates: true },
          environment: "production",
          actor: ACTORS[source],
        }),
      ).not.toThrow();
    }
  });

  it("allows non-production + mutates + any source", () => {
    for (const env of NON_PROD_ENVS) {
      for (const source of ["declared", "operator_token", "cli", "migration", "system"] as const) {
        expect(() =>
          enforceProductionMutationGate({
            command: { id: "destinations.disable", mutates: true },
            environment: env,
            actor: ACTORS[source],
          }),
        ).not.toThrow();
      }
    }
  });

  it("allows production + read-only + any source", () => {
    for (const source of ["declared", "operator_token", "cli", "migration", "system"] as const) {
      expect(() =>
        enforceProductionMutationGate({
          command: { id: "destinations.list", mutates: false },
          environment: "production",
          actor: ACTORS[source],
        }),
      ).not.toThrow();
    }
  });

  it("increments the gate-denial metric on refusal and skips it on allow", () => {
    const events: OperatorGateDenialLabels[] = [];
    const metrics = {
      incrementGateDenial(labels: OperatorGateDenialLabels): void {
        events.push(labels);
      },
    };

    expect(() =>
      enforceProductionMutationGate({
        command: { id: "destinations.disable", mutates: true },
        environment: "production",
        actor: ACTORS.cli,
        metrics,
      }),
    ).toThrow(ProductionMutationRefusedError);
    expect(events).toEqual([{ actor: "cli", reason: PRODUCTION_GATE_DENIED_REASON }]);

    // Allowed call — metric must not increment.
    enforceProductionMutationGate({
      command: { id: "destinations.disable", mutates: true },
      environment: "production",
      actor: ACTORS.declared,
      metrics,
    });
    expect(events).toHaveLength(1);
  });

  it("includes the command id and the canonical reason code in the refusal", () => {
    try {
      enforceProductionMutationGate({
        command: { id: "keys.create", mutates: true },
        environment: "production",
        actor: ACTORS.cli,
      });
      throw new Error("expected refusal");
    } catch (caught) {
      if (!(caught instanceof ProductionMutationRefusedError)) throw caught;
      expect(caught.commandId).toBe("keys.create");
      expect(caught.environment).toBe("production");
      expect(caught.actorSource).toBe("cli");
      expect(caught.reasonCode).toBe(PRODUCTION_GATE_DENIED_REASON);
      expect(caught.message).toContain("keys.create");
      expect(caught.message).toContain("POLARIS_OPERATOR_TOKEN");
      expect(caught.message).toContain("production_requires_authenticated_actor");
    }
  });
});

describe("isGateEnvironment", () => {
  it("accepts the closed set", () => {
    expect(isGateEnvironment("development")).toBe(true);
    expect(isGateEnvironment("staging")).toBe(true);
    expect(isGateEnvironment("production")).toBe(true);
  });

  it("rejects unknown / typo'd values", () => {
    expect(isGateEnvironment("producton")).toBe(false);
    expect(isGateEnvironment("prod")).toBe(false);
    expect(isGateEnvironment("")).toBe(false);
    expect(isGateEnvironment(undefined)).toBe(false);
    expect(isGateEnvironment(42)).toBe(false);
  });
});
