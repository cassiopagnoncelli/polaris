/**
 * Destinations list and detail.
 *
 * No credential appears on this page. It used to render `secret_ref`, and that
 * was right at the time: the column held a `<provider>:<ref>` pointer that
 * `@polaris/shared-secrets` resolved at delivery time, so showing it was how
 * an operator confirmed a destination was wired to the right vault entry. The
 * column holds the credential itself now, and `DestinationRow` no longer
 * carries it — `DESTINATION_COLUMNS` in ../queries.ts does not select it.
 *
 * "Is this destination wired correctly?" is answered by its delivery history
 * instead: an `auth` error class on recent rows means the credential is wrong.
 * Changing it is `polaris destinations rotate-secret`.
 */

import { POLARIS_ENVIRONMENTS } from "@polaris/shared-environments";
import { type Html, html } from "../html.js";
import {
  type AdminPageContext,
  emptyRow,
  envBadge,
  linkCard,
  mono,
  page,
  statCard,
  statusBadge,
  valueBadge,
} from "../layout.js";
import type { DestinationRow } from "../queries.js";
import { ADMIN_PREFIX } from "../session.js";
import { filterForm, selectField, textField } from "./filters.js";
import { formatBool, formatInstant } from "./format.js";

export interface DestinationFilterValues {
  readonly project: string;
  readonly environment: string;
  readonly status: string;
}

const ENVIRONMENTS = POLARIS_ENVIRONMENTS;
const STATUSES = ["active", "paused", "disabled"] as const;

export function renderDestinationsPage(input: {
  ctx: AdminPageContext;
  destinations: readonly DestinationRow[];
  filters: DestinationFilterValues;
}): string {
  const rows =
    input.destinations.length === 0
      ? emptyRow(8, "No destinations match these filters.")
      : input.destinations.map(
          (dest) => html`<tr>
            <td>
              <a href="${ADMIN_PREFIX}/destinations/${encodeURIComponent(dest.destination_id)}"
                >${mono(dest.instance_label)}</a
              >
            </td>
            <td>${dest.vendor}</td>
            <td>${mono(dest.project_id)}</td>
            <td>${envBadge(dest.environment)}</td>
            <td>${statusBadge(dest.status)}</td>
            <td>${dest.mode}</td>
            <td>${String(dest.max_rps)}</td>
            <td>${formatBool(dest.replay_opt_in)}</td>
          </tr>`,
        );

  return page({
    ctx: input.ctx,
    title: "Destinations",
    body: html`
      ${filterForm(`${ADMIN_PREFIX}/destinations`, [
        textField("project", "Project", input.filters.project),
        selectField("environment", "Environment", ENVIRONMENTS, input.filters.environment),
        selectField("status", "Status", STATUSES, input.filters.status),
      ])}
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Instance</th>
              <th>Vendor</th>
              <th>Project</th>
              <th>Environment</th>
              <th>Status</th>
              <th>Mode</th>
              <th>Max RPS</th>
              <th>Replay opt-in</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      </div>
    `,
  });
}

/**
 * The operator's own sentence, on its own line and inside quotation marks.
 *
 * `disabled_reason` is free text with no guaranteed punctuation, so running it
 * inline into the platform's copy produces "…quota increase Events keep
 * flowing…". Quoting it also marks where our words stop and theirs start.
 */
function recordedReason(reason: string | null): Html {
  if (reason === null) {
    return html`<span class="notice-detail muted">No reason was recorded.</span>`;
  }
  return html`<span class="notice-detail">Reason on record: <q>${reason}</q></span>`;
}

/**
 * Whether this destination is delivering right now, said once, at the top.
 *
 * The flat field list this page used to be gave `status` and `disabled_reason`
 * the same weight as `dead_letter_threshold`, so the one fact an operator
 * opens the page for — is it delivering, and if not, why not — had to be
 * found. `disabled_reason` also rendered an em dash on every healthy row,
 * which is a line of nothing on the overwhelming majority of visits.
 *
 * `mode` earns a banner of its own: a production destination in `sandbox` or
 * `test` is quietly not delivering anywhere real, and nothing else on the page
 * says so out loud.
 */
function stateNotices(dest: DestinationRow): readonly Html[] {
  const notices: Html[] = [];

  if (dest.status === "disabled") {
    notices.push(html`<p class="notice error">
      <strong>Delivery is stopped.</strong> Events keep flowing through the
      pipeline — they are not sent here until this destination is enabled again.
      ${recordedReason(dest.disabled_reason)}
    </p>`);
  } else if (dest.status === "paused") {
    notices.push(html`<p class="notice warn">
      <strong>Delivery is paused.</strong> This destination is not taking
      traffic and has not been disabled.
      ${recordedReason(dest.disabled_reason)}
    </p>`);
  }

  if (dest.environment === "production" && dest.mode !== "live") {
    notices.push(html`<p class="notice warn">
      This is a <strong>production</strong> destination running in
      <strong>${dest.mode}</strong> mode. Production traffic is not reaching the
      real ${dest.vendor} endpoint.
    </p>`);
  }

  return notices;
}

export function renderDestinationDetailPage(input: {
  ctx: AdminPageContext;
  destination: DestinationRow;
  /**
   * Button-and-confirmation for the state change on offer, beside the title.
   * Absent when the viewer may not run one, or none would change anything.
   */
  titleAction?: Html | undefined;
  /**
   * What just happened, or why nothing may be done here — above the state
   * banners, because after a POST this page re-renders from the top and a
   * result reported at the bottom is a result nobody sees.
   */
  notice?: Html | undefined;
}): string {
  const dest = input.destination;
  const destinationId = encodeURIComponent(dest.destination_id);

  return page({
    ctx: input.ctx,
    // The tab keeps the vendor — it is what tells two open destinations apart.
    // The heading does not: the breadcrumb directly above it already said it.
    title: `${dest.vendor} · ${dest.instance_label}`,
    heading: dest.instance_label,
    breadcrumb: [
      { label: "Destinations", href: `${ADMIN_PREFIX}/destinations` },
      { label: dest.instance_label },
    ],
    // States the vendor rather than claiming delivery: `active` here means the
    // instance is not disabled, which on a paused or sandboxed row is not the
    // same as traffic arriving at the vendor.
    lede: html`${envBadge(dest.environment)} ${statusBadge(dest.status)}
    ${valueBadge(`${dest.mode} mode`)}
    <span><strong>${dest.vendor}</strong> destination</span>`,
    ...(input.titleAction !== undefined ? { titleAction: input.titleAction } : {}),
    body: html`
      ${input.notice ?? null} ${stateNotices(dest)}

      <h2>Delivery limits</h2>
      <div class="cards compact">
        ${statCard({ label: "Max RPS", value: String(dest.max_rps) })}
        ${statCard({ label: "Max concurrency", value: String(dest.max_concurrency) })}
        ${statCard({ label: "Dead-letter threshold", value: String(dest.dead_letter_threshold) })}
        ${statCard({ label: "Retry policy", value: dest.retry_policy, mono: true })}
      </div>
      <p class="muted">
        Configured ceilings, not live readings — actual throughput and failure
        rates are in the Grafana <em>polaris-destinations</em> dashboard.
      </p>
      <p class="muted">
        The two ceilings are scoped differently. <strong>Max RPS</strong> is
        fleet-wide: replicas share one counter in Redis, so this is the rate
        the vendor sees however many are running. <strong>Max concurrency</strong>
        is per replica — it bounds one process's in-flight requests, so the
        fleet holds up to <em>replicas × this number</em> open at once.
      </p>
      <p class="muted">
        <strong>Consent</strong> is not a setting here. Each vendor's own
        requirement is fixed in its code and always applies — a project's
        routing configuration can require <em>more</em> consent than the
        vendor does, never less, so no configuration change can send an
        event the vendor's requirement would have dropped. The vendor's
        requirement is recorded in its <code>consumer.manifest.yaml</code>.
      </p>

      <h2>Configuration</h2>
      <dl class="detail">
        <dt>Destination id</dt>
        <dd>${mono(dest.destination_id)}</dd>
        <dt>Project</dt>
        <dd>
          <a href="${ADMIN_PREFIX}/projects/${encodeURIComponent(dest.project_id)}"
            >${mono(dest.project_id)}</a
          >
        </dd>
        ${
          /*
           * Enabling nulls this column, so a reason surviving on an active row
           * is state that should not exist — a direct write, or a clear that
           * did not happen. Rendering it only when it is set drops the em dash
           * from every healthy page without hiding the one case that matters.
           * When the status banner is already quoting it, this row stays out.
           */
          dest.disabled_reason !== null && dest.status === "active"
            ? html`<dt>Disabled reason</dt>
              <dd>
                ${dest.disabled_reason}
                <span class="muted">— stale, this destination is active</span>
              </dd>`
            : null
        }
        <dt>Replay opt-in</dt>
        <dd>
          ${
            dest.replay_opt_in
              ? html`<span class="badge badge-ok">yes</span>`
              : html`<span class="badge badge-muted">no</span>`
          }
          ${
            dest.replay_opt_in_reason !== null
              ? html`<span class="muted"> — ${dest.replay_opt_in_reason}</span>`
              : null
          }
        </dd>
      </dl>

      <h2>Related</h2>
      <div class="linkrow">
        ${linkCard({
          href: `${ADMIN_PREFIX}/dlq?destination=${destinationId}`,
          title: "Dead-letter queue →",
          description: "Messages this destination gave up on, awaiting triage.",
        })}
        ${linkCard({
          href: `${ADMIN_PREFIX}/audit?target_type=destination&target_id=${destinationId}`,
          title: "Audit history →",
          description: "Every change made to this destination, and who made it.",
        })}
      </div>

      <p class="provenance">
        <span>Created ${formatInstant(dest.created_at)}</span>
        <span>Last changed ${formatInstant(dest.updated_at)}</span>
      </p>
    `,
  });
}
