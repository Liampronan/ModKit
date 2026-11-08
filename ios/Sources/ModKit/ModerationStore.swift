import Foundation
import Observation

@MainActor
@Observable
public final class ModerationStore {
    private static let termsDefaultsKey = "modkit.accepted_terms_versions"
    private static let blockedDefaultsKey = "modkit.blocked_user_ids"
    private static let hiddenDefaultsKey = "modkit.hidden_items"

    public private(set) var blockedUserIds: Set<String> = []
    public private(set) var hiddenItems: Set<ModKitHiddenItem> = []
    public private(set) var acceptedTermsVersions: Set<String> = []
    public private(set) var hasLoaded: Bool = false
    public private(set) var isRefreshing: Bool = false
    public private(set) var error: Error?

    public let requiredTermsVersion: String
    public let termsURL: URL
    public let contactURL: URL

    private let client: ModKitClient
    private let userDefaults: UserDefaults

    public init(
        client: ModKitClient,
        requiredTermsVersion: String,
        termsURL: URL,
        contactURL: URL,
        userDefaults: UserDefaults = .standard
    ) {
        self.client = client
        self.requiredTermsVersion = requiredTermsVersion
        self.termsURL = termsURL
        self.contactURL = contactURL
        self.userDefaults = userDefaults

        if let cachedTerms = userDefaults.stringArray(forKey: Self.termsDefaultsKey) {
            self.acceptedTermsVersions = Set(cachedTerms)
        }
        if let cachedBlocked = userDefaults.stringArray(forKey: Self.blockedDefaultsKey) {
            self.blockedUserIds = Set(cachedBlocked.map { $0.lowercased() })
        }
        if let cachedHiddenData = userDefaults.data(forKey: Self.hiddenDefaultsKey),
           let decodedHidden = try? JSONDecoder().decode([ModKitHiddenItem].self, from: cachedHiddenData) {
            self.hiddenItems = Set(decodedHidden)
        }
    }

    /// True when the current user has accepted `requiredTermsVersion` (cached locally & synced to server).
    public var hasAcceptedTerms: Bool {
        acceptedTermsVersions.contains(requiredTermsVersion)
    }

    /// Returns false immediately if the author is blocked or the item was reported/hidden.
    public func isVisible(targetType: String, targetId: String, authorId: String) -> Bool {
        let normalizedAuthor = authorId.lowercased()
        if blockedUserIds.contains(normalizedAuthor) {
            return false
        }
        if hiddenItems.contains(ModKitHiddenItem(targetType: targetType, targetId: targetId)) {
            return false
        }
        let lowerItem = ModKitHiddenItem(
            targetType: targetType,
            targetId: targetId.lowercased()
        )
        for item in hiddenItems where item.targetType == lowerItem.targetType {
            if item.targetId.lowercased() == lowerItem.targetId {
                return false
            }
        }
        return true
    }

    /// Loads state from server and merges with local cache.
    public func refresh() async {
        isRefreshing = true
        defer {
            isRefreshing = false
            hasLoaded = true
        }

        do {
            let remote = try await client.fetchState()
            acceptedTermsVersions.formUnion(remote.acceptedTermsVersions)
            blockedUserIds = Set(remote.blockedUserIds.map { $0.lowercased() })
            hiddenItems.formUnion(remote.hiddenItems)
            error = nil
            persistToUserDefaults()
        } catch {
            self.error = error
        }
    }

    /// Records terms acceptance optimistically and persists to backend.
    public func acceptTerms() async throws {
        acceptedTermsVersions.insert(requiredTermsVersion)
        persistToUserDefaults()
        do {
            try await client.acceptTerms(requiredTermsVersion)
            error = nil
        } catch {
            self.error = error
            throw error
        }
    }

    /// Optimistically hides the item immediately, calls `onHide`, and submits the report to the backend.
    public func report(_ input: ModKitReportInput, onHide: (() -> Void)? = nil) async throws {
        hiddenItems.insert(
            ModKitHiddenItem(targetType: input.targetType, targetId: input.targetId)
        )
        persistToUserDefaults()
        onHide?()
        do {
            try await client.submitReport(input)
            error = nil
        } catch {
            self.error = error
            throw error
        }
    }

    /// Optimistically adds `userId` to `blockedUserIds` immediately, calls `onHide`, and sends block to backend.
    public func blockUser(_ userId: String, onHide: (() -> Void)? = nil) async throws {
        let normalized = userId.lowercased()
        blockedUserIds.insert(normalized)
        persistToUserDefaults()
        onHide?()
        do {
            try await client.blockUser(userId)
            error = nil
        } catch {
            self.error = error
            throw error
        }
    }

    /// Removes `userId` from `blockedUserIds` and sends unblock to backend.
    public func unblockUser(_ userId: String) async throws {
        let normalized = userId.lowercased()
        blockedUserIds = Set(blockedUserIds.filter { $0.lowercased() != normalized })
        persistToUserDefaults()
        do {
            try await client.unblockUser(userId)
            error = nil
        } catch {
            self.error = error
            throw error
        }
    }

    private func persistToUserDefaults() {
        userDefaults.set(Array(acceptedTermsVersions).sorted(), forKey: Self.termsDefaultsKey)
        userDefaults.set(Array(blockedUserIds).sorted(), forKey: Self.blockedDefaultsKey)
        if let encodedHidden = try? JSONEncoder().encode(Array(hiddenItems)) {
            userDefaults.set(encodedHidden, forKey: Self.hiddenDefaultsKey)
        }
    }
}
