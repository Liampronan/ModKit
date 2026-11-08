import Foundation

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

    enum CodingKeys: String, CodingKey {
        case targetType = "target_type"
        case targetId = "target_id"
    }

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

    enum CodingKeys: String, CodingKey {
        case userId = "user_id"
        case acceptedTermsVersions = "accepted_terms_versions"
        case blockedUserIds = "blocked_user_ids"
        case hiddenItems = "hidden_items"
    }

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

    enum CodingKeys: String, CodingKey {
        case targetType = "target_type"
        case targetId = "target_id"
        case targetAuthorId = "target_author_id"
        case reason
        case details
    }

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

public enum ModKitAPIError: Error, LocalizedError, Sendable, Equatable {
    case missingAuthToken
    case invalidURL(String)
    case invalidResponse
    case serverError(statusCode: Int, code: String, message: String)
    case httpError(statusCode: Int, body: String)

    public var errorDescription: String? {
        switch self {
        case .missingAuthToken:
            return "No authentication token is currently available."
        case .invalidURL(let path):
            return "Invalid ModKit server URL for path: \(path)."
        case .invalidResponse:
            return "Received an invalid HTTP response from the ModKit server."
        case .serverError(_, _, let message):
            return message
        case .httpError(let statusCode, let body):
            return body.isEmpty ? "HTTP error \(statusCode)." : "HTTP error \(statusCode): \(body)"
        }
    }
}
