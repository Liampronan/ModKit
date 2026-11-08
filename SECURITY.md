# Security Policy

## Reporting a Vulnerability

Please report suspected security vulnerabilities privately through GitHub's security advisory flow for this repository. Do not open a public GitHub issue for security-sensitive reports.

## ModKit `/v1` Security Model

1. **Row-Level Security (RLS) by Default**:
   - All tables in `001_modkit_v1.sql` live in the `modkit` schema with RLS enabled and direct table privileges revoked from `PUBLIC` (`anon`/`authenticated`).
   - Host app RLS policies evaluate visibility via `SECURITY DEFINER` functions (`modkit.is_visible`, `modkit.is_blocked`, `modkit.is_banned`) with a locked `search_path = modkit, public`.
2. **JWT & Constant-Time Webhook Authentication**:
   - Client `/v1/*` routes verify Supabase Auth JWTs (`ES256`/`RS256` JWKS or `HS256` secret), enforcing `exp`, `nbf`, `aud`, `iss`, and `sub`.
   - `POST /v1/webhooks/content` verifies `x-modkit-webhook-secret` (or `Authorization: Bearer`) using constant-time SHA-256 digest comparison (`timingSafeEqual`).
3. **Parameterized SQL Queries**:
   - `postgresStore` uses `postgres.js` parameterized tagged template queries exclusively and defaults `prepare: false` / `fetch_types: false` for Supavisor transaction-mode pooler safety.
