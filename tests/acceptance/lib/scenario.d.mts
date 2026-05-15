/**
 * TypeScript surface for the acceptance scenario runner.
 *
 * Declared alongside `scenario.mjs` so the Vitest wrapper and any
 * future consumer can import the runner with full type safety without
 * forcing the harness itself to be authored in `.ts`. The harness is
 * a runtime artifact: tools that have not built the workspace must
 * still be able to `node tests/acceptance/lib/scenario.mjs` it (or be
 * able to import it from the runner script). Keeping the runtime in
 * `.mjs` preserves that property; this companion `.d.mts` lets the
 * scenario test enjoy types.
 */

export type AcceptanceVerdict = "pass" | "fail";

export type AcceptanceStepStatus = "pending" | "pass" | "fail" | "skip";

export interface AcceptanceStepResult {
  readonly id: string;
  readonly label: string;
  readonly status: AcceptanceStepStatus;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly elapsedMs: number;
  readonly detail: unknown;
  readonly error: string | undefined;
}

export interface AcceptanceScenarioConfig {
  readonly ingesterUrl: string;
  readonly projectId: string;
  readonly environment: string;
  readonly sourceId: string;
  readonly sourceType: string;
  readonly vendor: string;
  readonly instanceLabel: string;
  readonly webhookEndpoint: string;
  readonly skipDestination: boolean;
  readonly pollTimeoutMs: number;
  readonly pollIntervalMs: number;
  readonly clickhouse: { readonly url: string; readonly user: string; readonly password: string };
  readonly databaseUrl: string;
  readonly artifacts: ResolvedRepoArtifacts;
  readonly env: NodeJS.ProcessEnv;
}

export interface AcceptanceScenarioState {
  apiKey: string | undefined;
  apiKeyId: string | undefined;
  eventId: string | undefined;
  destinationId: string | undefined;
  replayJobId: string | undefined;
  replayPlanJson: unknown;
  clickhouseRow: unknown;
  deliveryRecord: unknown;
  webhookHits: number;
}

export interface AcceptanceScenarioOutcome {
  readonly verdict: AcceptanceVerdict;
  readonly results: AcceptanceStepResult[];
  readonly state: AcceptanceScenarioState;
  readonly config: AcceptanceScenarioConfig;
}

export interface ResolvedRepoArtifacts {
  readonly repoRoot: string;
  readonly cliBin: string;
  readonly runbook: string;
  readonly dlqRunbook: string;
  readonly backupRunbook: string;
  readonly topicIsolationRunbook: string;
  readonly observabilityDoc: string;
}

export interface ScenarioLogger {
  info(message: string): void;
  error(message: string): void;
}

export interface RunAcceptanceScenarioOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly logger?: ScenarioLogger;
}

export declare class AcceptanceStepError extends Error {
  readonly name: "AcceptanceStepError";
  constructor(message: string, cause?: unknown);
}

export declare function runAcceptanceScenario(
  options?: RunAcceptanceScenarioOptions,
): Promise<AcceptanceScenarioOutcome>;

export declare function resolveRepoArtifacts(): ResolvedRepoArtifacts;

export declare function renderResultsTable(results: readonly AcceptanceStepResult[]): string;

export declare function readRepoVersion(): string;

export declare function invokeCli(
  cfg: Pick<AcceptanceScenarioConfig, "artifacts">,
  args: readonly string[],
): string;
