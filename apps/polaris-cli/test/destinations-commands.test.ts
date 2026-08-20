/**
 * Unit tests for the `polaris destinations` command surface (P6-004).
 *
 * Approach mirrors `keys-commands.test.ts`:
 *
 *   - Each command exposes a `buildDestinationsXxxRunner({ openStore, ... })`
 *     factory so tests can inject an in-memory store instead of Kysely. The
 *     runner contract is identical to production.
 *   - Smaller surface tests (`mutates` flags, `--help` wiring) drive the
 *     real command tree through `run()` to confirm the dispatcher sees them.
 *
 * The CRITICAL test in this file is the mapping-field rejection: any flag
 * resembling event-to-vendor mapping must be rejected BEFORE any DB write.
 * This is the architectural guarantee for P6-004's acceptance criterion
 * "CLI cannot define event-to-vendor mappings."
 *
 * The schema-level invariant — `DestinationsTable` has NO column resembling
 * a mapping field — is enforced as a structural test against the typed
 * surface in `@polaris/persistence-postgres`.
 */
import { describe, expect, it } from "vitest";

import {
  buildDestinationsCreateRunner,
  buildDestinationsDisableReplayRunner,
  buildDestinationsDisableRunner,
  buildDestinationsEnableReplayRunner,
  buildDestinationsEnableRunner,
  buildDestinationsListRunner,
  buildDestinationsRotateSecretRunner,
  buildDestinationsShowRunner,
  buildDestinationsUpdateOpsRunner,
  type CommandContext,
  DESTINATION_ID_PREFIX,
  type DestinationRow,
  type DestinationsCreateStore,
  type DestinationsDisableReplayStore,
  type DestinationsDisableStore,
  type DestinationsEnableReplayStore,
  type DestinationsEnableStore,
  type DestinationsListStore,
  type DestinationsRotateSecretStore,
  type DestinationsShowStore,
  type DestinationsUpdateOpsStore,
  ExitCode,
  FORBIDDEN_MAPPING_FLAG_TOKENS,
  type InsertDestinationInput,
  type OutputStreams,
  type PackageMeta,
  rejectMappingArguments,
  run,
  type UpdateDestinationOpsInput,
  validateSecretValue,
} from "../src/index.js";

const META: PackageMeta = {
  version: "0.0.0-test",
  gitSha: "deadbeef",
  buildTime: "2026-05-12T00:00:00.000Z",
  releaseLabel: undefined,
  nodeVersion: "v22.0.0",
};

const VALID_ENV = {
  POLARIS_API_URL: "https://polaris.example.internal",
  POLARIS_TOKEN: "polaris_ot_test",
} as const;

interface Capture {
  readonly streams: OutputStreams;
  readonly stdout: string[];
  readonly stderr: string[];
}

function captureOutput(): Capture {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    streams: {
      writeOut: (text) => {
        stdout.push(text);
      },
      writeErr: (text) => {
        stderr.push(text);
      },
    },
    stdout,
    stderr,
  };
}

/**
 * In-memory `destinations` table backing every runner-level test. The shape
 * mirrors the Kysely row the production repository surfaces.
 */
interface CapturedDestinationAudit {
  readonly action: string;
  readonly auditId: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly actorSource: string;
  readonly actorLabel: string;
  readonly projectId: string;
  readonly environment: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly reason: string | null;
}

class InMemoryDestinationStore {
  public readonly rows = new Map<string, DestinationRow>();
  public inserts: InsertDestinationInput[] = [];
  public updateCalls = 0;
  public closeCalls = 0;
  public auditCalls: CapturedDestinationAudit[] = [];

  insert(row: DestinationRow): void {
    this.rows.set(row.destination_id, row);
  }

  asCreateStore(): DestinationsCreateStore {
    return {
      insertWithAudit: async (input, audit) => {
        this.inserts.push(input);
        this.rows.set(input.destination_id, {
          destination_id: input.destination_id,
          project_id: input.project_id,
          environment: input.environment,
          vendor: input.vendor,
          instance_label: input.instance_label,
          status: "active",
          mode: input.mode,
          max_concurrency: input.max_concurrency ?? 4,
          max_rps: input.max_rps ?? 50,
          retry_policy: input.retry_policy ?? "standard",
          dead_letter_threshold: input.dead_letter_threshold ?? 5,
          disabled_reason: null,
          // P7-004: newly-created destinations are opt-out by default.
          replay_opt_in: false,
          replay_opt_in_reason: null,
          replay_opt_in_at: null,
          created_at: new Date("2026-05-12T12:00:00.000Z").toISOString(),
          updated_at: new Date("2026-05-12T12:00:00.000Z").toISOString(),
        });
        this.auditCalls.push({
          action: "destinations.create",
          auditId: audit.auditId,
          targetType: "destination",
          targetId: input.destination_id,
          actorSource: audit.actorSource,
          actorLabel: audit.actorLabel,
          projectId: audit.projectId,
          environment: audit.environment,
          before: null,
          after: audit.after,
          reason: audit.reason,
        });
      },
      close: async () => {
        this.closeCalls += 1;
      },
    };
  }

  asListStore(): DestinationsListStore {
    return {
      list: async (filter) => {
        return [...this.rows.values()].filter((row) => {
          if (filter.projectId !== undefined && row.project_id !== filter.projectId) return false;
          if (filter.environment !== undefined && row.environment !== filter.environment) {
            return false;
          }
          return true;
        });
      },
      close: async () => {
        this.closeCalls += 1;
      },
    };
  }

  asShowStore(): DestinationsShowStore {
    return {
      findById: async (id) => this.rows.get(id) ?? null,
      close: async () => {
        this.closeCalls += 1;
      },
    };
  }

  asEnableStore(): DestinationsEnableStore {
    return {
      findById: async (id) => this.rows.get(id) ?? null,
      enableWithAudit: async (id, now, audit) => {
        const row = this.rows.get(id);
        if (row === undefined) return false;
        if (row.status === "active") return false;
        this.rows.set(id, {
          ...row,
          status: "active",
          disabled_reason: null,
          updated_at: now.toISOString(),
        });
        this.auditCalls.push({
          action: "destinations.enable",
          auditId: audit.auditId,
          targetType: "destination",
          targetId: id,
          actorSource: audit.actorSource,
          actorLabel: audit.actorLabel,
          projectId: audit.projectId,
          environment: audit.environment,
          before: audit.before,
          after: audit.after,
          reason: null,
        });
        return true;
      },
      close: async () => {
        this.closeCalls += 1;
      },
    };
  }

  asDisableStore(): DestinationsDisableStore {
    return {
      findById: async (id) => this.rows.get(id) ?? null,
      disableWithAudit: async (id, reason, now, audit) => {
        const row = this.rows.get(id);
        if (row === undefined) return false;
        if (row.status === "disabled") return false;
        this.rows.set(id, {
          ...row,
          status: "disabled",
          disabled_reason: reason,
          updated_at: now.toISOString(),
        });
        this.auditCalls.push({
          action: "destinations.disable",
          auditId: audit.auditId,
          targetType: "destination",
          targetId: id,
          actorSource: audit.actorSource,
          actorLabel: audit.actorLabel,
          projectId: audit.projectId,
          environment: audit.environment,
          before: audit.before,
          after: audit.after,
          reason: audit.reason,
        });
        return true;
      },
      close: async () => {
        this.closeCalls += 1;
      },
    };
  }

  asEnableReplayStore(): DestinationsEnableReplayStore {
    return {
      findById: async (id) => this.rows.get(id) ?? null,
      enableReplayWithAudit: async (id, reason, now, audit) => {
        const row = this.rows.get(id);
        if (row === undefined) return false;
        if (row.replay_opt_in === true) return false;
        this.rows.set(id, {
          ...row,
          replay_opt_in: true,
          replay_opt_in_reason: reason,
          replay_opt_in_at: now.toISOString(),
          updated_at: now.toISOString(),
        });
        this.auditCalls.push({
          action: "destinations.enable-replay",
          auditId: audit.auditId,
          targetType: "destination",
          targetId: id,
          actorSource: audit.actorSource,
          actorLabel: audit.actorLabel,
          projectId: audit.projectId,
          environment: audit.environment,
          before: audit.before,
          after: audit.after,
          reason: audit.reason,
        });
        return true;
      },
      close: async () => {
        this.closeCalls += 1;
      },
    };
  }

  asDisableReplayStore(): DestinationsDisableReplayStore {
    return {
      findById: async (id) => this.rows.get(id) ?? null,
      disableReplayWithAudit: async (id, reason, now, audit) => {
        const row = this.rows.get(id);
        if (row === undefined) return false;
        if (row.replay_opt_in === false) return false;
        this.rows.set(id, {
          ...row,
          replay_opt_in: false,
          replay_opt_in_reason: reason,
          // replay_opt_in_at is preserved.
          updated_at: now.toISOString(),
        });
        this.auditCalls.push({
          action: "destinations.disable-replay",
          auditId: audit.auditId,
          targetType: "destination",
          targetId: id,
          actorSource: audit.actorSource,
          actorLabel: audit.actorLabel,
          projectId: audit.projectId,
          environment: audit.environment,
          before: audit.before,
          after: audit.after,
          reason: audit.reason,
        });
        return true;
      },
      close: async () => {
        this.closeCalls += 1;
      },
    };
  }

  /**
   * The rotate-secret adapter keeps a `secrets` map beside `rows`, because
   * `DestinationRow` deliberately has no credential field — the production
   * readers do not select the column. Tests assert on this map rather than on
   * the row, which is exactly the shape of the real system.
   */
  public readonly secrets = new Map<string, string>();

  asRotateSecretStore(): DestinationsRotateSecretStore {
    return {
      findById: async (id) => this.rows.get(id) ?? null,
      rotateWithAudit: async (id, secretValue, now, audit) => {
        const row = this.rows.get(id);
        if (row === undefined) return false;
        this.secrets.set(id, secretValue);
        this.rows.set(id, { ...row, updated_at: now.toISOString() });
        this.auditCalls.push({
          action: "destinations.rotate-secret",
          auditId: audit.auditId,
          targetType: "destination",
          targetId: id,
          actorSource: audit.actorSource,
          actorLabel: audit.actorLabel,
          projectId: audit.projectId,
          environment: audit.environment,
          before: audit.before,
          after: audit.after,
          reason: audit.reason,
        });
        return true;
      },
      close: async () => {
        this.closeCalls += 1;
      },
    };
  }

  asUpdateOpsStore(): DestinationsUpdateOpsStore {
    return {
      findById: async (id) => this.rows.get(id) ?? null,
      updateWithAudit: async (id, patch: UpdateDestinationOpsInput, now, audit) => {
        this.updateCalls += 1;
        const row = this.rows.get(id);
        if (row === undefined) return false;
        this.rows.set(id, {
          ...row,
          ...(patch.max_concurrency !== undefined
            ? { max_concurrency: patch.max_concurrency }
            : {}),
          ...(patch.max_rps !== undefined ? { max_rps: patch.max_rps } : {}),
          ...(patch.retry_policy !== undefined ? { retry_policy: patch.retry_policy } : {}),
          ...(patch.dead_letter_threshold !== undefined
            ? { dead_letter_threshold: patch.dead_letter_threshold }
            : {}),
          updated_at: now.toISOString(),
        });
        this.auditCalls.push({
          action: "destinations.update-ops",
          auditId: audit.auditId,
          targetType: "destination",
          targetId: id,
          actorSource: audit.actorSource,
          actorLabel: audit.actorLabel,
          projectId: audit.projectId,
          environment: audit.environment,
          before: audit.before,
          after: audit.after,
          reason: audit.reason,
        });
        return true;
      },
      close: async () => {
        this.closeCalls += 1;
      },
    };
  }
}

function makeContext(streams: OutputStreams): CommandContext {
  const noopLogger = {
    fatal: () => {},
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {},
    trace: () => {},
  } as unknown as CommandContext["logger"];
  return {
    config: {
      profile: "default",
      apiUrl: "https://polaris.example.internal",
      token: "polaris_ot_test",
      tokenEnvName: "POLARIS_TOKEN",
      output: "human",
      logLevel: "warn",
      configFilePath: undefined,
    },
    logger: {
      ...noopLogger,
      child: () => noopLogger,
    } as CommandContext["logger"],
    output: streams,
    meta: META,
    actor: { source: "cli", label: "cli" },
  };
}

function jsonContext(streams: OutputStreams): CommandContext {
  const base = makeContext(streams);
  return {
    ...base,
    config: { ...base.config, output: "json" },
  };
}

function seedActiveRow(
  store: InMemoryDestinationStore,
  overrides: Partial<DestinationRow> = {},
): DestinationRow {
  const base: DestinationRow = {
    destination_id: "polaris_dst_active-1",
    project_id: "storefront",
    environment: "production",
    vendor: "meta-capi",
    instance_label: "storefront-prod",
    status: "active",
    mode: "live",
    max_concurrency: 4,
    max_rps: 50,
    retry_policy: "standard",
    dead_letter_threshold: 5,
    disabled_reason: null,
    // P7-004: replay-opt-in trio. Defaults to opt-out so the seed mirrors
    // a freshly-created destination.
    replay_opt_in: false,
    replay_opt_in_reason: null,
    replay_opt_in_at: null,
    created_at: "2026-05-10T00:00:00.000Z",
    updated_at: "2026-05-10T00:00:00.000Z",
  };
  const row: DestinationRow = { ...base, ...overrides };
  store.insert(row);
  return row;
}

const CREATE_BASE_ARGS = {
  project: "storefront",
  env: "production",
  vendor: "meta-capi",
  instanceLabel: "storefront-prod",
  secretValue: '{"pixel_id":"123","access_token":"EAAB-live-token"}',
} as const;

describe("validation: rejectMappingArguments", () => {
  // The architectural guarantee: every flag/argument resembling mapping
  // semantics is refused before any DB write. The list of forbidden tokens
  // is documented in `commands/destinations/validation.ts`.
  it("rejects each documented mapping-field token", () => {
    for (const token of FORBIDDEN_MAPPING_FLAG_TOKENS) {
      // Try the kebab-case form (--field-map), the snake_case form
      // (field_map), and the camelCase form commander stores
      // (--field-map -> fieldMap).
      const camel = token.replace(/[-_](.)/g, (_, ch: string) => ch.toUpperCase());
      const snake = token.replace(/-/g, "_");
      const variants = Array.from(new Set([token, camel, snake]));
      for (const variant of variants) {
        expect(() =>
          rejectMappingArguments({ [variant]: "anything" } as Record<string, unknown>),
        ).toThrow(/not accepted by the destinations CLI/);
      }
    }
  });

  it("passes-through arg bags that contain no mapping flags", () => {
    expect(() =>
      rejectMappingArguments({
        project: "storefront",
        env: "production",
        vendor: "meta-capi",
        instanceLabel: "storefront-prod",
        secretValue: "EAAB-live-token",
        maxConcurrency: "8",
      }),
    ).not.toThrow();
  });
});

describe("validation: validateSecretValue", () => {
  /**
   * This replaced `validateSecretRef`, which asserted a `<provider>:<ref>`
   * shape across five cases. That shape was Polaris's own — a pointer format
   * the platform defined and could therefore validate. A credential's shape
   * belongs to the vendor, so there is nothing here to check beyond presence;
   * meta-capi's `parseResolvedSecret` is what rejects a malformed one, at
   * delivery time, where the shape is actually known.
   */
  it("accepts any non-empty credential, whatever its shape", () => {
    expect(validateSecretValue('{"pixel_id":"123","access_token":"EAAB"}')).toBe(
      '{"pixel_id":"123","access_token":"EAAB"}',
    );
    expect(validateSecretValue("https://hooks.example/receiver")).toBe(
      "https://hooks.example/receiver",
    );
    // Including one that looks exactly like the old pointer format. Nothing
    // resolves it any more, so it is just an odd credential — and the loud
    // failure belongs at the vendor, not here.
    expect(validateSecretValue("env:META_CAPI_TOKEN")).toBe("env:META_CAPI_TOKEN");
  });

  it("trims surrounding whitespace", () => {
    // A credential pasted from a vendor console routinely carries a trailing
    // newline, and the vendor would reject it with an opaque 401.
    expect(validateSecretValue("  EAAB-token  ")).toBe("EAAB-token");
  });

  it("rejects an empty or whitespace-only value", () => {
    expect(() => validateSecretValue("")).toThrow(/non-empty credential/);
    expect(() => validateSecretValue("   ")).toThrow(/non-empty credential/);
  });

  it("does not echo the value in its error message", () => {
    // The one thing this validator must never do. It only ever refuses an
    // empty value today, but the rule holds for whatever it grows to refuse.
    try {
      validateSecretValue("");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as Error).message).not.toContain('""');
    }
  });
});

describe("destinations create runner", () => {
  it("inserts an active destination with a polaris_dst_ id and respects --output human", async () => {
    const store = new InMemoryDestinationStore();
    const capture = captureOutput();
    const runner = buildDestinationsCreateRunner({
      issueId: () => "polaris_dst_fixed-id-1",
      openStore: () => store.asCreateStore(),
      generateAuditId: () => "audit-create-1",
    });
    await runner(CREATE_BASE_ARGS, makeContext(capture.streams));

    expect(store.inserts).toHaveLength(1);
    const inserted = store.inserts[0];
    if (inserted === undefined) throw new Error("expected one insert");
    expect(inserted.destination_id).toBe("polaris_dst_fixed-id-1");
    expect(inserted.destination_id.startsWith(DESTINATION_ID_PREFIX)).toBe(true);
    expect(inserted.project_id).toBe("storefront");
    expect(inserted.environment).toBe("production");
    expect(inserted.vendor).toBe("meta-capi");
    expect(inserted.instance_label).toBe("storefront-prod");
    expect(inserted.secret_value).toBe(CREATE_BASE_ARGS.secretValue);
    expect(inserted.mode).toBe("live");

    const stdout = capture.stdout.join("");
    expect(stdout).toContain("polaris destination created");
    expect(stdout).toContain("polaris_dst_fixed-id-1");
    expect(stdout).toContain("instance_label  storefront-prod");

    // P6-006 follow-up: audit row persisted in the same transaction.
    expect(store.auditCalls).toHaveLength(1);
    const audit = store.auditCalls[0];
    if (audit === undefined) throw new Error("expected one audit call");
    expect(audit.action).toBe("destinations.create");
    expect(audit.auditId).toBe("audit-create-1");
    expect(audit.targetType).toBe("destination");
    expect(audit.targetId).toBe("polaris_dst_fixed-id-1");
    expect(audit.actorSource).toBe("cli");
    expect(audit.actorLabel).toBe("cli");
    expect(audit.projectId).toBe("storefront");
    expect(audit.environment).toBe("production");
    expect(audit.before).toBeNull();
    expect(audit.after).toMatchObject({
      destination_id: "polaris_dst_fixed-id-1",
      project_id: "storefront",
      environment: "production",
      vendor: "meta-capi",
      instance_label: "storefront-prod",
      status: "active",
      mode: "live",
      max_concurrency: 4,
      max_rps: 50,
      retry_policy: "standard",
      dead_letter_threshold: 5,
      disabled_reason: null,
    });
    // No --reason supplied: runner stamps a default rationale so the audit
    // row carries non-null context.
    expect(audit.reason).toBe("destinations.create: meta-capi instance storefront-prod");
  });

  it("stamps the operator-supplied --reason on the audit row when provided", async () => {
    const store = new InMemoryDestinationStore();
    const capture = captureOutput();
    const runner = buildDestinationsCreateRunner({
      issueId: () => "polaris_dst_with-reason",
      openStore: () => store.asCreateStore(),
    });
    await runner(
      { ...CREATE_BASE_ARGS, reason: "onboarding new merchant" },
      makeContext(capture.streams),
    );
    expect(store.auditCalls).toHaveLength(1);
    expect(store.auditCalls[0]?.reason).toBe("onboarding new merchant");
  });

  it("snapshots operator-supplied operational tuning on the audit `after`", async () => {
    const store = new InMemoryDestinationStore();
    const capture = captureOutput();
    const runner = buildDestinationsCreateRunner({
      issueId: () => "polaris_dst_tuned-audit",
      openStore: () => store.asCreateStore(),
    });
    await runner(
      {
        ...CREATE_BASE_ARGS,
        maxConcurrency: "32",
        maxRps: "500",
        retryPolicy: "aggressive",
        deadLetterThreshold: "12",
      },
      makeContext(capture.streams),
    );
    const audit = store.auditCalls[0];
    if (audit === undefined) throw new Error("expected one audit call");
    expect(audit.after).toMatchObject({
      max_concurrency: 32,
      max_rps: 500,
      retry_policy: "aggressive",
      dead_letter_threshold: 12,
    });
  });

  it("defaults the audit_id generator to a `polaris_aud_<uuidv7>` value", async () => {
    // Pin the canonical shape so a future refactor can't silently regress
    // to bare UUIDv7. The test does NOT inject `generateAuditId`, so the
    // runner uses its built-in default.
    const store = new InMemoryDestinationStore();
    const capture = captureOutput();
    const runner = buildDestinationsCreateRunner({
      issueId: () => "polaris_dst_audit-prefix",
      openStore: () => store.asCreateStore(),
    });
    await runner(CREATE_BASE_ARGS, makeContext(capture.streams));
    const audit = store.auditCalls[0];
    if (audit === undefined) throw new Error("expected one audit call");
    expect(audit.auditId).toMatch(
      /^polaris_aud_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("emits the same shape under --output json, with no credential in it", async () => {
    const store = new InMemoryDestinationStore();
    const capture = captureOutput();
    const runner = buildDestinationsCreateRunner({
      issueId: () => "polaris_dst_json-id",
      openStore: () => store.asCreateStore(),
    });
    await runner(CREATE_BASE_ARGS, jsonContext(capture.streams));
    const parsed = JSON.parse(capture.stdout.join(""));
    expect(parsed).toMatchObject({
      destination_id: "polaris_dst_json-id",
      project_id: "storefront",
      environment: "production",
      vendor: "meta-capi",
      instance_label: "storefront-prod",
      mode: "live",
    });
  });

  it("passes optional operational tuning fields through to the insert", async () => {
    const store = new InMemoryDestinationStore();
    const capture = captureOutput();
    const runner = buildDestinationsCreateRunner({
      issueId: () => "polaris_dst_tuned",
      openStore: () => store.asCreateStore(),
    });
    await runner(
      {
        ...CREATE_BASE_ARGS,
        maxConcurrency: "16",
        maxRps: "200",
        retryPolicy: "aggressive",
        deadLetterThreshold: "10",
      },
      makeContext(capture.streams),
    );
    const inserted = store.inserts[0];
    if (inserted === undefined) throw new Error("expected one insert");
    expect(inserted.max_concurrency).toBe(16);
    expect(inserted.max_rps).toBe(200);
    expect(inserted.retry_policy).toBe("aggressive");
    expect(inserted.dead_letter_threshold).toBe(10);
  });

  it("REJECTS a mapping-shaped flag BEFORE any DB write", async () => {
    // CRITICAL acceptance-criteria test: the hypothetical `--field-map`
    // flag must be refused and the store must remain untouched.
    const store = new InMemoryDestinationStore();
    const capture = captureOutput();
    const runner = buildDestinationsCreateRunner({
      issueId: () => "polaris_dst_should-not-exist",
      openStore: () => store.asCreateStore(),
    });
    await expect(
      runner(
        {
          ...CREATE_BASE_ARGS,
          // Cast through `unknown` so the type system would normally refuse this
          // — we're proving the runtime gate fires even if a future caller bypasses
          // the typed surface.
          ...({ fieldMap: "purchase.value=value" } as Record<string, string>),
        },
        makeContext(capture.streams),
      ),
    ).rejects.toMatchObject({ name: "UsageError" });
    expect(store.inserts).toHaveLength(0);
    expect(store.rows.size).toBe(0);
  });

  it("rejects an event-map flag too", async () => {
    const store = new InMemoryDestinationStore();
    const capture = captureOutput();
    const runner = buildDestinationsCreateRunner({
      openStore: () => store.asCreateStore(),
    });
    await expect(
      runner(
        {
          ...CREATE_BASE_ARGS,
          ...({ eventMap: "checkout.started -> CompletePayment" } as Record<string, string>),
        },
        makeContext(capture.streams),
      ),
    ).rejects.toMatchObject({ name: "UsageError" });
    expect(store.inserts).toHaveLength(0);
  });

  it("rejects unsupported --env values with a usage error", async () => {
    const store = new InMemoryDestinationStore();
    const capture = captureOutput();
    const runner = buildDestinationsCreateRunner({
      openStore: () => store.asCreateStore(),
    });
    await expect(
      runner({ ...CREATE_BASE_ARGS, env: "qa" }, makeContext(capture.streams)),
    ).rejects.toMatchObject({ name: "UsageError" });
  });

  it("rejects an empty --secret-value, before touching the store", async () => {
    // The inverse of what this test used to assert. It refused a plaintext
    // value by shape, because the column held a `provider:ref` pointer and a
    // bare string meant an operator had pasted a credential into the wrong
    // slot. Plaintext IS the value now; the only shape the platform can still
    // judge is emptiness, and a destination with no credential would fail
    // every delivery with an opaque vendor error.
    const store = new InMemoryDestinationStore();
    const capture = captureOutput();
    const runner = buildDestinationsCreateRunner({
      openStore: () => store.asCreateStore(),
    });
    await expect(
      runner({ ...CREATE_BASE_ARGS, secretValue: "   " }, makeContext(capture.streams)),
    ).rejects.toMatchObject({ name: "UsageError" });
    expect(store.inserts).toHaveLength(0);
  });

  it("never prints the credential it was given", async () => {
    // `create` is the one command an operator hands a live credential to, so
    // it is the one place a careless `emit` would echo one straight back into
    // terminal scrollback and CI logs.
    const store = new InMemoryDestinationStore();
    const capture = captureOutput();
    const runner = buildDestinationsCreateRunner({
      issueId: () => "polaris_dst_no-echo",
      openStore: () => store.asCreateStore(),
    });
    await runner(CREATE_BASE_ARGS, makeContext(capture.streams));
    expect(capture.stdout.join("")).not.toContain("EAAB-live-token");

    const jsonCapture = captureOutput();
    const jsonRunner = buildDestinationsCreateRunner({
      issueId: () => "polaris_dst_no-echo-2",
      openStore: () => store.asCreateStore(),
    });
    await jsonRunner(CREATE_BASE_ARGS, jsonContext(jsonCapture.streams));
    expect(jsonCapture.stdout.join("")).not.toContain("EAAB-live-token");
  });

  it("rejects unsupported --mode values", async () => {
    const store = new InMemoryDestinationStore();
    const capture = captureOutput();
    const runner = buildDestinationsCreateRunner({
      openStore: () => store.asCreateStore(),
    });
    await expect(
      runner({ ...CREATE_BASE_ARGS, mode: "ghost" }, makeContext(capture.streams)),
    ).rejects.toMatchObject({ name: "UsageError" });
  });

  it("rejects invalid vendor or instance-label shapes", async () => {
    const store = new InMemoryDestinationStore();
    const capture = captureOutput();
    const runner = buildDestinationsCreateRunner({
      openStore: () => store.asCreateStore(),
    });
    await expect(
      runner({ ...CREATE_BASE_ARGS, vendor: "META CAPI!" }, makeContext(capture.streams)),
    ).rejects.toMatchObject({ name: "UsageError" });
    await expect(
      runner({ ...CREATE_BASE_ARGS, instanceLabel: "BadLabel!" }, makeContext(capture.streams)),
    ).rejects.toMatchObject({ name: "UsageError" });
  });
});

describe("destinations list runner", () => {
  it("emits an empty-friendly message when no destinations match", async () => {
    const store = new InMemoryDestinationStore();
    const capture = captureOutput();
    const runner = buildDestinationsListRunner({ openStore: () => store.asListStore() });
    await runner({ project: "storefront", env: "production" }, makeContext(capture.streams));
    expect(capture.stdout.join("")).toContain("(no destinations");
  });

  it("returns matching rows scoped by (project, env)", async () => {
    const store = new InMemoryDestinationStore();
    seedActiveRow(store, { destination_id: "polaris_dst_one", vendor: "meta-capi" });
    seedActiveRow(store, { destination_id: "polaris_dst_two", vendor: "ga4" });
    seedActiveRow(store, {
      destination_id: "polaris_dst_other-env",
      environment: "staging",
      vendor: "meta-capi",
    });
    const capture = captureOutput();
    const runner = buildDestinationsListRunner({ openStore: () => store.asListStore() });
    await runner({ project: "storefront", env: "production" }, jsonContext(capture.streams));
    const parsed = JSON.parse(capture.stdout.join(""));
    expect(parsed.count).toBe(2);
    const ids = parsed.rows.map((r: { destination_id: string }) => r.destination_id);
    expect(ids).toContain("polaris_dst_one");
    expect(ids).toContain("polaris_dst_two");
    expect(ids).not.toContain("polaris_dst_other-env");
  });
});

describe("destinations show runner", () => {
  it("returns the row and exposes no credential field at all", async () => {
    const store = new InMemoryDestinationStore();
    seedActiveRow(store, { destination_id: "polaris_dst_show-me" });
    const capture = captureOutput();
    const runner = buildDestinationsShowRunner({ openStore: () => store.asShowStore() });
    await runner({ destinationId: "polaris_dst_show-me" }, makeContext(capture.streams));
    const stdout = capture.stdout.join("");
    expect(stdout).toContain("polaris_dst_show-me");
    expect(stdout).toContain("vendor                meta-capi");
    // This asserted the opposite until the column changed meaning: `show`
    // printed `secret_ref` because it named a vault entry, and seeing it was
    // how an operator confirmed the wiring. The same line would now print a
    // live credential to a terminal. `DestinationRow` no longer carries one.
    expect(stdout).not.toContain("secret");
  });

  it("raises a usage error when the id is unknown", async () => {
    const store = new InMemoryDestinationStore();
    const capture = captureOutput();
    const runner = buildDestinationsShowRunner({ openStore: () => store.asShowStore() });
    await expect(
      runner({ destinationId: "polaris_dst_missing" }, makeContext(capture.streams)),
    ).rejects.toMatchObject({ name: "UsageError" });
  });
});

describe("destinations enable runner", () => {
  it("transitions a paused destination to active", async () => {
    const store = new InMemoryDestinationStore();
    seedActiveRow(store, {
      destination_id: "polaris_dst_paused",
      status: "paused",
    });
    const now = new Date("2026-05-12T15:00:00.000Z");
    const capture = captureOutput();
    const runner = buildDestinationsEnableRunner({
      openStore: () => store.asEnableStore(),
      now: () => now,
    });
    await runner({ destinationId: "polaris_dst_paused" }, makeContext(capture.streams));
    const after = store.rows.get("polaris_dst_paused");
    expect(after?.status).toBe("active");
    expect(after?.disabled_reason).toBe(null);
    expect(capture.stdout.join("")).toContain("enabled polaris_dst_paused");
    // P6-006: audit row persisted (no more stderr TODO marker).
    expect(store.auditCalls).toHaveLength(1);
    expect(store.auditCalls[0]?.action).toBe("destinations.enable");
    expect(store.auditCalls[0]?.targetType).toBe("destination");
    expect(store.auditCalls[0]?.targetId).toBe("polaris_dst_paused");
    expect(store.auditCalls[0]?.actorSource).toBe("cli");
    expect(store.auditCalls[0]?.actorLabel).toBe("cli");
  });

  it("is idempotent on an already-active destination", async () => {
    const store = new InMemoryDestinationStore();
    seedActiveRow(store, { destination_id: "polaris_dst_active" });
    const capture = captureOutput();
    const runner = buildDestinationsEnableRunner({
      openStore: () => store.asEnableStore(),
    });
    await runner({ destinationId: "polaris_dst_active" }, makeContext(capture.streams));
    expect(capture.stdout.join("")).toContain("already active");
    // No audit row on the idempotent no-op path.
    expect(store.auditCalls).toHaveLength(0);
  });

  it("raises a usage error when the id is unknown", async () => {
    const store = new InMemoryDestinationStore();
    const capture = captureOutput();
    const runner = buildDestinationsEnableRunner({
      openStore: () => store.asEnableStore(),
    });
    await expect(
      runner({ destinationId: "polaris_dst_missing" }, makeContext(capture.streams)),
    ).rejects.toMatchObject({ name: "UsageError" });
  });
});

describe("destinations disable runner", () => {
  it("transitions an active destination to disabled with the supplied reason", async () => {
    const store = new InMemoryDestinationStore();
    seedActiveRow(store, { destination_id: "polaris_dst_to-disable" });
    const now = new Date("2026-05-12T16:00:00.000Z");
    const capture = captureOutput();
    const runner = buildDestinationsDisableRunner({
      openStore: () => store.asDisableStore(),
      now: () => now,
    });
    await runner(
      { destinationId: "polaris_dst_to-disable", reason: "incident response" },
      makeContext(capture.streams),
    );
    const after = store.rows.get("polaris_dst_to-disable");
    expect(after?.status).toBe("disabled");
    expect(after?.disabled_reason).toBe("incident response");
    expect(after?.updated_at).toBe(now.toISOString());
    expect(capture.stdout.join("")).toContain("disabled polaris_dst_to-disable");
    expect(capture.stdout.join("")).toContain("incident response");
    // P6-006: audit row persisted with the reason.
    expect(store.auditCalls).toHaveLength(1);
    expect(store.auditCalls[0]?.action).toBe("destinations.disable");
    expect(store.auditCalls[0]?.targetType).toBe("destination");
    expect(store.auditCalls[0]?.targetId).toBe("polaris_dst_to-disable");
    expect(store.auditCalls[0]?.actorSource).toBe("cli");
    expect(store.auditCalls[0]?.actorLabel).toBe("cli");
    expect(store.auditCalls[0]?.reason).toBe("incident response");
  });

  it("requires --reason", async () => {
    const store = new InMemoryDestinationStore();
    seedActiveRow(store, { destination_id: "polaris_dst_needs-reason" });
    const capture = captureOutput();
    const runner = buildDestinationsDisableRunner({
      openStore: () => store.asDisableStore(),
    });
    await expect(
      runner({ destinationId: "polaris_dst_needs-reason" }, makeContext(capture.streams)),
    ).rejects.toMatchObject({ name: "UsageError" });
  });

  it("is idempotent on an already-disabled destination and preserves the original reason", async () => {
    const store = new InMemoryDestinationStore();
    seedActiveRow(store, {
      destination_id: "polaris_dst_already-disabled",
      status: "disabled",
      disabled_reason: "first incident",
    });
    const capture = captureOutput();
    const runner = buildDestinationsDisableRunner({
      openStore: () => store.asDisableStore(),
    });
    await runner(
      {
        destinationId: "polaris_dst_already-disabled",
        reason: "second attempt",
      },
      makeContext(capture.streams),
    );
    const after = store.rows.get("polaris_dst_already-disabled");
    expect(after?.disabled_reason).toBe("first incident");
    expect(capture.stdout.join("")).toContain("already disabled");
  });

  it("REJECTS a mapping-shaped flag BEFORE any DB write", async () => {
    const store = new InMemoryDestinationStore();
    seedActiveRow(store, { destination_id: "polaris_dst_x" });
    const capture = captureOutput();
    const runner = buildDestinationsDisableRunner({
      openStore: () => store.asDisableStore(),
    });
    await expect(
      runner(
        {
          destinationId: "polaris_dst_x",
          reason: "operator decision",
          // smuggled mapping flag
          ...({ fieldMap: "x=y" } as Record<string, string>),
        },
        makeContext(capture.streams),
      ),
    ).rejects.toMatchObject({ name: "UsageError" });
    const after = store.rows.get("polaris_dst_x");
    expect(after?.status).toBe("active"); // unchanged
  });
});

describe("destinations rotate-secret runner", () => {
  const ROTATE_ARGS = {
    destinationId: "polaris_dst_active-1",
    secretValue: '{"pixel_id":"123","access_token":"EAAB-rotated"}',
    reason: "leaked in a support ticket",
  };

  it("replaces the credential and writes one audit row", async () => {
    const store = new InMemoryDestinationStore();
    seedActiveRow(store);
    const capture = captureOutput();
    const now = new Date("2026-08-13T15:00:00.000Z");
    const runner = buildDestinationsRotateSecretRunner({
      openStore: () => store.asRotateSecretStore(),
      now: () => now,
      generateAuditId: () => "audit-rotate-1",
    });

    await runner(ROTATE_ARGS, makeContext(capture.streams));

    expect(store.secrets.get("polaris_dst_active-1")).toBe(ROTATE_ARGS.secretValue);
    expect(store.rows.get("polaris_dst_active-1")?.updated_at).toBe(now.toISOString());
    expect(store.auditCalls).toHaveLength(1);
    const audit = store.auditCalls[0];
    expect(audit?.action).toBe("destinations.rotate-secret");
    expect(audit?.reason).toBe(ROTATE_ARGS.reason);
  });

  it("puts no credential in the audit row, on either side", async () => {
    // The audit row is the durable artifact of a rotation and must not become
    // a copy of the value being rotated away from OR to. `before` and `after`
    // are identical here by design — the only field that changed is the one
    // this log may not hold.
    const store = new InMemoryDestinationStore();
    seedActiveRow(store);
    const capture = captureOutput();
    const runner = buildDestinationsRotateSecretRunner({
      openStore: () => store.asRotateSecretStore(),
    });

    await runner(ROTATE_ARGS, makeContext(capture.streams));

    const audit = store.auditCalls[0];
    expect(JSON.stringify(audit?.before)).not.toContain("EAAB-rotated");
    expect(JSON.stringify(audit?.after)).not.toContain("EAAB-rotated");
    expect(audit?.before).toEqual(audit?.after);
  });

  it("never echoes the new credential to stdout", async () => {
    const store = new InMemoryDestinationStore();
    seedActiveRow(store);
    const capture = captureOutput();
    const runner = buildDestinationsRotateSecretRunner({
      openStore: () => store.asRotateSecretStore(),
    });

    await runner(ROTATE_ARGS, makeContext(capture.streams));
    expect(capture.stdout.join("")).not.toContain("EAAB-rotated");

    const jsonCapture = captureOutput();
    const jsonRunner = buildDestinationsRotateSecretRunner({
      openStore: () => store.asRotateSecretStore(),
    });
    await jsonRunner(ROTATE_ARGS, jsonContext(jsonCapture.streams));
    expect(jsonCapture.stdout.join("")).not.toContain("EAAB-rotated");
  });

  it("requires --reason and never touches the row when omitted", async () => {
    const store = new InMemoryDestinationStore();
    seedActiveRow(store);
    const capture = captureOutput();
    const runner = buildDestinationsRotateSecretRunner({
      openStore: () => store.asRotateSecretStore(),
    });

    await expect(
      runner({ ...ROTATE_ARGS, reason: undefined }, makeContext(capture.streams)),
    ).rejects.toMatchObject({ name: "UsageError" });
    expect(store.secrets.size).toBe(0);
    expect(store.auditCalls).toHaveLength(0);
  });

  it("rejects an empty --secret-value before touching the row", async () => {
    const store = new InMemoryDestinationStore();
    seedActiveRow(store);
    const capture = captureOutput();
    const runner = buildDestinationsRotateSecretRunner({
      openStore: () => store.asRotateSecretStore(),
    });

    await expect(
      runner({ ...ROTATE_ARGS, secretValue: "   " }, makeContext(capture.streams)),
    ).rejects.toMatchObject({ name: "UsageError" });
    expect(store.secrets.size).toBe(0);
  });

  it("raises a usage error when the destination id is unknown", async () => {
    const store = new InMemoryDestinationStore();
    const capture = captureOutput();
    const runner = buildDestinationsRotateSecretRunner({
      openStore: () => store.asRotateSecretStore(),
    });

    await expect(
      runner(
        { ...ROTATE_ARGS, destinationId: "polaris_dst_missing" },
        makeContext(capture.streams),
      ),
    ).rejects.toMatchObject({ name: "UsageError" });
    expect(store.auditCalls).toHaveLength(0);
  });

  it("REJECTS a mapping-shaped flag BEFORE any DB write", async () => {
    const store = new InMemoryDestinationStore();
    seedActiveRow(store);
    const capture = captureOutput();
    const runner = buildDestinationsRotateSecretRunner({
      openStore: () => store.asRotateSecretStore(),
    });

    await expect(
      runner({ ...ROTATE_ARGS, fieldMap: "event->vendor" } as never, makeContext(capture.streams)),
    ).rejects.toMatchObject({ name: "UsageError" });
    expect(store.secrets.size).toBe(0);
  });
});

describe("destinations update-ops runner", () => {
  it("updates only operational tuning fields", async () => {
    const store = new InMemoryDestinationStore();
    seedActiveRow(store, {
      destination_id: "polaris_dst_to-tune",
      max_concurrency: 4,
      max_rps: 50,
      retry_policy: "standard",
      dead_letter_threshold: 5,
    });
    const now = new Date("2026-05-12T17:00:00.000Z");
    const capture = captureOutput();
    const runner = buildDestinationsUpdateOpsRunner({
      openStore: () => store.asUpdateOpsStore(),
      now: () => now,
      generateAuditId: () => "audit-update-1",
    });
    await runner(
      {
        destinationId: "polaris_dst_to-tune",
        maxConcurrency: "16",
        maxRps: "250",
        retryPolicy: "aggressive",
        deadLetterThreshold: "9",
        reason: "scaling for Black Friday",
      },
      makeContext(capture.streams),
    );
    const after = store.rows.get("polaris_dst_to-tune");
    expect(after?.max_concurrency).toBe(16);
    expect(after?.max_rps).toBe(250);
    expect(after?.retry_policy).toBe("aggressive");
    expect(after?.dead_letter_threshold).toBe(9);
    expect(after?.updated_at).toBe(now.toISOString());
    // Non-tuning fields untouched.
    expect(after?.status).toBe("active");
    expect(after?.mode).toBe("live");
    expect(capture.stdout.join("")).toContain("updated polaris_dst_to-tune");

    // P6-006 follow-up: audit row persisted with before/after and reason.
    expect(store.auditCalls).toHaveLength(1);
    const audit = store.auditCalls[0];
    if (audit === undefined) throw new Error("expected one audit call");
    expect(audit.action).toBe("destinations.update-ops");
    expect(audit.auditId).toBe("audit-update-1");
    expect(audit.targetType).toBe("destination");
    expect(audit.targetId).toBe("polaris_dst_to-tune");
    expect(audit.actorSource).toBe("cli");
    expect(audit.actorLabel).toBe("cli");
    expect(audit.projectId).toBe("storefront");
    expect(audit.environment).toBe("production");
    expect(audit.reason).toBe("scaling for Black Friday");
    expect(audit.before).toMatchObject({
      destination_id: "polaris_dst_to-tune",
      max_concurrency: 4,
      max_rps: 50,
      retry_policy: "standard",
      dead_letter_threshold: 5,
    });
    expect(audit.after).toMatchObject({
      destination_id: "polaris_dst_to-tune",
      max_concurrency: 16,
      max_rps: 250,
      retry_policy: "aggressive",
      dead_letter_threshold: 9,
    });
  });

  it("requires --reason", async () => {
    const store = new InMemoryDestinationStore();
    seedActiveRow(store, { destination_id: "polaris_dst_needs-reason" });
    const capture = captureOutput();
    const runner = buildDestinationsUpdateOpsRunner({
      openStore: () => store.asUpdateOpsStore(),
    });
    await expect(
      runner(
        { destinationId: "polaris_dst_needs-reason", maxConcurrency: "8" },
        makeContext(capture.streams),
      ),
    ).rejects.toMatchObject({ name: "UsageError" });
    // No update issued.
    expect(store.updateCalls).toBe(0);
  });

  it("rejects calls with zero operational flags", async () => {
    const store = new InMemoryDestinationStore();
    seedActiveRow(store, { destination_id: "polaris_dst_noflags" });
    const capture = captureOutput();
    const runner = buildDestinationsUpdateOpsRunner({
      openStore: () => store.asUpdateOpsStore(),
    });
    await expect(
      runner(
        { destinationId: "polaris_dst_noflags", reason: "operator decision" },
        makeContext(capture.streams),
      ),
    ).rejects.toMatchObject({ name: "UsageError" });
    // No update issued.
    expect(store.updateCalls).toBe(0);
  });

  it("rejects --max-concurrency values outside the supported range", async () => {
    const store = new InMemoryDestinationStore();
    seedActiveRow(store, { destination_id: "polaris_dst_overlimit" });
    const capture = captureOutput();
    const runner = buildDestinationsUpdateOpsRunner({
      openStore: () => store.asUpdateOpsStore(),
    });
    await expect(
      runner(
        {
          destinationId: "polaris_dst_overlimit",
          maxConcurrency: "9999",
          reason: "operator decision",
        },
        makeContext(capture.streams),
      ),
    ).rejects.toMatchObject({ name: "UsageError" });
  });

  it("REJECTS a mapping-shaped flag BEFORE any DB write — the acceptance-criteria gate", async () => {
    // The architectural guarantee: even if a future caller smuggles a
    // mapping-shaped flag in, the runner refuses BEFORE any DB write.
    const store = new InMemoryDestinationStore();
    seedActiveRow(store, {
      destination_id: "polaris_dst_no-mapping",
      max_concurrency: 4,
    });
    const capture = captureOutput();
    const runner = buildDestinationsUpdateOpsRunner({
      openStore: () => store.asUpdateOpsStore(),
    });
    await expect(
      runner(
        {
          destinationId: "polaris_dst_no-mapping",
          maxConcurrency: "8",
          reason: "operator decision",
          // smuggled mapping flag
          ...({ fieldMap: "purchase.value=value" } as Record<string, string>),
        },
        makeContext(capture.streams),
      ),
    ).rejects.toMatchObject({ name: "UsageError" });
    // Update never happened.
    expect(store.updateCalls).toBe(0);
    const after = store.rows.get("polaris_dst_no-mapping");
    expect(after?.max_concurrency).toBe(4);
  });

  it("rejects every documented forbidden token", async () => {
    const store = new InMemoryDestinationStore();
    seedActiveRow(store, { destination_id: "polaris_dst_token-test" });
    const capture = captureOutput();
    const runner = buildDestinationsUpdateOpsRunner({
      openStore: () => store.asUpdateOpsStore(),
    });
    for (const token of FORBIDDEN_MAPPING_FLAG_TOKENS) {
      const camel = token.replace(/[-_](.)/g, (_, ch: string) => ch.toUpperCase());
      await expect(
        runner(
          {
            destinationId: "polaris_dst_token-test",
            maxConcurrency: "8",
            reason: "operator decision",
            ...({ [camel]: "forbidden" } as Record<string, string>),
          },
          makeContext(capture.streams),
        ),
      ).rejects.toMatchObject({ name: "UsageError" });
    }
    expect(store.updateCalls).toBe(0);
  });
});

describe("destinations enable-replay runner (P7-004)", () => {
  // The acceptance criterion: the CLI requires an explicit reason flag to
  // flip replay opt-in on, writes a structured audit row in the same
  // transaction as the row UPDATE, and is idempotent against repeats.
  it("flips replay_opt_in on a destination that was opted out", async () => {
    const store = new InMemoryDestinationStore();
    seedActiveRow(store, { destination_id: "polaris_dst_to-opt-in" });
    const now = new Date("2026-05-14T10:00:00.000Z");
    const capture = captureOutput();
    const runner = buildDestinationsEnableReplayRunner({
      openStore: () => store.asEnableReplayStore(),
      now: () => now,
      generateAuditId: () => "polaris_aud_enable-replay-1",
    });
    await runner(
      {
        destinationId: "polaris_dst_to-opt-in",
        reason: "running attribution replay for storefront-prod",
      },
      makeContext(capture.streams),
    );
    const after = store.rows.get("polaris_dst_to-opt-in");
    expect(after?.replay_opt_in).toBe(true);
    expect(after?.replay_opt_in_reason).toBe("running attribution replay for storefront-prod");
    expect(after?.replay_opt_in_at).toBe(now.toISOString());
    expect(after?.updated_at).toBe(now.toISOString());
    expect(capture.stdout.join("")).toContain("replay opt-in enabled for polaris_dst_to-opt-in");
    expect(capture.stdout.join("")).toContain("running attribution replay");

    // P7-004 audit row: action + reason + before/after snapshot.
    expect(store.auditCalls).toHaveLength(1);
    const audit = store.auditCalls[0];
    if (audit === undefined) throw new Error("expected one audit call");
    expect(audit.action).toBe("destinations.enable-replay");
    expect(audit.auditId).toBe("polaris_aud_enable-replay-1");
    expect(audit.targetType).toBe("destination");
    expect(audit.targetId).toBe("polaris_dst_to-opt-in");
    expect(audit.actorSource).toBe("cli");
    expect(audit.actorLabel).toBe("cli");
    expect(audit.projectId).toBe("storefront");
    expect(audit.environment).toBe("production");
    expect(audit.reason).toBe("running attribution replay for storefront-prod");
    expect(audit.before).toMatchObject({
      destination_id: "polaris_dst_to-opt-in",
      replay_opt_in: false,
      replay_opt_in_reason: null,
      replay_opt_in_at: null,
    });
    expect(audit.after).toMatchObject({
      destination_id: "polaris_dst_to-opt-in",
      replay_opt_in: true,
      replay_opt_in_reason: "running attribution replay for storefront-prod",
      replay_opt_in_at: now.toISOString(),
    });
  });

  it("requires --reason and never touches the row when omitted", async () => {
    const store = new InMemoryDestinationStore();
    seedActiveRow(store, { destination_id: "polaris_dst_no-reason" });
    const capture = captureOutput();
    const runner = buildDestinationsEnableReplayRunner({
      openStore: () => store.asEnableReplayStore(),
    });
    await expect(
      runner({ destinationId: "polaris_dst_no-reason" }, makeContext(capture.streams)),
    ).rejects.toMatchObject({ name: "UsageError" });
    const after = store.rows.get("polaris_dst_no-reason");
    expect(after?.replay_opt_in).toBe(false);
    expect(store.auditCalls).toHaveLength(0);
  });

  it("is idempotent on an already-opted-in destination and preserves the original reason + timestamp", async () => {
    const store = new InMemoryDestinationStore();
    seedActiveRow(store, {
      destination_id: "polaris_dst_already-in",
      replay_opt_in: true,
      replay_opt_in_reason: "first opt-in",
      replay_opt_in_at: "2026-05-10T08:00:00.000Z",
    });
    const capture = captureOutput();
    const runner = buildDestinationsEnableReplayRunner({
      openStore: () => store.asEnableReplayStore(),
    });
    await runner(
      {
        destinationId: "polaris_dst_already-in",
        reason: "second attempt",
      },
      makeContext(capture.streams),
    );
    const after = store.rows.get("polaris_dst_already-in");
    expect(after?.replay_opt_in).toBe(true);
    // Original reason and timestamp preserved on the idempotent path.
    expect(after?.replay_opt_in_reason).toBe("first opt-in");
    expect(after?.replay_opt_in_at).toBe("2026-05-10T08:00:00.000Z");
    expect(capture.stdout.join("")).toContain("already opted in");
    expect(store.auditCalls).toHaveLength(0);
  });

  it("raises a usage error when the destination id is unknown", async () => {
    const store = new InMemoryDestinationStore();
    const capture = captureOutput();
    const runner = buildDestinationsEnableReplayRunner({
      openStore: () => store.asEnableReplayStore(),
    });
    await expect(
      runner({ destinationId: "polaris_dst_missing", reason: "x" }, makeContext(capture.streams)),
    ).rejects.toMatchObject({ name: "UsageError" });
    expect(store.auditCalls).toHaveLength(0);
  });

  it("REJECTS a mapping-shaped flag BEFORE any DB write", async () => {
    const store = new InMemoryDestinationStore();
    seedActiveRow(store, { destination_id: "polaris_dst_smuggle" });
    const capture = captureOutput();
    const runner = buildDestinationsEnableReplayRunner({
      openStore: () => store.asEnableReplayStore(),
    });
    await expect(
      runner(
        {
          destinationId: "polaris_dst_smuggle",
          reason: "operator decision",
          ...({ fieldMap: "x=y" } as Record<string, string>),
        },
        makeContext(capture.streams),
      ),
    ).rejects.toMatchObject({ name: "UsageError" });
    const after = store.rows.get("polaris_dst_smuggle");
    expect(after?.replay_opt_in).toBe(false);
    expect(store.auditCalls).toHaveLength(0);
  });

  it("rejects --reason values longer than 1024 chars", async () => {
    const store = new InMemoryDestinationStore();
    seedActiveRow(store, { destination_id: "polaris_dst_too-long" });
    const capture = captureOutput();
    const runner = buildDestinationsEnableReplayRunner({
      openStore: () => store.asEnableReplayStore(),
    });
    await expect(
      runner(
        { destinationId: "polaris_dst_too-long", reason: "x".repeat(1025) },
        makeContext(capture.streams),
      ),
    ).rejects.toMatchObject({ name: "UsageError" });
  });

  it("emits JSON output that pins the contract shape", async () => {
    const store = new InMemoryDestinationStore();
    seedActiveRow(store, { destination_id: "polaris_dst_json-shape" });
    const now = new Date("2026-05-14T10:30:00.000Z");
    const capture = captureOutput();
    const runner = buildDestinationsEnableReplayRunner({
      openStore: () => store.asEnableReplayStore(),
      now: () => now,
    });
    await runner(
      {
        destinationId: "polaris_dst_json-shape",
        reason: "test reason",
      },
      jsonContext(capture.streams),
    );
    const parsed = JSON.parse(capture.stdout.join(""));
    expect(parsed).toMatchObject({
      destination_id: "polaris_dst_json-shape",
      applied: true,
      replay_opt_in: true,
      reason: "test reason",
      replay_opt_in_at: now.toISOString(),
    });
  });
});

describe("destinations disable-replay runner (P7-004)", () => {
  it("flips replay_opt_in back on a destination that was opted in", async () => {
    const store = new InMemoryDestinationStore();
    seedActiveRow(store, {
      destination_id: "polaris_dst_to-opt-out",
      replay_opt_in: true,
      replay_opt_in_reason: "original opt-in reason",
      replay_opt_in_at: "2026-05-10T08:00:00.000Z",
    });
    const now = new Date("2026-05-14T11:00:00.000Z");
    const capture = captureOutput();
    const runner = buildDestinationsDisableReplayRunner({
      openStore: () => store.asDisableReplayStore(),
      now: () => now,
      generateAuditId: () => "polaris_aud_disable-replay-1",
    });
    await runner(
      {
        destinationId: "polaris_dst_to-opt-out",
        reason: "replay run completed; tightening back",
      },
      makeContext(capture.streams),
    );
    const after = store.rows.get("polaris_dst_to-opt-out");
    expect(after?.replay_opt_in).toBe(false);
    expect(after?.replay_opt_in_reason).toBe("replay run completed; tightening back");
    // P7-004: replay_opt_in_at is preserved on disable so operators see
    // the last time replay was active.
    expect(after?.replay_opt_in_at).toBe("2026-05-10T08:00:00.000Z");
    expect(after?.updated_at).toBe(now.toISOString());
    expect(capture.stdout.join("")).toContain("replay opt-in disabled for polaris_dst_to-opt-out");
    expect(capture.stdout.join("")).toContain("tightening back");

    // P7-004 audit row.
    expect(store.auditCalls).toHaveLength(1);
    const audit = store.auditCalls[0];
    if (audit === undefined) throw new Error("expected one audit call");
    expect(audit.action).toBe("destinations.disable-replay");
    expect(audit.targetId).toBe("polaris_dst_to-opt-out");
    expect(audit.reason).toBe("replay run completed; tightening back");
    expect(audit.before).toMatchObject({
      destination_id: "polaris_dst_to-opt-out",
      replay_opt_in: true,
      replay_opt_in_reason: "original opt-in reason",
    });
    expect(audit.after).toMatchObject({
      destination_id: "polaris_dst_to-opt-out",
      replay_opt_in: false,
      replay_opt_in_reason: "replay run completed; tightening back",
      // replay_opt_in_at is preserved on the after-snapshot.
      replay_opt_in_at: "2026-05-10T08:00:00.000Z",
    });
  });

  it("requires --reason", async () => {
    const store = new InMemoryDestinationStore();
    seedActiveRow(store, {
      destination_id: "polaris_dst_no-reason-d",
      replay_opt_in: true,
      replay_opt_in_reason: "needed reason",
      replay_opt_in_at: "2026-05-10T08:00:00.000Z",
    });
    const capture = captureOutput();
    const runner = buildDestinationsDisableReplayRunner({
      openStore: () => store.asDisableReplayStore(),
    });
    await expect(
      runner({ destinationId: "polaris_dst_no-reason-d" }, makeContext(capture.streams)),
    ).rejects.toMatchObject({ name: "UsageError" });
    expect(store.auditCalls).toHaveLength(0);
  });

  it("is idempotent on an already-opted-out destination", async () => {
    const store = new InMemoryDestinationStore();
    seedActiveRow(store, {
      destination_id: "polaris_dst_already-out",
      replay_opt_in: false,
      replay_opt_in_reason: null,
      replay_opt_in_at: null,
    });
    const capture = captureOutput();
    const runner = buildDestinationsDisableReplayRunner({
      openStore: () => store.asDisableReplayStore(),
    });
    await runner(
      {
        destinationId: "polaris_dst_already-out",
        reason: "no-op",
      },
      makeContext(capture.streams),
    );
    const after = store.rows.get("polaris_dst_already-out");
    expect(after?.replay_opt_in).toBe(false);
    expect(capture.stdout.join("")).toContain("already opted out");
    expect(store.auditCalls).toHaveLength(0);
  });

  it("raises a usage error when the destination id is unknown", async () => {
    const store = new InMemoryDestinationStore();
    const capture = captureOutput();
    const runner = buildDestinationsDisableReplayRunner({
      openStore: () => store.asDisableReplayStore(),
    });
    await expect(
      runner({ destinationId: "polaris_dst_missing", reason: "x" }, makeContext(capture.streams)),
    ).rejects.toMatchObject({ name: "UsageError" });
    expect(store.auditCalls).toHaveLength(0);
  });

  it("REJECTS a mapping-shaped flag BEFORE any DB write", async () => {
    const store = new InMemoryDestinationStore();
    seedActiveRow(store, {
      destination_id: "polaris_dst_disable-smuggle",
      replay_opt_in: true,
      replay_opt_in_reason: "x",
      replay_opt_in_at: "2026-05-10T08:00:00.000Z",
    });
    const capture = captureOutput();
    const runner = buildDestinationsDisableReplayRunner({
      openStore: () => store.asDisableReplayStore(),
    });
    await expect(
      runner(
        {
          destinationId: "polaris_dst_disable-smuggle",
          reason: "operator decision",
          ...({ fieldMap: "x=y" } as Record<string, string>),
        },
        makeContext(capture.streams),
      ),
    ).rejects.toMatchObject({ name: "UsageError" });
    const after = store.rows.get("polaris_dst_disable-smuggle");
    // Unchanged.
    expect(after?.replay_opt_in).toBe(true);
    expect(store.auditCalls).toHaveLength(0);
  });
});

describe("destinations command surface mutates flags", () => {
  it("declares mutates: true on writers and mutates: false on read commands", async () => {
    const mod = await import("../src/index.js");
    expect(mod.destinationsListCommand.mutates).toBe(false);
    expect(mod.destinationsShowCommand.mutates).toBe(false);
    expect(mod.destinationsCreateCommand.mutates).toBe(true);
    expect(mod.destinationsEnableCommand.mutates).toBe(true);
    expect(mod.destinationsDisableCommand.mutates).toBe(true);
    expect(mod.destinationsUpdateOpsCommand.mutates).toBe(true);
    // P7-004: replay guardrails.
    expect(mod.destinationsEnableReplayCommand.mutates).toBe(true);
    expect(mod.destinationsDisableReplayCommand.mutates).toBe(true);
  });

  it("destinationsCommand group reports mutates: false (children declare their own)", async () => {
    const mod = await import("../src/index.js");
    expect(mod.destinationsCommand.mutates).toBe(false);
  });
});

describe("destinations command dispatcher wiring", () => {
  it("`polaris destinations --help` lists all eight subcommands", async () => {
    const capture = captureOutput();
    const code = await run({
      argv: ["destinations", "--help"],
      env: { ...VALID_ENV },
      output: capture.streams,
      meta: META,
    });
    expect(code).toBe(ExitCode.Ok);
    const help = capture.stdout.join("");
    expect(help).toContain("list");
    expect(help).toContain("show");
    expect(help).toContain("create");
    expect(help).toContain("enable");
    expect(help).toContain("disable");
    expect(help).toContain("update-ops");
    // P7-004 replay guardrail commands.
    expect(help).toContain("enable-replay");
    expect(help).toContain("disable-replay");
  });

  it("help text emphasises the no-mapping rule", async () => {
    const capture = captureOutput();
    const code = await run({
      argv: ["destinations", "--help"],
      env: { ...VALID_ENV },
      output: capture.streams,
      meta: META,
    });
    expect(code).toBe(ExitCode.Ok);
    // As in processors-commands.test.ts: this pinned the pre-move path and
    // so preserved it. Mappers are one file now, not a directory.
    expect(capture.stdout.join("")).toMatch(
      /sync\/destinations\/<vendor>\/<version>\/src\/mapper\.ts/,
    );
  });
});

/**
 * Schema-level invariant: the Kysely `DestinationsTable` interface in
 * `@polaris/persistence-postgres` MUST NOT carry any column resembling a mapping
 * field. This is the "Tests protect against semantic mapping fields
 * entering the DB model" criterion from the task card.
 *
 * The check is structural: we import the persistence-postgres source and inspect the
 * column set the typed surface exposes through `InsertDestinationInput`
 * (the only shape the CLI write path accepts). Any future refactor that
 * adds a `field_map`-shaped column would surface here.
 */
describe("schema invariant: no mapping fields on DestinationsTable", () => {
  it("rejects every forbidden mapping token across the InsertDestinationInput shape", () => {
    // Build a probe object listing every legal Insert key the production
    // code path uses. If a future change adds a column resembling a
    // mapping field, the maintainer must add it here AND the assertion
    // below will fail loudly so they reconsider.
    const insertKeys = [
      "destination_id",
      "project_id",
      "environment",
      "vendor",
      "instance_label",
      "secret_value",
      "mode",
      "max_concurrency",
      "max_rps",
      "retry_policy",
      "dead_letter_threshold",
    ];
    for (const key of insertKeys) {
      const normalised = key.toLowerCase().replace(/_/g, "-");
      expect(FORBIDDEN_MAPPING_FLAG_TOKENS).not.toContain(normalised);
      expect(FORBIDDEN_MAPPING_FLAG_TOKENS).not.toContain(key);
    }
  });

  it("treats `config` as a legal column while keeping every mapping token forbidden", () => {
    // `config` (20260813000002) carries consumer-interpreted per-instance
    // values such as pixel_id. It is a legal column name and must NOT join
    // the forbidden list.
    expect(FORBIDDEN_MAPPING_FLAG_TOKENS).not.toContain("config");

    // But note what changed underneath this guarantee. Before `config`
    // existed, "the CLI cannot store mapping semantics" was enforced purely
    // structurally: the schema had nowhere to put them. `config` is a jsonb
    // bag, so a caller could smuggle `{"field_map": {...}}` INSIDE it without
    // adding a column. Column absence alone no longer carries the invariant.
    //
    // The compensating control is that every forbidden token stays forbidden
    // as a KEY, which the write path must enforce against config's keys — not
    // only against CLI flag names. Until the config write path lands, nothing
    // can write this column, so the guarantee holds by inaccessibility.
    for (const token of FORBIDDEN_MAPPING_FLAG_TOKENS) {
      expect(token).not.toBe("config");
    }
  });

  it("rejects mapping tokens on UpdateDestinationOpsInput", () => {
    // Same probe for the update path. Adding a column resembling mapping
    // semantics to the ops-update repository surface fails this gate.
    const updateKeys = ["max_concurrency", "max_rps", "retry_policy", "dead_letter_threshold"];
    for (const key of updateKeys) {
      const normalised = key.toLowerCase().replace(/_/g, "-");
      expect(FORBIDDEN_MAPPING_FLAG_TOKENS).not.toContain(normalised);
    }
  });

  it("the DestinationRow read-shape exposes no field whose name matches a mapping token", () => {
    // Construct one shape exemplar and assert against its keys. This
    // doubles as type-level documentation of the read surface.
    const exemplar: DestinationRow = {
      destination_id: "polaris_dst_x",
      project_id: "p",
      environment: "production",
      vendor: "meta-capi",
      instance_label: "x",
      secret_value: "env:X",
      status: "active",
      mode: "live",
      max_concurrency: 1,
      max_rps: 1,
      retry_policy: "standard",
      dead_letter_threshold: 1,
      disabled_reason: null,
      replay_opt_in: false,
      replay_opt_in_reason: null,
      replay_opt_in_at: null,
      created_at: "2026-05-12T00:00:00.000Z",
      updated_at: "2026-05-12T00:00:00.000Z",
    };
    for (const key of Object.keys(exemplar)) {
      const normalised = key.toLowerCase().replace(/_/g, "-");
      expect(FORBIDDEN_MAPPING_FLAG_TOKENS).not.toContain(normalised);
    }
  });

  it("the destinations migration SQL declares the P7-004 replay-opt-in columns", async () => {
    // Schema-level smoke for P7-004: the follow-up migration must add the
    // per-instance opt-in trio (`replay_opt_in`, `replay_opt_in_reason`,
    // `replay_opt_in_at`) and a CHECK constraint that refuses an opted-in
    // row without a reason.
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const migrationPath = join(
      here,
      "..",
      "..",
      "..",
      "db",
      "postgres",
      "migrations",
      "20260514000002_add_destination_replay_opt_in.sql",
    );
    const sql = await readFile(migrationPath, "utf8");
    expect(sql).toMatch(/-- migrate:up/);
    expect(sql).toMatch(/-- migrate:down/);
    expect(sql).toMatch(/ADD COLUMN replay_opt_in\s+boolean\s+NOT NULL DEFAULT false/);
    expect(sql).toMatch(/ADD COLUMN replay_opt_in_reason\s+text/);
    expect(sql).toMatch(/ADD COLUMN replay_opt_in_at\s+timestamptz/);
    expect(sql).toMatch(/destinations_replay_opt_in_reason_when_enabled/);
    expect(sql).toMatch(/destinations_replay_opt_in_reason_length/);
  });

  it("the destinations migration SQL declares no mapping-shaped column", async () => {
    // Last-line-of-defence schema check: read the live migration file off
    // disk and assert no mapping-shaped column name appears in the CREATE
    // TABLE definition. Catches a maintainer who adds a column to the
    // migration but forgets to update the typed interface.
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const migrationPath = join(
      here,
      "..",
      "..",
      "..",
      "db",
      "postgres",
      "migrations",
      "20260512000005_create_destinations.sql",
    );
    const sql = await readFile(migrationPath, "utf8");
    // Inspect the column section between CREATE TABLE and the closing
    // paren before `-- migrate:down`. We split on the constraint markers
    // because the constraint *names* legitimately include the word "format"
    // and we only care about column declarations.
    const createTableMatch = sql.match(/CREATE TABLE destinations \(([\s\S]*?)\);/);
    expect(createTableMatch).not.toBeNull();
    const body = createTableMatch?.[1] ?? "";
    // Pull out lines that look like column declarations (start with a
    // lowercase identifier followed by whitespace then a type, not the
    // `CONSTRAINT` or `PRIMARY KEY` keywords).
    const columnLines = body
      .split("\n")
      .map((line) => line.trim())
      .filter(
        (line) =>
          line.length > 0 &&
          !line.startsWith("--") &&
          !line.toUpperCase().startsWith("CONSTRAINT") &&
          !line.toUpperCase().startsWith("PRIMARY KEY") &&
          !line.toUpperCase().startsWith("UNIQUE") &&
          !line.toUpperCase().startsWith("CHECK"),
      );
    expect(columnLines.length).toBeGreaterThan(0);
    const columnNames = columnLines.map((line) => {
      const match = line.match(/^([a-z_][a-z0-9_]*)/);
      return match?.[1] ?? "";
    });
    for (const name of columnNames) {
      if (name === "") continue;
      const kebab = name.replace(/_/g, "-");
      expect(FORBIDDEN_MAPPING_FLAG_TOKENS).not.toContain(kebab);
      expect(FORBIDDEN_MAPPING_FLAG_TOKENS).not.toContain(name);
    }
  });
});
