/**
 * Shared validation for the `polaris processors` command group.
 *
 * The central rule for P6-005:
 *
 *   The CLI MUST refuse to write semantic processor config. Processor
 *   transform rules (inputs, outputs, mode, transform code) live in
 *   versioned code under `processors/<name>/v<n>/` — NEVER in PostgreSQL.
 *
 * This module enforces that contract before any value reaches the DB
 * repository. The rejection list of disallowed flag/argument names lives
 * here so every command in the group enforces the same gate. This mirrors
 * the defense-in-depth pattern P6-004 established for destinations:
 *
 *   1. The Zod-typed manifest is the only path that can describe semantics,
 *      and it lives on disk.
 *   2. The `ProcessorActivationsTable` interface has no transform-rule
 *      columns, so even a programmatic caller can't write them through
 *      Kysely.
 *   3. The CLI argument validator below rejects rule-shaped flags BEFORE
 *      any validation or DB write happens.
 *   4. Migration tests assert the column set on disk matches the typed
 *      surface.
 *
 * @see docs/architecture/05-processors-and-replay.md "Processor Configuration"
 * @see docs/implementation/tasks/P6-005-processor-runtime-cli.md
 */
import { UsageError } from "../../errors.js";

/**
 * Flag and argument tokens that look like an attempt to declare processor
 * semantics. If the CLI ever receives one of these, every processors
 * command rejects with a usage error BEFORE any DB write.
 *
 * The match is case-insensitive and matches both the flag form
 * (`--input-topic`) and the underlying option name commander stores
 * (`inputTopic`).
 *
 * The list intentionally covers:
 *   - direct transform-rule synonyms (transform, rule, ruleset)
 *   - destination-style mapping leaks (mapping, field-map, event-map)
 *   - I/O topic overrides (input-topic, output-topic, kafka-topic)
 *   - inline config payloads (config-blob, config-json, runtime-config)
 *   - routing/enrichment surfaces (routing, enrichment, filter)
 *   - schema overrides (schema, schema-version-override)
 *
 * Adding a token here is a one-line change. The corresponding test in
 * `processors-commands.test.ts` ensures the list keeps expanding rather
 * than narrowing.
 */
export const FORBIDDEN_PROCESSOR_RULE_FLAG_TOKENS: readonly string[] = [
  // Transform-rule synonyms
  "transform",
  "transforms",
  "rule",
  "rules",
  "ruleset",
  "rulesets",
  // Mapping leaks (the destination CLI's forbidden surface — same concern here)
  "map",
  "maps",
  "mapping",
  "mappings",
  "field-map",
  "field_map",
  "fieldmap",
  "field-mapping",
  "field_mapping",
  "fieldmapping",
  "event-map",
  "event_map",
  "eventmap",
  "event-mapping",
  "event_mapping",
  "eventmapping",
  "property-map",
  "property_map",
  "propertymap",
  // I/O topic overrides — the manifest declares input/output families
  "input-topic",
  "input_topic",
  "inputtopic",
  "output-topic",
  "output_topic",
  "outputtopic",
  "kafka-topic",
  "kafka_topic",
  "kafkatopic",
  "topic",
  "topics",
  // Inline config payloads
  "config-blob",
  "config_blob",
  "configblob",
  "config-json",
  "config_json",
  "configjson",
  "runtime-config",
  "runtime_config",
  "runtimeconfig",
  "transform-config",
  "transform_config",
  "transformconfig",
  // Routing / enrichment surfaces
  "routing",
  "route",
  "routes",
  "enrichment",
  "enrich",
  "filter",
  "filters",
  // Schema overrides — schema_version lives on the manifest, not the activation row
  "schema",
  "schemas",
  "schema-version-override",
  "schema_version_override",
  "schemaversionoverride",
];

/**
 * Normalise a flag/option name into the same shape as
 * {@link FORBIDDEN_PROCESSOR_RULE_FLAG_TOKENS}. commander stores option
 * names in camelCase (`--input-topic` -> `inputTopic`), so we lowercase
 * and convert camelCase boundaries to hyphens before comparing.
 */
function normaliseFlagName(name: string): string {
  return name
    .replace(/^--?/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase();
}

/**
 * Reject any flag/argument token that looks like an attempt to define
 * processor transform semantics. Used by:
 *
 *   - `polaris processors enable`  (only --version, --project, --env allowed)
 *   - `polaris processors disable` (only --version, --project, --env allowed)
 *   - `polaris processors list`    (no rule-shaped flags allowed)
 *   - `polaris processors show`    (only --version allowed)
 *   - `polaris processors runs *`  (only --run-id / scoping flags allowed)
 *
 * Throws {@link UsageError} so the dispatcher returns exit code 2 and the
 * caller can detect the rejection in scripts.
 */
export function rejectProcessorRuleArguments(args: Readonly<Record<string, unknown>>): void {
  for (const rawKey of Object.keys(args)) {
    const value = args[rawKey];
    if (value === undefined) continue;
    const normalised = normaliseFlagName(rawKey);
    if (FORBIDDEN_PROCESSOR_RULE_FLAG_TOKENS.includes(normalised)) {
      throw new UsageError(
        `--${normalised} is not accepted by the processors CLI. ` +
          "Processor transform rules (inputs, outputs, mode, transform code) " +
          "live in versioned code under processors/<name>/v<n>/ and are NEVER " +
          "stored in PostgreSQL. To change a processor's runtime activation, " +
          "use `polaris processors enable` / `disable` with --version, --project, " +
          "and --env. To change transform semantics, ship a new processor version.",
      );
    }
  }
}
