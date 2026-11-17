# `modkit-server`

Self-hosted HTTP `/v1` server handler, Postgres store, multimodal classifiers (OpenAI / AWS Rekognition), notification sinks (Slack / Email), and operator CLI for ModKit.

## Operator CLI (`npx modkit-server`)

```bash
# Copy 001_modkit_v1.sql into your Supabase migrations directory
npx modkit-server migrations copy ./supabase/migrations

# List open user reports
npx modkit-server reports list --db "$DATABASE_URL" --status open

# Resolve a report within the 24-hour App Store SLA (remove | dismiss | ban)
npx modkit-server reports resolve <report-id> --action remove --note "Removed objectionable photo" --db "$DATABASE_URL"

# Manage global user bans directly
npx modkit-server bans add <user-id> --reason "Repeated violations" --db "$DATABASE_URL"
npx modkit-server bans remove <user-id> --db "$DATABASE_URL"
npx modkit-server bans list --db "$DATABASE_URL"

# Purge a deleted user's ModKit data (Guideline 5.1.1(v); preserves modkit.bans unless --delete-ban is passed)
npx modkit-server users delete <user-id> --db "$DATABASE_URL"

# Run end-to-end HTTP /v1 conformance checks against a deployed server
npx modkit-server conformance --server "https://your-project.supabase.co/functions/v1/modkit" --token "$TEST_USER_JWT" --webhook-secret "$MODKIT_WEBHOOK_SECRET"
```

## Account Deletion (`modkit.delete_user_data` & `store.deleteUserData`)

Call `SELECT modkit.delete_user_data(user_id)` (via SQL or `service_role` `.rpc('delete_user_data', { p_user_id: userId })`) or `await store.deleteUserData(userId)` from your account-deletion handler to remove the user's `terms_acceptances`, `blocks` (as blocker or blocked), filed `reports`, and authored `items`. Ban rows in `modkit.bans` are intentionally kept by default unless `p_delete_ban => true` / `{ userId, deleteBan: true }` / `--delete-ban` is specified.
