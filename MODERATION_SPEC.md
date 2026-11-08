# ModKit `1.0.0-beta.1` Complete Specification & `trash-app` Adoption Guide

This specification defines the exact contract between **`Liampronan/ModKit`** (`ModKit` Swift package + `modkit-server` npm/Edge Function package) and **`Liampronan/trash-app`**, so `trash-app` client & Supabase adoption can be implemented directly against these types and endpoints.

---

## Part 1: Postgres Schema & RLS Contract (`001_modkit_v1.sql`)

ModKit creates the `modkit` schema with Row Level Security enabled (deny-by-default for `anon`/`authenticated`; accessed through ModKit's `/v1` server endpoints and `SECURITY DEFINER` RLS helper functions).

### 1.1 Tables in `modkit` Schema

```sql
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
```

### 1.2 SQL Helper Functions (`SECURITY DEFINER`) for Host App RLS

Host tables (`public.trash_pickups` and `storage.objects`) call these functions inside their `SELECT` and `INSERT` RLS policies:

```sql
-- True if user_id has an active (non-expired) ban
CREATE OR REPLACE FUNCTION modkit.is_banned(check_user_id text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = modkit, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM modkit.bans b
    WHERE b.user_id = check_user_id
      AND (b.expires_at IS NULL OR b.expires_at > now())
  );
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
      WHERE r.reporter_id = viewer_id
        AND r.target_type = p_target_type
        AND r.target_id = p_target_id
    )
    AND COALESCE(
      (
        SELECT CASE
          WHEN i.status IN ('rejected', 'flagged') THEN false
          WHEN i.status = 'approved' THEN true
          WHEN i.status = 'pending' THEN (mode = 'post' OR viewer_id = author_id)
          ELSE false
        END
        FROM modkit.items i
        WHERE i.target_type = p_target_type AND i.target_id = p_target_id
      ),
      (mode = 'post' OR viewer_id = author_id)
    );
$$;
```

---

## Part 2: HTTP `/v1` Wire Specification (`modkit-server`)

The server handler (`createModKitServer`) mounts at `/functions/v1/modkit` on Supabase Edge Functions (or any URL on Node.js). All client endpoints require `Authorization: Bearer <supabase-jwt>`.

### 2.1 `GET /v1/state`
Returns the signed-in user's moderation state (accepted terms versions, blocked users, and item IDs reported/hidden by this user).

**Response `200 OK`:**
```json
{
  "user_id": "2ae6284c-246d-4c35-bc08-7936ee643e19",
  "accepted_terms_versions": ["2026-11-01"],
  "blocked_user_ids": ["99999999-0000-0000-0000-000000000002"],
  "hidden_items": [
    { "target_type": "trash_pickup", "target_id": "df039bb9-4651-4cfa-9039-5667513802b6" }
  ]
}
```

### 2.2 `POST /v1/terms/accept`
Records EULA acceptance for the authenticated user.

**Request:**
```json
{
  "terms_version": "2026-11-01"
}
```

**Response `200 OK`:**
```json
{
  "user_id": "2ae6284c-246d-4c35-bc08-7936ee643e19",
  "terms_version": "2026-11-01",
  "accepted_at": "2026-11-08T01:30:00.000Z"
}
```

### 2.3 `POST /v1/reports`
Submits a user report, optionally sets `modkit.items.status = 'flagged'` when `autoHideOnReport: true` (default `true`), and fires the configured notification sink (Slack / Email) immediately.

**Request:**
```json
{
  "target_type": "trash_pickup",
  "target_id": "df039bb9-4651-4cfa-9039-5667513802b6",
  "target_author_id": "99999999-0000-0000-0000-000000000002",
  "reason": "objectionable",
  "details": "Inappropriate photo"
}
```

**Response `201 Created`:**
```json
{
  "id": "c4f1e8b0-1234-4567-89ab-cdef01234567",
  "status": "open",
  "created_at": "2026-11-08T01:31:00.000Z"
}
```

### 2.4 `POST /v1/blocks`
Blocks a user (and optionally reports their item in the same call).

**Request:**
```json
{
  "blocked_user_id": "99999999-0000-0000-0000-000000000002"
}
```

**Response `200 OK`:**
```json
{
  "blocker_id": "2ae6284c-246d-4c35-bc08-7936ee643e19",
  "blocked_user_id": "99999999-0000-0000-0000-000000000002",
  "created_at": "2026-11-08T01:32:00.000Z"
}
```

### 2.5 `DELETE /v1/blocks/:blockedUserId`
Unblocks a previously blocked user.

**Response `200 OK`:**
```json
{
  "unblocked_user_id": "99999999-0000-0000-0000-000000000002"
}
```

### 2.6 `POST /v1/webhooks/content`
Receives Supabase Database Webhook `INSERT` / `UPDATE` payloads (`{ type, table, schema, record, old_record }`), authenticates via `x-modkit-webhook-secret` header (or Bearer token), extracts text + storage image URLs via the configured content extractor, calls the classifier (`openAIClassifier` or `rekognitionClassifier`), writes `'approved'` or `'rejected'` to `modkit.items`, and alerts on rejection if configured.

**Response `200 OK`:**
```json
{
  "target_type": "trash_pickup",
  "target_id": "df039bb9-4651-4cfa-9039-5667513802b6",
  "status": "approved",
  "flagged": false
}
```

---

## Part 3: Swift Package Public API (`ModKit`)

Package URL: `https://github.com/Liampronan/ModKit` (Product & module name: `ModKit`, iOS 18+, zero external dependencies).

### 3.1 Models & Configuration (`Sources/ModKit/`)

```swift
import Foundation
import Observation
import SwiftUI

public enum ModKitReportReason: String, CaseIterable, Codable, Sendable, Identifiable {
    case objectionable
    case spam
    case harassment
    case unsafe
    case other

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .objectionable: "Objectionable or offensive content"
        case .spam: "Spam or misleading"
        case .harassment: "Harassment or abusive behavior"
        case .unsafe: "Dangerous or illegal activity"
        case .other: "Other"
        }
    }
}

public struct ModKitHiddenItem: Codable, Hashable, Sendable {
    public let targetType: String
    public let targetId: String

    public init(targetType: String, targetId: String) {
        self.targetType = targetType
        self.targetId = targetId
    }
}

public struct ModKitUserState: Codable, Equatable, Sendable {
    public var userId: String
    public var acceptedTermsVersions: Set<String>
    public var blockedUserIds: Set<String>
    public var hiddenItems: Set<ModKitHiddenItem>

    public init(
        userId: String = "",
        acceptedTermsVersions: Set<String> = [],
        blockedUserIds: Set<String> = [],
        hiddenItems: Set<ModKitHiddenItem> = []
    ) {
        self.userId = userId
        self.acceptedTermsVersions = acceptedTermsVersions
        self.blockedUserIds = blockedUserIds
        self.hiddenItems = hiddenItems
    }
}

public struct ModKitReportInput: Codable, Equatable, Sendable {
    public var targetType: String
    public var targetId: String
    public var targetAuthorId: String?
    public var reason: ModKitReportReason
    public var details: String?

    public init(
        targetType: String,
        targetId: String,
        targetAuthorId: String? = nil,
        reason: ModKitReportReason,
        details: String? = nil
    ) {
        self.targetType = targetType
        self.targetId = targetId
        self.targetAuthorId = targetAuthorId
        self.reason = reason
        self.details = details
    }
}

public struct ModKitConfiguration: Sendable {
    public var serverURL: URL
    public var termsVersion: String
    public var termsURL: URL
    public var contactURL: URL
    public var authTokenProvider: @Sendable () async -> String?

    public init(
        serverURL: URL,
        termsVersion: String,
        termsURL: URL,
        contactURL: URL,
        authTokenProvider: @escaping @Sendable () async -> String?
    ) {
        self.serverURL = serverURL
        self.termsVersion = termsVersion
        self.termsURL = termsURL
        self.contactURL = contactURL
        self.authTokenProvider = authTokenProvider
    }
}
```

### 3.2 Client Struct (`ModKitClient`) — Compatible with `swift-dependencies`

Designed as a struct of closures (matching `PickupClient` and `AuthenticationClient` in `trash-app/ios/trash app/AppClients.swift`):

```swift
public struct ModKitClient: Sendable {
    public var fetchState: @Sendable () async throws -> ModKitUserState
    public var acceptTerms: @Sendable (_ version: String) async throws -> Void
    public var submitReport: @Sendable (_ input: ModKitReportInput) async throws -> Void
    public var blockUser: @Sendable (_ userId: String) async throws -> Void
    public var unblockUser: @Sendable (_ userId: String) async throws -> Void

    public init(
        fetchState: @escaping @Sendable () async throws -> ModKitUserState,
        acceptTerms: @escaping @Sendable (_ version: String) async throws -> Void,
        submitReport: @escaping @Sendable (_ input: ModKitReportInput) async throws -> Void,
        blockUser: @escaping @Sendable (_ userId: String) async throws -> Void,
        unblockUser: @escaping @Sendable (_ userId: String) async throws -> Void
    ) {
        self.fetchState = fetchState
        self.acceptTerms = acceptTerms
        self.submitReport = submitReport
        self.blockUser = blockUser
        self.unblockUser = unblockUser
    }

    /// Live HTTP `/v1` client talking to the ModKit Edge Function / Node server.
    public static func live(configuration: ModKitConfiguration, session: URLSession = .shared) -> Self

    /// Offline / preview stub that succeeds in-memory without network calls.
    public static func fixture(initialState: ModKitUserState = .init(acceptedTermsVersions: ["1"])) -> Self
}
```

### 3.3 Observable Store (`ModerationStore`)

```swift
@MainActor
@Observable
public final class ModerationStore {
    public private(set) var blockedUserIds: Set<String>
    public private(set) var hiddenItems: Set<ModKitHiddenItem>
    public private(set) var acceptedTermsVersions: Set<String>
    public private(set) var hasLoaded: Bool = false
    public private(set) var isRefreshing: Bool = false
    public private(set) var error: Error?

    public let requiredTermsVersion: String
    public let termsURL: URL
    public let contactURL: URL

    public init(
        client: ModKitClient,
        requiredTermsVersion: String,
        termsURL: URL,
        contactURL: URL,
        userDefaults: UserDefaults = .standard
    )

    /// True when the current user has accepted `requiredTermsVersion` (cached locally & synced to server).
    public var hasAcceptedTerms: Bool { get }

    /// Returns false immediately if the author is blocked or the item was reported/hidden.
    public func isVisible(targetType: String, targetId: String, authorId: String) -> Bool

    /// Loads state from server and merges with local cache.
    public func refresh() async

    /// Records terms acceptance optimistically and persists to backend.
    public func acceptTerms() async throws

    /// Optimistically hides the item immediately, calls `onHide`, and submits the report to the backend.
    public func report(_ input: ModKitReportInput, onHide: (() -> Void)? = nil) async throws

    /// Optimistically adds `userId` to `blockedUserIds` immediately, calls `onHide`, and sends block to backend.
    public func blockUser(_ userId: String, onHide: (() -> Void)? = nil) async throws

    /// Removes `userId` from `blockedUserIds` and sends unblock to backend.
    public func unblockUser(_ userId: String) async throws
}
```

### 3.4 SwiftUI Components

1. **`ModerationMenu`** — Drop-in `•••` button + sheet/confirmation dialogs for stories or map popups:
   ```swift
   public struct ModerationMenu: View {
       public init(
           targetType: String,
           targetId: String,
           authorId: String,
           currentUserId: String? = nil,
           store: ModerationStore,
           onHide: @escaping () -> Void = {}
       )
       public var body: some View
   }
   ```
   - Automatically hides itself when `currentUserId?.lowercased() == authorId.lowercased()` (users don't report/block themselves).
   - Accessibility identifiers: `"modkit.menu"`, `"modkit.report"`, `"modkit.block"`.

2. **`.modKitTermsGate(store:isEnabled:)`** — View modifier presenting the zero-tolerance EULA sheet until accepted:
   ```swift
   extension View {
       public func modKitTermsGate(
           store: ModerationStore,
           isEnabled: Bool = true
       ) -> some View
   }
   ```
   - Displays clear summary of zero tolerance for objectionable content or abusive users, link to `store.termsURL`, and **"Agree and Continue"** button (`accessibilityIdentifier("modkit.terms.accept")`).

3. **`ModerationSettingsSection` & `BlockedUsersView`** — Drop-in rows for `SettingsView`:
   ```swift
   public struct ModerationSettingsSection: View {
       public init(store: ModerationStore)
       public var body: some View
   }

   public struct BlockedUsersView: View {
       public init(store: ModerationStore, onUnblock: @escaping () -> Void = {})
       public var body: some View
   }
   ```
   - Renders:
     - `NavigationLink("Blocked Users")` → `BlockedUsersView` (shows blocked IDs with `"Unblock"` button)
     - `Link("Terms of Use", destination: store.termsURL)`
     - `Link("Contact & Support", destination: store.contactURL)`

---

## Part 4: `trash-app` Step-by-Step Implementation Guide

Once `ModKit` `1.0.0-beta.1` is tagged, here is the exact implementation plan for `trash-app`.

### Step 1: `supabase/` Backend Adoption in `trash-app`

1. **Copy ModKit migration (`supabase/migrations/<timestamp>_modkit_v1.sql`)**:
   ```sh
   npx modkit-server migrations copy ./supabase/migrations
   ```
2. **Add `trash-app` RLS Policy Migration (`supabase/migrations/<timestamp>_trash_pickups_moderation_rls.sql`)**:
   ```sql
   -- 1. Replace the permissive `using (true)` SELECT policy on trash_pickups
   DROP POLICY IF EXISTS "Viewable by all users" ON public.trash_pickups;

   CREATE POLICY "Viewable if approved and not blocked or banned"
   ON public.trash_pickups
   FOR SELECT
   TO authenticated
   USING (
     modkit.is_visible(
       auth.uid()::text,
       user_id::text,
       'trash_pickup',
       id::text,
       'post' -- or 'pre' if pre-moderation is selected
     )
   );

   -- 2. Prevent banned users (and optionally anonymous users) from inserting pickups
   DROP POLICY IF EXISTS "Enable insert for authenticated users only" ON public.trash_pickups;

   CREATE POLICY "Insert allowed for non-banned users"
   ON public.trash_pickups
   FOR INSERT
   TO authenticated
   WITH CHECK (
     auth.uid() = user_id
     AND NOT modkit.is_banned(auth.uid()::text)
   );

   -- 3. Gate storage.objects downloads in `trash-pickup-images` so hidden pickups' photos are not downloadable
   DROP POLICY IF EXISTS "Authenticated users can download trash pickup images" ON storage.objects;

   CREATE POLICY "Download allowed for visible pickups only"
   ON storage.objects
   FOR SELECT
   TO authenticated
   USING (
     bucket_id = 'trash-pickup-images'
     AND (
       owner = auth.uid()
       OR EXISTS (
         SELECT 1 FROM public.trash_pickups tp
         WHERE (tp.after_photo_key = storage.objects.name OR tp.before_photo_key = storage.objects.name)
           AND modkit.is_visible(auth.uid()::text, tp.user_id::text, 'trash_pickup', tp.id::text, 'post')
       )
     )
   );
   ```
3. **Create the Edge Function (`supabase/functions/modkit/index.ts`)**:
   ```ts
   import {
     createModKitServer,
     openAIClassifier,
     postgresStore,
     slackNotifier,
     supabaseJwt,
     supabaseStorage,
   } from 'npm:modkit-server@1.0.0-beta.1'

   const supabaseUrl = Deno.env.get('SUPABASE_URL')!
   const store = postgresStore({
     url: Deno.env.get('MODKIT_DB_POOLER_URL')!,
     max: 2,
     prepare: false,
     fetchTypes: false,
   })

   const storage = supabaseStorage({
     url: supabaseUrl,
     serviceRoleKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
     bucket: 'trash-pickup-images',
   })

   Deno.serve(
     createModKitServer({
       store,
       authenticate: [
         supabaseJwt({
           jwksUrl: `${supabaseUrl}/auth/v1/.well-known/jwks.json`,
           secret: Deno.env.get('MODKIT_JWT_SECRET'),
         }),
       ],
       webhookSecret: Deno.env.get('MODKIT_WEBHOOK_SECRET'),
       classifier: openAIClassifier({
         apiKey: Deno.env.get('OPENAI_API_KEY')!,
       }),
       notifier: slackNotifier({
         webhookUrl: Deno.env.get('SLACK_WEBHOOK_URL')!,
       }),
       contentExtractor: async (payload) => {
         const row = payload.record
         const keys = [row.before_photo_key, row.after_photo_key].filter(Boolean) as string[]
         const imageUrls = await Promise.all(keys.map((key) => storage.createSignedReadUrl(key, 300)))
         return {
           targetType: 'trash_pickup',
           targetId: String(row.id),
           authorId: String(row.user_id),
           text: typeof row.description === 'string' ? row.description : '',
           imageUrls,
         }
       },
     }),
   )
   ```

---

### Step 2: iOS Client Adoption in `trash-app` (`ios/`)

#### 1. Register `ModKitClient` in [`AppClients.swift`](file:///Users/agent-liam/code/trash-app/ios/trash%20app/AppClients.swift)
Add `ModKit` dependency to `trash app.xcodeproj` (`https://github.com/Liampronan/ModKit`, version `1.0.0-beta.1`) and register `modKitClient`:

```swift
import ModKit

extension ModKitClient: DependencyKey {
    public static let liveValue: ModKitClient = {
        ModKitClient.live(
            configuration: ModKitConfiguration(
                serverURL: URL(string: (Bundle.main.object(forInfoDictionaryKey: "SUPABASE_API_URL") as? String ?? "https://example.supabase.co") + "/functions/v1/modkit")!,
                termsVersion: "2026-11-01",
                termsURL: URL(string: "https://trashapp.cc/terms")!,
                contactURL: URL(string: "https://trashapp.cc/support")!,
                authTokenProvider: {
                    try? await LiveBackend.client.get().supabaseClient.auth.session.accessToken
                }
            )
        )
    }()

    public static let previewValue = ModKitClient.fixture(
        initialState: ModKitUserState(acceptedTermsVersions: ["2026-11-01"])
    )

    public static let testValue = ModKitClient(
        fetchState: { throw ClientError.unimplemented },
        acceptTerms: { _ in throw ClientError.unimplemented },
        submitReport: { _ in throw ClientError.unimplemented },
        blockUser: { _ in throw ClientError.unimplemented },
        unblockUser: { _ in throw ClientError.unimplemented }
    )
}

extension DependencyValues {
    var modKitClient: ModKitClient {
        get { self[ModKitClient.self] }
        set { self[ModKitClient.self] = newValue }
    }
}
```

#### 2. Add `ModerationStore` & Filtering to [`PickupStore.swift`](file:///Users/agent-liam/code/trash-app/ios/trash%20app/PickupStore.swift) and [`trash_appApp.swift`](file:///Users/agent-liam/code/trash-app/ios/trash%20app/trash_appApp.swift)
- In `AppEnvironment` ([`trash_appApp.swift`](file:///Users/agent-liam/code/trash-app/ios/trash%20app/trash_appApp.swift#L51-L63)), own `let moderationStore: ModerationStore` and inject `.environment(environment.moderationStore)`.
- In `PickupStore` ([`PickupStore.swift`](file:///Users/agent-liam/code/trash-app/ios/trash%20app/PickupStore.swift#L23-L70)), add synchronous local removal helpers so reporting a pickup or blocking an author removes their pickups from `pickups` immediately under a new `RequestGeneration`:
  ```swift
  func removePickup(id: UUID) async {
      await commitMutation { $0.removeAll { $0.id == id } }
  }

  func removePickups(byAuthor userId: UUID) async {
      await commitMutation { $0.removeAll { $0.userId == userId } }
  }
  ```
- Attach `.modKitTermsGate(store: environment.moderationStore, isEnabled: !AppEnvironment.isOfflineTesting || ProcessInfo.processInfo.arguments.contains("-require-terms"))` on the `TrashMapView` branch in `trash_appApp.swift`.

#### 3. Add `ModerationMenu` to [`StoryHStack.swift`](file:///Users/agent-liam/code/trash-app/ios/trash%20app/StoryHStack.swift) (`StoryPlayer`)
In [`StoryPlayer`](file:///Users/agent-liam/code/trash-app/ios/trash%20app/StoryHStack.swift#L53-L68), place `ModerationMenu` in the top bar next to the close (`xmark`) button:
```swift
@Environment(ModerationStore.self) private var moderationStore
@Environment(PickupStore.self) private var pickupStore
@Environment(SessionStore.self) private var sessionStore

// Inside StoryPlayer top HStack, next to the xmark dismiss button:
if currentIndex < storyPlaylist.items.count,
   let currentItem = storyPlaylist.items[currentIndex] as? TrashPickup {
    ModerationMenu(
        targetType: "trash_pickup",
        targetId: currentItem.id.uuidString,
        authorId: currentItem.userId.uuidString,
        currentUserId: sessionStore.user?.id,
        store: moderationStore,
        onHide: {
            Task {
                if moderationStore.blockedUserIds.contains(currentItem.userId.uuidString.lowercased()) {
                    await pickupStore.removePickups(byAuthor: currentItem.userId)
                } else {
                    await pickupStore.removePickup(id: currentItem.id)
                }
                dismiss()
            }
        }
    )
}
```
*(Pause `autoAdvanceTask` while the report/block sheet is presented, or let `ModerationMenu`'s `onPresentationChanged: (Bool) -> Void` callback pause/resume `autoAdvanceTask`.)*

#### 4. Add Terms, Contact, and Blocked Users to [`SettingsView.swift`](file:///Users/agent-liam/code/trash-app/ios/trash%20app/Map/SettingsView.swift)
In [`SettingsView`](file:///Users/agent-liam/code/trash-app/ios/trash%20app/Map/SettingsView.swift#L54-L69), read `@Environment(ModerationStore.self) private var moderationStore` and `@Environment(PickupStore.self) private var pickupStore` and include:
```swift
ModerationSettingsSection(
    store: moderationStore,
    onUnblock: {
        Task { await pickupStore.refresh() }
    }
)
```
This adds the **Blocked Users** navigation row, **Terms of Use** link, and **Contact & Support** link required by App Store Review Guideline 1.2.
