# ModKit iOS SDK (`ModKit`)

Zero-dependency Swift 6 / SwiftUI package (`iOS 18+`, `macOS 15+`) providing client state, optimistic content hiding, and drop-in SwiftUI views for App Store Review Guideline 1.2.

## Installation

Add `https://github.com/Liampronan/ModKit` (version `1.0.0-beta.1`) in Xcode (**File → Add Package Dependencies…**) or in your `Package.swift`:

```swift
.package(url: "https://github.com/Liampronan/ModKit.git", from: "1.0.0-beta.1")
```

## Core Types

- **`ModKitClient`** — Struct of `@Sendable` closures (`fetchState`, `acceptTerms`, `submitReport`, `blockUser`, `unblockUser`) with `.live(configuration:session:)` and `.fixture(initialState:)` factories. Designed for direct registration with `swift-dependencies` (`DependencyKey`).
- **`ModerationStore`** — `@MainActor @Observable` store that caches accepted EULA versions, blocked user IDs, and hidden item IDs in `UserDefaults` for instant synchronous filtering via `store.isVisible(targetType:targetId:authorId:)`.
- **`ModerationMenu`** — Drop-in `•••` menu presenting a Report Content sheet and Block User confirmation dialog. Automatically hides itself when `currentUserId == authorId`.
- **`.modKitTermsGate(store:isEnabled:)`** — Non-dismissible sheet requiring agreement to zero-tolerance community guidelines before accessing UGC.
- **`ModerationSettingsSection` & `BlockedUsersView`** — Drop-in `SettingsView` section providing **Blocked Users** management, **Terms of Use**, and **Contact & Support** links.
