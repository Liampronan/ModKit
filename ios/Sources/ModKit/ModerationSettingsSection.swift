import SwiftUI

public struct ModerationSettingsSection: View {
    private let store: ModerationStore
    private let onUnblock: () -> Void

    public init(
        store: ModerationStore,
        onUnblock: @escaping () -> Void = {}
    ) {
        self.store = store
        self.onUnblock = onUnblock
    }

    public var body: some View {
        Section("Safety & Legal") {
            NavigationLink("Blocked Users") {
                BlockedUsersView(store: store, onUnblock: onUnblock)
            }
            .accessibilityIdentifier("modkit.settings.blockedUsers")

            Link("Terms of Use", destination: store.termsURL)
                .accessibilityIdentifier("modkit.settings.terms")

            Link("Contact & Support", destination: store.contactURL)
                .accessibilityIdentifier("modkit.settings.contact")
        }
    }
}

public struct BlockedUsersView: View {
    private let store: ModerationStore
    private let onUnblock: () -> Void

    public init(
        store: ModerationStore,
        onUnblock: @escaping () -> Void = {}
    ) {
        self.store = store
        self.onUnblock = onUnblock
    }

    private var sortedBlockedIds: [String] {
        Array(store.blockedUserIds).sorted()
    }

    public var body: some View {
        List {
            if sortedBlockedIds.isEmpty {
                Text("No blocked users.")
                    .foregroundStyle(.secondary)
            } else {
                ForEach(sortedBlockedIds, id: \.self) { blockedId in
                    HStack {
                        Text(blockedId)
                            .font(.footnote.monospaced())
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Spacer()
                        Button("Unblock") {
                            Task {
                                try? await store.unblockUser(blockedId)
                                onUnblock()
                            }
                        }
                        .buttonStyle(.bordered)
                        .accessibilityIdentifier("modkit.unblock.\(blockedId)")
                    }
                }
            }
        }
        .navigationTitle("Blocked Users")
    }
}
