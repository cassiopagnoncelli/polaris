-- migrate:up
--
-- Create the `source_allowed_origins` table.
--
-- The ingester's `POST /v1/events` endpoint is callable from browsers via the
-- Web SDK. Browser callers send an `Origin` header that the ingester checks
-- against a per-source allow-list to prevent third-party sites from issuing
-- credentialed requests with a stolen API key.
--
-- Per `docs/architecture/11-production-readiness.md` ("Security Hardening")
-- and `docs/architecture/04-ingestion-and-sdks.md` ("Ingester
-- Responsibilities"), the allow-list lives in PostgreSQL so the operator
-- model is the same as for sources / API keys: declarative entries land
-- through the catalog + CLI and the ingester reads through a short cache.
--
-- Schema rules:
--
--   - One row per allowed origin per `(project_id, source_id, environment)`.
--   - `origin` is the case-sensitive scheme + host (+ optional port) shape
--     the browser actually sends in the `Origin` header, e.g.
--     `https://shop.example.com` or `http://localhost:5173`. We do NOT
--     allow trailing slashes; the CHECK constraint enforces it.
--   - The `*` wildcard origin is forbidden. Allow-listing the entire web
--     defeats the purpose; producers using server-to-server keys are not
--     subject to CORS at all (no `Origin` header to check).
--   - `environment` is the same closed set used elsewhere
--     (`development`, `staging`, `production`).
--   - `(project_id, source_id)` references `sources` so an allow-list cannot
--     orphan after the source is removed.
--   - `(project_id, source_id, environment, origin)` is the primary key —
--     duplicate entries are a CLI bug, not a runtime concern.
--
-- Schema references:
--   - docs/architecture/11-production-readiness.md "Security Hardening"
--   - docs/architecture/04-ingestion-and-sdks.md
--   - docs/implementation/tasks/P11-006-security-hardening.md

CREATE TABLE source_allowed_origins (
  project_id   text        NOT NULL,
  source_id    text        NOT NULL,
  environment  text        NOT NULL,
  origin       text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (project_id, source_id, environment, origin),
  FOREIGN KEY (project_id, source_id) REFERENCES sources(project_id, source_id) ON DELETE CASCADE,

  CONSTRAINT source_allowed_origins_environment_allowed
    CHECK (environment IN ('development', 'staging', 'production')),

  -- Browsers send an Origin header as `<scheme>://<host>[:<port>]`. We
  -- accept `http` and `https` only (the SDK is HTTPS in production; HTTP
  -- exists so developers can run the local dev server). Trailing slashes
  -- are forbidden — the browser never sends one. The bracket form for IPv6
  -- is allowed via the broad host character class. The length cap (255) is
  -- conservative; RFC 1035 host names max out at 253.
  CONSTRAINT source_allowed_origins_origin_format
    CHECK (
      origin ~ '^https?://[A-Za-z0-9\.\-\:\[\]_]+$'
      AND length(origin) >= 1
      AND length(origin) <= 255
      AND origin <> '*'
    )
);

-- The ingester looks up by `(project_id, source_id, environment)` to decide
-- whether a given `Origin` header is allowed. The primary key already covers
-- this prefix; no extra index needed.

-- migrate:down

DROP TABLE source_allowed_origins;
