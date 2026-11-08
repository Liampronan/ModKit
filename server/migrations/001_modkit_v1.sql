-- ModKit v1 Postgres Schema Migration
-- Creates the `modkit` schema, tables, indexes, Row Level Security (RLS),
-- and SECURITY DEFINER visibility helper functions for App Store Guideline 1.2.

CREATE SCHEMA IF NOT EXISTS modkit;

-- 1. EULA / Terms acceptances
CREATE TABLE IF NOT EXISTS modkit.terms_acceptances (
  user_id text NOT NULL,
  terms_version text NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, terms_version)
);

-- 2. User-to-user blocks
CREATE TABLE IF NOT EXISTS modkit.blocks (
  blocker_id text NOT NULL,
  blocked_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);

-- 3. User bans (enforced globally)
CREATE TABLE IF NOT EXISTS modkit.bans (
  user_id text PRIMARY KEY,
  reason text NOT NULL,
  banned_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz
);

-- 4. Content moderation status (populated by classifier webhook or reports)
CREATE TABLE IF NOT EXISTS modkit.items (
  target_type text NOT NULL,
  target_id text NOT NULL,
  author_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'flagged')),
  classifier_provider text,
  classifier_categories jsonb NOT NULL DEFAULT '{}'::jsonb,
  classifier_scores jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (target_type, target_id)
);

-- 5. User-submitted content reports
CREATE TABLE IF NOT EXISTS modkit.reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  target_author_id text,
  reason text NOT NULL
    CHECK (reason IN ('objectionable', 'spam', 'harassment', 'unsafe', 'other')),
  details text,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'actioned', 'dismissed')),
  resolution_note text,
  resolved_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

-- Indexes for fast RLS visibility lookups and operator triage
CREATE INDEX IF NOT EXISTS idx_blocks_blocked
  ON modkit.blocks (blocked_id);

CREATE INDEX IF NOT EXISTS idx_bans_user_expires
  ON modkit.bans (user_id, expires_at);

CREATE INDEX IF NOT EXISTS idx_items_author
  ON modkit.items (author_id, status);

CREATE INDEX IF NOT EXISTS idx_items_status_updated
  ON modkit.items (status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_reports_reporter_target
  ON modkit.reports (reporter_id, target_type, target_id);

CREATE INDEX IF NOT EXISTS idx_reports_target
  ON modkit.reports (target_type, target_id);

CREATE INDEX IF NOT EXISTS idx_reports_status_created
  ON modkit.reports (status, created_at DESC);

-- Enable Row Level Security on every table in modkit (deny-by-default for public/anon/authenticated roles)
ALTER TABLE modkit.terms_acceptances ENABLE ROW LEVEL SECURITY;
ALTER TABLE modkit.blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE modkit.bans ENABLE ROW LEVEL SECURITY;
ALTER TABLE modkit.items ENABLE ROW LEVEL SECURITY;
ALTER TABLE modkit.reports ENABLE ROW LEVEL SECURITY;

-- SQL Helper Functions (SECURITY DEFINER) for Host App RLS policies

-- True if user_id has an active (non-expired) ban
CREATE OR REPLACE FUNCTION modkit.is_banned(check_user_id text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = modkit, public AS $$
  SELECT CASE
    WHEN check_user_id IS NULL THEN false
    ELSE EXISTS (
      SELECT 1 FROM modkit.bans b
      WHERE b.user_id = check_user_id
        AND (b.expires_at IS NULL OR b.expires_at > now())
    )
  END;
$$;

-- True if viewer_id has blocked author_id
CREATE OR REPLACE FUNCTION modkit.is_blocked(viewer_id text, author_id text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = modkit, public AS $$
  SELECT CASE
    WHEN viewer_id IS NULL OR author_id IS NULL THEN false
    ELSE EXISTS (
      SELECT 1 FROM modkit.blocks bl
      WHERE bl.blocker_id = viewer_id AND bl.blocked_id = author_id
    )
  END;
$$;

-- Master visibility check for content rows.
-- mode = 'post': visible unless rejected/flagged (or viewer is author of pending item).
-- mode = 'pre': visible only if approved (or viewer is author and item is pending/approved).
CREATE OR REPLACE FUNCTION modkit.is_visible(
  viewer_id text,
  author_id text,
  p_target_type text,
  p_target_id text,
  mode text DEFAULT 'post'
)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = modkit, public AS $$
  SELECT
    NOT modkit.is_banned(author_id)
    AND NOT modkit.is_blocked(viewer_id, author_id)
    AND NOT EXISTS (
      SELECT 1 FROM modkit.reports r
      WHERE viewer_id IS NOT NULL
        AND r.reporter_id = viewer_id
        AND r.target_type = p_target_type
        AND r.target_id = p_target_id
    )
    AND COALESCE(
      (
        SELECT CASE
          WHEN i.status IN ('rejected', 'flagged') THEN false
          WHEN i.status = 'approved' THEN true
          WHEN i.status = 'pending' THEN (mode = 'post' OR (viewer_id IS NOT NULL AND viewer_id = author_id))
          ELSE false
        END
        FROM modkit.items i
        WHERE i.target_type = p_target_type AND i.target_id = p_target_id
      ),
      (mode = 'post' OR (viewer_id IS NOT NULL AND viewer_id = author_id))
    );
$$;

-- Allow host table RLS policies executed by non-superuser roles (e.g. Supabase `authenticated`/`anon`)
-- to invoke the SECURITY DEFINER helper functions while keeping direct table access locked down.
GRANT USAGE ON SCHEMA modkit TO PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA modkit FROM PUBLIC;
GRANT EXECUTE ON FUNCTION modkit.is_banned(text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION modkit.is_blocked(text, text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION modkit.is_visible(text, text, text, text, text) TO PUBLIC;

