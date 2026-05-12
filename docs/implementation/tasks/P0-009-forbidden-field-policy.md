# P0-009: Forbidden-Field Policy

Status: Backlog

## Goal

Define the two-tier (reject vs redact) forbidden-field policy in code, with closed-set reason codes, project override support, and helper utilities the ingester will use to enforce it.

## Required Reading

- [Event Contract / Forbidden-Field Policy](../../architecture/01-event-contract.md)
- [Codex Instructions](../../instructions/codex.md)

## Dependencies

- P0-001
- P0-006

## Write Scope

Allowed:

```text
catalog/policy/
packages/shared-policy/
```

Forbidden:

```text
apps/ingester-api/
packages/web-sdk/
packages/node-sdk/
processors/
consumers/
sql/
```

## Implementation Notes

- Policy lives at `catalog/policy/forbidden-fields.ts`. Project overrides live at `catalog/policy/forbidden-fields.<project_id>.ts`. No PostgreSQL.
- Implement the default-capture, narrow-reject principle: only `pii_card` and `pii_secret` content blocks capture at the platform level. Everything else passes through.
- Define two lists:
  - Reject list: fields whose presence rejects the event with reason code `forbidden_field_rejected`.
  - Redact list: fields whose value is replaced with `"[REDACTED:<reason>]"` and the event continues.
- Reason codes are a closed set: `pii_card`, `pii_account`, `pii_secret`, `policy`, `length`, `pattern_match`.
- Provide helpers:
  - `evaluate(event, projectPolicy?) -> { decision: 'accept' | 'reject', redactions: [...] }`
  - The evaluator must operate without mutating the input event and must never log raw values.
- Pattern rules support regex and entropy-based heuristics for the `pii_secret` family (AWS keys, GitHub tokens, JWTs in non-`identity` paths, generic high-entropy secrets).
- Project overrides may add to either list, may move entries from reject to redact only with a documented exception note in the file, and may not weaken redact entries below platform defaults.
- Export an inspection function the CLI uses to print the effective policy for a project.

### Platform defaults (initial values)

Ship the policy file with exactly these defaults; no more, no less. Anything broader belongs in project overrides.

Reject list (named fields only — pattern matches do NOT reject):

```text
pii_card:
  cvv, cvc, card_security_code
  card_number_full

pii_secret:
  password, passwd, pwd
  authorization, authorization_header
  session_cookie, raw cookie blobs
  private_key, priv_key, PEM-encoded private key bodies
```

Redact list (named fields):

```text
card_number: keep first 6 / last 4 separately if producer supplied them; redact raw value with reason pii_card
```

Redact list (pattern-based, with metric emission):

```text
Luhn-valid 13-19 digit PAN in any field other than card_number   → reason pii_card
AWS access key signatures (AKIA + base32 body)                   → reason pii_secret
GitHub token signatures (ghp_/gho_/ghu_/ghs_/ghr_ prefixes)      → reason pii_secret
JWT three-segment base64url pattern outside identity.* paths     → reason pii_secret
Generic 32+ byte hex or base64 strings in unexpected fields      → reason pii_secret
```

Every pattern-based match emits the metric `polaris_ingest_redacted_pattern_total{project_id, environment, reason, pattern}` so the platform team can route producer leaks back to the responsible producer.

Note: IBAN, bank accounts, raw email, raw phone, names, IP, user agent are intentionally **not** on the platform default lists. They pass through. Projects add their own redaction rules when needed.

## Acceptance Criteria

- [ ] `catalog/policy/forbidden-fields.ts` exists with the narrow platform defaults specified above.
- [ ] Reject list contains only the named fields listed; no pattern-based entries appear on the reject list.
- [ ] Redact list contains the named `card_number` rule and all five pattern-based detections, each emitting the `polaris_ingest_redacted_pattern_total` metric.
- [ ] No PII categories outside pii_card and pii_secret appear on the platform default reject list.
- [ ] IBAN, account numbers, raw email, and raw phone are documented as **not** on platform defaults and are demonstrated via the sample project override file.
- [ ] Project override file shape is documented and a sample exists that adds a project-level email redaction.
- [ ] Closed-set reason codes are exported as a TypeScript type.
- [ ] Evaluator returns a deterministic decision without mutating input.
- [ ] Tests cover: reject case (named field), redact case (named field), redact case (pattern match for each of the five patterns), no-match case, project override adding a redact, project override attempting to downgrade a reject (fails review check).
- [ ] Tests verify a Luhn-valid PAN in an unexpected field is redacted (not rejected) and the metric is emitted with `reason="pii_card"`.
- [ ] Tests verify that an event carrying a raw email passes through unchanged under platform defaults.
- [ ] No raw value appears in any test log output or metric label.

## Checks

Run where possible:

```text
pnpm typecheck
pnpm test
pnpm lint
```

## Handoff

```text
Files changed:
Commands run:
Checks passed:
Known gaps:
```
