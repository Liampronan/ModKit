# ModKit Privacy Policy & Manifest

ModKit is **self-hosted first**. You control the `/v1` server, the Postgres database (`modkit` schema), classifier credentials, and notification channels.

## Privacy Guarantees

- **No third-party analytics or tracking**: ModKit never collects advertising identifiers or tracks users across apps (`NSPrivacyTracking = false`).
- **Local `UserDefaults` caching (`CA92.1`)**: The iOS `ModerationStore` caches the current user's accepted terms versions, blocked user IDs, and reported item IDs in `UserDefaults` solely to hide blocked/reported content immediately upon launch.
- **No stored credentials on device**: `ModKitClient.live` requests a fresh bearer token from your app's `authTokenProvider` closure on each network call and never writes JWTs to disk.
- **Short-lived signed image URLs**: When classifying images in private Supabase Storage buckets, `supabaseStorage` generates short-lived signed read URLs (default 300 seconds) so user photos never need to be world-readable.
