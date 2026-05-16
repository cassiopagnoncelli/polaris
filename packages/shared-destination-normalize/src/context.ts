/**
 * Context flattening for destination normalization.
 *
 * The canonical `envelope.context` is structured (per
 * `docs/architecture/01-event-contract.md`):
 *
 *   context: {
 *     ip:         string | null,
 *     user_agent: string | null,
 *     locale:     string | null,
 *     page:       { url, path, title, referrer } | null,
 *     campaign:   { source, medium, name, term, content, click_id } | null,
 *   }
 *
 * Vendor APIs consume context as a flat record (Meta CAPI `user_data`,
 * GA4 `user_properties`, TikTok `context`). `flattenContext` collapses
 * the nested shape into a flat key-value map with stable names:
 *
 *   ip, user_agent, locale,
 *   page_url, page_path, page_title, page_referrer,
 *   campaign_source, campaign_medium, campaign_name,
 *   campaign_term, campaign_content, campaign_click_id
 *
 * Null / missing values are emitted as `null` keys so the mapper layer
 * can distinguish "not present" from "empty string" — this matters for
 * Meta CAPI's `client_ip_address` handling where an empty string would
 * count as a present-but-invalid field.
 */

/** Input shape: the relevant subset of `envelope.context`. */
export interface EnvelopeContextInput {
  readonly ip?: string | null | undefined;
  readonly user_agent?: string | null | undefined;
  readonly locale?: string | null | undefined;
  readonly page?: EnvelopePageContext | null | undefined;
  readonly campaign?: EnvelopeCampaignContext | null | undefined;
  /**
   * Mobile-app source slots (G7ZCYLL6 / WH7LZ0WZ). Populated by SDKs
   * running inside a native mobile app. When ANY of these slots are
   * present, `flattenContext` projects them onto the `app_*` keys and
   * destination mappers infer `app` rather than `website` / `web` as
   * the channel.
   */
  readonly app?: EnvelopeAppContext | null | undefined;
}

/** Subset of `envelope.context.page` used by destinations. */
export interface EnvelopePageContext {
  readonly url?: string | null | undefined;
  readonly path?: string | null | undefined;
  readonly title?: string | null | undefined;
  readonly referrer?: string | null | undefined;
}

/** Subset of `envelope.context.campaign` used by destinations. */
export interface EnvelopeCampaignContext {
  readonly source?: string | null | undefined;
  readonly medium?: string | null | undefined;
  readonly name?: string | null | undefined;
  readonly term?: string | null | undefined;
  readonly content?: string | null | undefined;
  readonly click_id?: string | null | undefined;
}

/**
 * Subset of `envelope.context.app` used by destinations
 * (G7ZCYLL6 / WH7LZ0WZ).
 *
 *   bundle_id   reverse-DNS native bundle id (`com.example.app`)
 *   version     app semver / build-number string the SDK reports
 *   namespace   marketing / product namespace (e.g. `consumer` vs `studio`)
 *   build       opaque build identifier (matches Apple's CFBundleVersion / Android versionCode)
 *   idfa        iOS Advertising Identifier (raw). Meta CAPI hashes it; mapper handles per-vendor.
 *   idfv        iOS Vendor Identifier (raw). Same handling as `idfa`.
 *   gaid        Android Advertising ID (raw).
 *
 * SDKs SHOULD populate at least one of `bundle_id` / `version` so the
 * channel inference (`action_source: app`) fires. Empty / missing
 * slots become `null` keys in `FlatContext`; downstream mappers
 * decide which slots to forward to the vendor wire shape.
 */
export interface EnvelopeAppContext {
  readonly bundle_id?: string | null | undefined;
  readonly version?: string | null | undefined;
  readonly namespace?: string | null | undefined;
  readonly build?: string | null | undefined;
  readonly idfa?: string | null | undefined;
  readonly idfv?: string | null | undefined;
  readonly gaid?: string | null | undefined;
}

/** Flat context shape handed to vendor mappers. Every field is nullable. */
export interface FlatContext {
  readonly ip: string | null;
  readonly user_agent: string | null;
  readonly locale: string | null;
  readonly page_url: string | null;
  readonly page_path: string | null;
  readonly page_title: string | null;
  readonly page_referrer: string | null;
  readonly campaign_source: string | null;
  readonly campaign_medium: string | null;
  readonly campaign_name: string | null;
  readonly campaign_term: string | null;
  readonly campaign_content: string | null;
  readonly campaign_click_id: string | null;
  /** App-channel slots (G7ZCYLL6 / WH7LZ0WZ). Null when the SDK reports no app context. */
  readonly app_bundle_id: string | null;
  readonly app_version: string | null;
  readonly app_namespace: string | null;
  readonly app_build: string | null;
  readonly app_idfa: string | null;
  readonly app_idfv: string | null;
  readonly app_gaid: string | null;
}

/**
 * Flatten a structured `envelope.context` into the vendor-friendly shape.
 * Null and undefined sub-fields become `null` keys in the output. The
 * helper is null-safe at every level so a `context: null` (legal when the
 * envelope omits it) produces a fully-null output rather than throwing.
 */
export function flattenContext(context: EnvelopeContextInput | null | undefined): FlatContext {
  if (context === undefined || context === null) return EMPTY_FLAT_CONTEXT;

  const page = context.page ?? null;
  const campaign = context.campaign ?? null;
  const app = context.app ?? null;

  return {
    ip: stringOrNull(context.ip),
    user_agent: stringOrNull(context.user_agent),
    locale: stringOrNull(context.locale),
    page_url: stringOrNull(page?.url),
    page_path: stringOrNull(page?.path),
    page_title: stringOrNull(page?.title),
    page_referrer: stringOrNull(page?.referrer),
    campaign_source: stringOrNull(campaign?.source),
    campaign_medium: stringOrNull(campaign?.medium),
    campaign_name: stringOrNull(campaign?.name),
    campaign_term: stringOrNull(campaign?.term),
    campaign_content: stringOrNull(campaign?.content),
    campaign_click_id: stringOrNull(campaign?.click_id),
    app_bundle_id: stringOrNull(app?.bundle_id),
    app_version: stringOrNull(app?.version),
    app_namespace: stringOrNull(app?.namespace),
    app_build: stringOrNull(app?.build),
    app_idfa: stringOrNull(app?.idfa),
    app_idfv: stringOrNull(app?.idfv),
    app_gaid: stringOrNull(app?.gaid),
  };
}

/**
 * Returns true when at least one app-channel slot on the flat context
 * is populated. Used by destination mappers to switch the channel
 * inference from web/crm to app.
 */
export function hasAppContext(flat: FlatContext): boolean {
  // Loose null check covers both `null` and `undefined` so hand-built
  // test fixtures that pre-date the app_* slots and omit the keys
  // entirely correctly evaluate to "no app context".
  return (
    flat.app_bundle_id != null ||
    flat.app_version != null ||
    flat.app_namespace != null ||
    flat.app_build != null ||
    flat.app_idfa != null ||
    flat.app_idfv != null ||
    flat.app_gaid != null
  );
}

const EMPTY_FLAT_CONTEXT: FlatContext = Object.freeze({
  ip: null,
  user_agent: null,
  locale: null,
  page_url: null,
  page_path: null,
  page_title: null,
  page_referrer: null,
  campaign_source: null,
  campaign_medium: null,
  campaign_name: null,
  campaign_term: null,
  campaign_content: null,
  campaign_click_id: null,
  app_bundle_id: null,
  app_version: null,
  app_namespace: null,
  app_build: null,
  app_idfa: null,
  app_idfv: null,
  app_gaid: null,
});

function stringOrNull(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return null;
  return value;
}
