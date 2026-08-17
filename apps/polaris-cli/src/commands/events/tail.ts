/**
 * `polaris events tail --family F --project P` — read-only, live.
 *
 * Attaches a throwaway reader to a family's partition streams and prints
 * envelopes as they arrive, until Ctrl-C.
 *
 * ## What makes this safe to run in production
 *
 * It is not a consumer. `followStream` has no checkpoint store and joins
 * no group, so attaching cannot move a real consumer's position — the
 * failure mode where an operator "just has a look" and the pipeline skips
 * an hour of events is structurally impossible rather than avoided by
 * care. Ctrl-C cancels the AMQP consumer and closes the channel; nothing
 * is written anywhere at any point.
 *
 * ## Payload display
 *
 * Two independent guards, because this is the one command in the trace
 * pair that shows event data:
 *
 *   1. **Policy redaction.** Every envelope goes through the same
 *      `@polaris/shared-policy` evaluator the ingester and the
 *      destination boundary use, with the project's override applied.
 *      A field the policy redacts on the way in is redacted here too.
 *      Reusing the evaluator is deliberate: a second implementation
 *      would be a second chance to disagree about what "redacted" means.
 *   2. **Truncation.** The redacted JSON is then cut to
 *      `--max-bytes` (default 2 KiB). Redaction handles what must never
 *      be shown; truncation handles a 400 KiB batch envelope making the
 *      terminal useless.
 *
 * `mutates: false`: bypasses the production gate from P6-007.
 */

import { PROJECT_POLICY_OVERRIDES } from "@polaris/policy-catalog";
import {
  applyRedactions,
  type EventInput,
  evaluate,
  type ProjectPolicyOverride,
} from "@polaris/shared-policy";
import {
  createAmqpStreamRangeDriver,
  createTransportConnection,
  followStream,
  isCanonicalStreamFamily,
  partitionStreamNames,
  type StreamRangeEvent,
} from "@polaris/shared-transport";
import type { Command } from "commander";

import type { CommandContext, CommandDefinition } from "../../command.js";
import { UsageError } from "../../errors.js";
import { renderAccordingTo } from "../../output.js";

/** Default cap on displayed payload bytes per event. */
export const DEFAULT_MAX_PAYLOAD_BYTES = 2048;
/** Refuse a `--max-bytes` beyond this — past it the terminal is the problem. */
export const MAX_PAYLOAD_BYTES_CEILING = 65_536;
/** Default partition count when the deployment does not say otherwise. */
const DEFAULT_PARTITIONS = 1;

export interface EventsTailArgs {
  readonly family: string;
  readonly project: string;
  readonly environment?: string;
  readonly partitions?: number;
  readonly maxBytes?: number;
  readonly maxEvents?: number;
}

/** One displayed line, before formatting. */
export interface TailedEvent {
  readonly stream: string;
  readonly partition: number;
  readonly offset: string;
  readonly event_id: string;
  readonly event: string;
  readonly project_id: string;
  readonly environment: string;
  readonly occurred_at: string;
  /** Redacted, then truncated. Never the raw bytes. */
  readonly payload: string;
  /** True when `payload` was cut. */
  readonly truncated: boolean;
}

export interface EventsTailHooks {
  /**
   * Runs the attach. Production wires RabbitMQ; tests pass a fake that
   * calls `onEvent` synchronously and returns.
   */
  readonly follow?: (input: {
    readonly ctx: CommandContext;
    readonly args: EventsTailArgs;
    readonly streams: readonly string[];
    readonly signal: AbortSignal;
    readonly onEvent: (event: StreamRangeEvent) => void;
  }) => Promise<void>;
  /** Installs the Ctrl-C handler. Tests pass a pre-made signal instead. */
  readonly signal?: AbortSignal;
}

export const eventsTailCommand: CommandDefinition = {
  id: "events.tail",
  mutates: false,
  register: (parent, deps) => {
    const cmd = parent
      .command("tail")
      .description(
        "Attach a throwaway reader to a stream family and print envelopes as they arrive. Writes no checkpoint and joins no group.",
      )
      .requiredOption("--family <family>", "Canonical stream family, e.g. resolved.events.")
      .requiredOption("--project <project_id>", "Only show events for this project.")
      .option("--env <environment>", "Only show events for this environment.")
      .option("--partitions <n>", "How many partition streams the family has.", (raw: string) =>
        Number.parseInt(raw, 10),
      )
      .option(
        "--max-bytes <n>",
        `Truncate displayed payload to this many bytes (default ${String(DEFAULT_MAX_PAYLOAD_BYTES)}).`,
        (raw: string) => Number.parseInt(raw, 10),
      )
      .option("--max-events <n>", "Detach after this many events.", (raw: string) =>
        Number.parseInt(raw, 10),
      );
    cmd.action(
      async (
        opts: {
          family: string;
          project: string;
          env?: string;
          partitions?: number;
          maxBytes?: number;
          maxEvents?: number;
        },
        command: Command,
      ) => {
        const wrapped = deps.runCommand<EventsTailArgs>(
          { id: "events.tail", mutates: false },
          runEventsTail,
        );
        await wrapped(
          {
            family: opts.family,
            project: opts.project,
            ...(opts.env !== undefined ? { environment: opts.env } : {}),
            ...(opts.partitions !== undefined ? { partitions: opts.partitions } : {}),
            ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
            ...(opts.maxEvents !== undefined ? { maxEvents: opts.maxEvents } : {}),
          },
          command,
        );
      },
    );
  },
};

export function buildEventsTailRunner(hooks: EventsTailHooks = {}) {
  return async function runner(args: EventsTailArgs, ctx: CommandContext): Promise<undefined> {
    const family = args.family.trim();
    if (!isCanonicalStreamFamily(family)) {
      throw new UsageError(
        `unknown stream family "${family}" — use one of the canonical families (raw.events, identified.events, resolved.events, profile.events, ...)`,
      );
    }
    const project = args.project.trim();
    if (project.length === 0) {
      throw new UsageError("--project is required and cannot be empty");
    }
    const partitions = args.partitions ?? DEFAULT_PARTITIONS;
    if (!Number.isInteger(partitions) || partitions <= 0) {
      throw new UsageError("--partitions must be a positive integer");
    }
    const maxBytes = args.maxBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
      throw new UsageError("--max-bytes must be a positive integer");
    }
    if (maxBytes > MAX_PAYLOAD_BYTES_CEILING) {
      throw new UsageError(`--max-bytes cannot exceed ${String(MAX_PAYLOAD_BYTES_CEILING)}`);
    }
    if (
      args.maxEvents !== undefined &&
      (!Number.isInteger(args.maxEvents) || args.maxEvents <= 0)
    ) {
      throw new UsageError("--max-events must be a positive integer");
    }

    const streams = partitionStreamNames(family, partitions);
    const override = PROJECT_POLICY_OVERRIDES.get(project);

    const controller = new AbortController();
    const signal = hooks.signal ?? controller.signal;
    const onSigint = (): void => {
      controller.abort();
    };
    if (hooks.signal === undefined) {
      process.on("SIGINT", onSigint);
    }

    let shown = 0;
    const onEvent = (event: StreamRangeEvent): void => {
      // The cap is enforced HERE, not only by aborting below. Abort is a
      // request the follower honours at its next opportunity — with
      // several partition readers running, messages already in flight
      // would still arrive and `--max-events 2` would print three.
      if (args.maxEvents !== undefined && shown >= args.maxEvents) return;

      // Scope filtering is here, not in the reader: the reader is a
      // transport primitive and knows nothing about projects.
      if (event.project_id !== project) return;
      if (args.environment !== undefined && event.environment !== args.environment) return;

      const displayed = toTailedEvent(event, override, maxBytes);
      ctx.output.writeOut(
        renderAccordingTo(ctx.config.output, {
          human: renderHuman(displayed),
          json: displayed,
        }),
      );
      shown += 1;
      if (args.maxEvents !== undefined && shown >= args.maxEvents) {
        controller.abort();
      }
    };

    const follow = hooks.follow ?? defaultFollow;
    try {
      await follow({
        ctx,
        args: { ...args, family, project, partitions, maxBytes },
        streams,
        signal,
        onEvent,
      });
    } finally {
      if (hooks.signal === undefined) {
        process.off("SIGINT", onSigint);
      }
    }
    return undefined;
  };
}

const runEventsTail = buildEventsTailRunner();

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

/**
 * Redact, then truncate. The order is not interchangeable: truncating
 * first could cut a payload mid-field and leave a partial secret that the
 * evaluator no longer recognises as one.
 */
function toTailedEvent(
  event: StreamRangeEvent,
  override: ProjectPolicyOverride | undefined,
  maxBytes: number,
): TailedEvent {
  const redacted = redactPayload(event.value, override);
  const truncated = redacted.length > maxBytes;
  return {
    stream: event.stream,
    partition: event.partition,
    offset: event.offset,
    event_id: event.event_id,
    event: event.event_name,
    project_id: event.project_id,
    environment: event.environment,
    occurred_at: event.occurred_at,
    payload: truncated ? `${redacted.slice(0, maxBytes)}…` : redacted,
    truncated,
  };
}

function redactPayload(value: Uint8Array, override: ProjectPolicyOverride | undefined): string {
  const text = Buffer.from(value).toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON. Show nothing rather than raw bytes: an unparseable
    // payload cannot be run through the policy evaluator, and displaying
    // what the policy has not cleared is the failure this guard exists
    // to prevent.
    return "(unparseable payload withheld — policy could not evaluate it)";
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return "(non-object payload withheld — policy could not evaluate it)";
  }
  const input = parsed as EventInput;
  const decision = evaluate(input, override === undefined ? {} : { projectPolicy: override });
  if (decision.decision === "reject") {
    // The policy would have refused this event outright. Show the
    // decision, never the event.
    return `(payload withheld — policy rejects field ${decision.path.join(".")})`;
  }
  const safe =
    decision.redactions.length === 0 ? input : applyRedactions(input, decision.redactions);
  return JSON.stringify(safe);
}

function renderHuman(event: TailedEvent): string {
  return [
    `${event.occurred_at}  ${event.stream}[${String(event.partition)}]@${event.offset}`,
    `  ${event.event}  ${event.event_id}  ${event.project_id}/${event.environment}`,
    `  ${event.payload}${event.truncated ? "  (truncated)" : ""}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Production attach
// ---------------------------------------------------------------------------

async function defaultFollow(input: {
  readonly ctx: CommandContext;
  readonly args: EventsTailArgs;
  readonly streams: readonly string[];
  readonly signal: AbortSignal;
  readonly onEvent: (event: StreamRangeEvent) => void;
}): Promise<void> {
  const { rabbitmqEnvSchema } = await import("@polaris/shared-config");
  let rabbitmq: ReturnType<typeof rabbitmqEnvSchema.parse>;
  try {
    rabbitmq = rabbitmqEnvSchema.parse(input.ctx.env);
  } catch (cause) {
    throw new UsageError(
      `POLARIS_RABBITMQ_* env is required to attach a tail: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  const connection = createTransportConnection({ rabbitmq });
  try {
    await connection.connect();
    // One reader per partition stream, all attached at "now" and running
    // until the shared signal fires. Ordering across partitions is not
    // preserved and cannot be — the streams are independent.
    await Promise.all(
      input.streams.map((stream) =>
        followStream(createAmqpStreamRangeDriver(connection), {
          stream,
          fromTimestampMs: Date.now(),
          onEvent: input.onEvent,
          signal: input.signal,
        }),
      ),
    );
  } finally {
    await connection.close();
  }
}
