import Foundation
import SwiftUI
import XCTest
@testable import ModKit

private final class LockedBox<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: Value

    init(_ value: Value) {
        self.storage = value
    }

    func withLock<R>(_ body: (inout Value) throws -> R) rethrows -> R {
        lock.lock()
        defer { lock.unlock() }
        return try body(&storage)
    }
}

private final class StubURLProtocol: URLProtocol {
    typealias Handler = @Sendable (URLRequest, Data?) throws -> (HTTPURLResponse, Data)
    private static let handlerBox = LockedBox<Handler?>(nil)

    static func setHandler(_ handler: Handler?) {
        handlerBox.withLock { $0 = handler }
    }

    override class func canInit(with request: URLRequest) -> Bool {
        true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        let handler = Self.handlerBox.withLock { $0 }
        guard let handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }

        let bodyData = Self.readBody(from: request)
        do {
            let (response, data) = try handler(request, bodyData)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}

    private static func readBody(from request: URLRequest) -> Data? {
        if let httpBody = request.httpBody {
            return httpBody
        }
        guard let stream = request.httpBodyStream else {
            return nil
        }
        stream.open()
        defer { stream.close() }
        var data = Data()
        let bufferSize = 4096
        let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: bufferSize)
        defer { buffer.deallocate() }
        while stream.hasBytesAvailable {
            let readCount = stream.read(buffer, maxLength: bufferSize)
            if readCount > 0 {
                data.append(buffer, count: readCount)
            } else {
                break
            }
        }
        return data
    }
}

final class ModKitTests: XCTestCase {
    override func tearDown() {
        StubURLProtocol.setHandler(nil)
        super.tearDown()
    }

    private func makeStubSession() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubURLProtocol.self]
        return URLSession(configuration: config)
    }

    @MainActor
    func testModerationStoreOptimisticReportBlockUnblockAndCaching() async throws {
        let suiteName = "ModKitTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defer { defaults.removePersistentDomain(forName: suiteName) }

        let client = ModKitClient.fixture(initialState: ModKitUserState(userId: "user-1"))
        let store = ModerationStore(
            client: client,
            requiredTermsVersion: "2026-11-01",
            termsURL: URL(string: "https://trashapp.cc/terms")!,
            contactURL: URL(string: "https://trashapp.cc/support")!,
            userDefaults: defaults
        )

        XCTAssertFalse(store.hasAcceptedTerms)
        try await store.acceptTerms()
        XCTAssertTrue(store.hasAcceptedTerms)

        var hideCount = 0
        try await store.report(
            ModKitReportInput(
                targetType: "trash_pickup",
                targetId: "pickup-1",
                targetAuthorId: "author-1",
                reason: .objectionable,
                details: "Bad photo"
            ),
            onHide: { hideCount += 1 }
        )
        XCTAssertEqual(hideCount, 1)
        XCTAssertFalse(store.isVisible(targetType: "trash_pickup", targetId: "pickup-1", authorId: "author-1"))
        XCTAssertTrue(store.isVisible(targetType: "trash_pickup", targetId: "pickup-2", authorId: "author-1"))

        try await store.blockUser("Author-1", onHide: { hideCount += 1 })
        XCTAssertEqual(hideCount, 2)
        XCTAssertFalse(store.isVisible(targetType: "trash_pickup", targetId: "pickup-2", authorId: "author-1"))

        // Second store instance initialized with same UserDefaults reads cached state immediately
        let cachedStore = ModerationStore(
            client: client,
            requiredTermsVersion: "2026-11-01",
            termsURL: URL(string: "https://trashapp.cc/terms")!,
            contactURL: URL(string: "https://trashapp.cc/support")!,
            userDefaults: defaults
        )
        XCTAssertTrue(cachedStore.hasAcceptedTerms)
        XCTAssertFalse(cachedStore.isVisible(targetType: "trash_pickup", targetId: "pickup-2", authorId: "author-1"))

        try await store.unblockUser("author-1")
        XCTAssertTrue(store.isVisible(targetType: "trash_pickup", targetId: "pickup-2", authorId: "author-1"))
        // Reported item remains hidden even after unblocking author
        XCTAssertFalse(store.isVisible(targetType: "trash_pickup", targetId: "pickup-1", authorId: "author-1"))
    }

    func testLiveClientWireProtocolMatchesServerSpec() async throws {
        let recordedRequests = LockedBox<[(method: String, path: String, auth: String?, body: String?)]>([])

        StubURLProtocol.setHandler { request, bodyData in
            let method = request.httpMethod ?? "GET"
            let path = request.url?.path ?? ""
            let auth = request.value(forHTTPHeaderField: "Authorization")
            let body = bodyData.flatMap { String(data: $0, encoding: .utf8) }
            recordedRequests.withLock { $0.append((method, path, auth, body)) }

            let responseURL = request.url ?? URL(string: "https://example.supabase.co")!
            if method == "GET" && path.hasSuffix("/v1/state") {
                let json = """
                {
                  "user_id": "2ae6284c-246d-4c35-bc08-7936ee643e19",
                  "accepted_terms_versions": ["2026-11-01"],
                  "blocked_user_ids": ["99999999-0000-0000-0000-000000000002"],
                  "hidden_items": [
                    { "target_type": "trash_pickup", "target_id": "df039bb9-4651-4cfa-9039-5667513802b6" }
                  ]
                }
                """
                let resp = HTTPURLResponse(url: responseURL, statusCode: 200, httpVersion: nil, headerFields: nil)!
                return (resp, Data(json.utf8))
            }

            if method == "POST" && path.hasSuffix("/v1/reports") {
                let json = """
                { "id": "c4f1e8b0-1234-4567-89ab-cdef01234567", "status": "open", "created_at": "2026-11-08T01:31:00.000Z" }
                """
                let resp = HTTPURLResponse(url: responseURL, statusCode: 201, httpVersion: nil, headerFields: nil)!
                return (resp, Data(json.utf8))
            }

            let resp = HTTPURLResponse(url: responseURL, statusCode: 200, httpVersion: nil, headerFields: nil)!
            return (resp, Data("{}".utf8))
        }

        let session = makeStubSession()
        let config = ModKitConfiguration(
            serverURL: URL(string: "https://example.supabase.co/functions/v1/modkit")!,
            termsVersion: "2026-11-01",
            termsURL: URL(string: "https://trashapp.cc/terms")!,
            contactURL: URL(string: "https://trashapp.cc/support")!,
            authTokenProvider: { "supabase-jwt-token" }
        )
        let client = ModKitClient.live(configuration: config, session: session)

        let state = try await client.fetchState()
        XCTAssertEqual(state.userId, "2ae6284c-246d-4c35-bc08-7936ee643e19")
        XCTAssertEqual(state.acceptedTermsVersions, ["2026-11-01"])
        XCTAssertEqual(state.blockedUserIds, ["99999999-0000-0000-0000-000000000002"])
        XCTAssertEqual(
            state.hiddenItems,
            [ModKitHiddenItem(targetType: "trash_pickup", targetId: "df039bb9-4651-4cfa-9039-5667513802b6")]
        )

        try await client.acceptTerms("2026-11-01")
        try await client.submitReport(
            ModKitReportInput(
                targetType: "trash_pickup",
                targetId: "df039bb9-4651-4cfa-9039-5667513802b6",
                targetAuthorId: "99999999-0000-0000-0000-000000000002",
                reason: .objectionable,
                details: "Inappropriate photo"
            )
        )
        try await client.blockUser("99999999-0000-0000-0000-000000000002")
        try await client.unblockUser("99999999-0000-0000-0000-000000000002")

        let calls = recordedRequests.withLock { $0 }
        XCTAssertEqual(calls.count, 5)
        XCTAssertEqual(calls[0].method, "GET")
        XCTAssertEqual(calls[0].path, "/functions/v1/modkit/v1/state")
        XCTAssertEqual(calls[0].auth, "Bearer supabase-jwt-token")

        XCTAssertEqual(calls[1].method, "POST")
        XCTAssertEqual(calls[1].path, "/functions/v1/modkit/v1/terms/accept")

        XCTAssertEqual(calls[2].method, "POST")
        XCTAssertEqual(calls[2].path, "/functions/v1/modkit/v1/reports")

        XCTAssertEqual(calls[3].method, "POST")
        XCTAssertEqual(calls[3].path, "/functions/v1/modkit/v1/blocks")

        XCTAssertEqual(calls[4].method, "DELETE")
        XCTAssertEqual(calls[4].path, "/functions/v1/modkit/v1/blocks/99999999-0000-0000-0000-000000000002")
    }

    @MainActor
    func testSwiftUIComponentsInstantiateCleanly() {
        let store = ModerationStore(
            client: .fixture(),
            requiredTermsVersion: "2026-11-01",
            termsURL: URL(string: "https://trashapp.cc/terms")!,
            contactURL: URL(string: "https://trashapp.cc/support")!
        )

        let menu = ModerationMenu(
            targetType: "trash_pickup",
            targetId: "p-1",
            authorId: "author-1",
            currentUserId: "viewer-1",
            store: store
        )
        XCTAssertNotNil(menu.body)

        let settingsSection = ModerationSettingsSection(store: store)
        XCTAssertNotNil(settingsSection.body)

        let blockedView = BlockedUsersView(store: store)
        XCTAssertNotNil(blockedView.body)

        let gatedView = Text("Root").modKitTermsGate(store: store, isEnabled: true)
        XCTAssertNotNil(gatedView)
    }
}
