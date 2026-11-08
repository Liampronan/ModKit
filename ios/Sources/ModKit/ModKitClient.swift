import Foundation

private final class FixtureStateBox: @unchecked Sendable {
    private let lock = NSLock()
    private var state: ModKitUserState

    init(_ initialState: ModKitUserState) {
        self.state = initialState
    }

    func withLock<R>(_ body: (inout ModKitUserState) throws -> R) rethrows -> R {
        lock.lock()
        defer { lock.unlock() }
        return try body(&state)
    }
}

private struct ServerErrorEnvelope: Decodable {
    struct ErrorDetail: Decodable {
        let code: String?
        let message: String?
    }
    let error: ErrorDetail?
}

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
    public static func live(
        configuration: ModKitConfiguration,
        session: URLSession = .shared
    ) -> Self {
        @Sendable
        func makeRequest(
            method: String,
            path: String,
            bodyData: Data? = nil
        ) async throws -> (Data, HTTPURLResponse) {
            guard let rawToken = await configuration.authTokenProvider(),
                  !rawToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                throw ModKitAPIError.missingAuthToken
            }
            let token = rawToken.trimmingCharacters(in: .whitespacesAndNewlines)
            let baseString = configuration.serverURL.absoluteString.trimmingCharacters(
                in: CharacterSet(charactersIn: "/")
            )
            let normalizedPath = path.hasPrefix("/") ? path : "/\(path)"
            guard let url = URL(string: "\(baseString)\(normalizedPath)") else {
                throw ModKitAPIError.invalidURL(path)
            }

            var request = URLRequest(url: url)
            request.httpMethod = method
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            if let bodyData {
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                request.httpBody = bodyData
            }

            let (data, response) = try await session.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse else {
                throw ModKitAPIError.invalidResponse
            }

            guard (200..<300).contains(httpResponse.statusCode) else {
                if let envelope = try? JSONDecoder().decode(ServerErrorEnvelope.self, from: data),
                   let err = envelope.error,
                   let message = err.message {
                    throw ModKitAPIError.serverError(
                        statusCode: httpResponse.statusCode,
                        code: err.code ?? "error",
                        message: message
                    )
                }
                let bodyText = String(data: data, encoding: .utf8) ?? ""
                throw ModKitAPIError.httpError(statusCode: httpResponse.statusCode, body: bodyText)
            }

            return (data, httpResponse)
        }

        return Self(
            fetchState: {
                let (data, _) = try await makeRequest(method: "GET", path: "/v1/state")
                return try JSONDecoder().decode(ModKitUserState.self, from: data)
            },
            acceptTerms: { version in
                let payload = try JSONEncoder().encode(["terms_version": version])
                _ = try await makeRequest(
                    method: "POST",
                    path: "/v1/terms/accept",
                    bodyData: payload
                )
            },
            submitReport: { input in
                let payload = try JSONEncoder().encode(input)
                _ = try await makeRequest(
                    method: "POST",
                    path: "/v1/reports",
                    bodyData: payload
                )
            },
            blockUser: { userId in
                let payload = try JSONEncoder().encode(["blocked_user_id": userId])
                _ = try await makeRequest(
                    method: "POST",
                    path: "/v1/blocks",
                    bodyData: payload
                )
            },
            unblockUser: { userId in
                var allowed = CharacterSet.urlPathAllowed
                allowed.remove(charactersIn: "/")
                let encoded = userId.addingPercentEncoding(withAllowedCharacters: allowed) ?? userId
                _ = try await makeRequest(
                    method: "DELETE",
                    path: "/v1/blocks/\(encoded)"
                )
            }
        )
    }

    /// Offline / preview stub that succeeds in-memory without network calls.
    public static func fixture(
        initialState: ModKitUserState = .init(acceptedTermsVersions: ["1"])
    ) -> Self {
        let box = FixtureStateBox(initialState)
        return Self(
            fetchState: {
                box.withLock { $0 }
            },
            acceptTerms: { version in
                box.withLock { state in
                    _ = state.acceptedTermsVersions.insert(version)
                }
            },
            submitReport: { input in
                box.withLock { state in
                    _ = state.hiddenItems.insert(
                        ModKitHiddenItem(targetType: input.targetType, targetId: input.targetId)
                    )
                }
            },
            blockUser: { userId in
                box.withLock { state in
                    _ = state.blockedUserIds.insert(userId.lowercased())
                }
            },
            unblockUser: { userId in
                box.withLock { state in
                    let target = userId.lowercased()
                    state.blockedUserIds = Set(
                        state.blockedUserIds.filter { $0.lowercased() != target }
                    )
                }
            }
        )
    }
}
