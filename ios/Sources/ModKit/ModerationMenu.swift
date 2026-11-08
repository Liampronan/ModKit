import SwiftUI

public struct ModerationMenu: View {
    private let targetType: String
    private let targetId: String
    private let authorId: String
    private let currentUserId: String?
    private let store: ModerationStore
    private let onHide: () -> Void
    private let onPresentationChanged: ((Bool) -> Void)?

    @State private var isReportSheetPresented = false
    @State private var isBlockDialogPresented = false
    @State private var selectedReason: ModKitReportReason = .objectionable
    @State private var reportDetails: String = ""
    @State private var isSubmitting = false

    public init(
        targetType: String,
        targetId: String,
        authorId: String,
        currentUserId: String? = nil,
        store: ModerationStore,
        onHide: @escaping () -> Void = {},
        onPresentationChanged: ((Bool) -> Void)? = nil
    ) {
        self.targetType = targetType
        self.targetId = targetId
        self.authorId = authorId
        self.currentUserId = currentUserId
        self.store = store
        self.onHide = onHide
        self.onPresentationChanged = onPresentationChanged
    }

    private var isSelfAuthor: Bool {
        guard let currentUserId, !currentUserId.isEmpty else { return false }
        return currentUserId.lowercased() == authorId.lowercased()
    }

    public var body: some View {
        if !isSelfAuthor {
            Menu {
                Button(role: .destructive) {
                    selectedReason = .objectionable
                    reportDetails = ""
                    isReportSheetPresented = true
                    onPresentationChanged?(true)
                } label: {
                    Label("Report Content", systemImage: "flag")
                }
                .accessibilityIdentifier("modkit.report")

                Button(role: .destructive) {
                    isBlockDialogPresented = true
                    onPresentationChanged?(true)
                } label: {
                    Label("Block User", systemImage: "hand.raised")
                }
                .accessibilityIdentifier("modkit.block")
            } label: {
                Image(systemName: "ellipsis")
                    .foregroundStyle(.primary)
                    .padding(12)
                    .background(.ultraThinMaterial)
                    .clipShape(Circle())
            }
            .accessibilityIdentifier("modkit.menu")
            .confirmationDialog(
                "Block this user?",
                isPresented: $isBlockDialogPresented,
                titleVisibility: .visible
            ) {
                Button("Block User", role: .destructive) {
                    Task {
                        try? await store.blockUser(authorId, onHide: onHide)
                        onPresentationChanged?(false)
                    }
                }
                .accessibilityIdentifier("modkit.block.confirm")

                Button("Cancel", role: .cancel) {
                    onPresentationChanged?(false)
                }
            } message: {
                Text("Their content will be hidden from your feed immediately.")
            }
            .sheet(
                isPresented: $isReportSheetPresented,
                onDismiss: {
                    onPresentationChanged?(false)
                }
            ) {
                NavigationStack {
                    Form {
                        Section("Reason") {
                            Picker("Reason", selection: $selectedReason) {
                                ForEach(ModKitReportReason.allCases) { reason in
                                    Text(reason.title).tag(reason)
                                }
                            }
                            .pickerStyle(.inline)
                            .labelsHidden()
                        }

                        Section("Additional Details (Optional)") {
                            TextField("Describe the issue…", text: $reportDetails, axis: .vertical)
                                .lineLimit(3...6)
                        }
                    }
                    .navigationTitle("Report Content")
                    #if os(iOS)
                    .navigationBarTitleDisplayMode(.inline)
                    #endif
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Cancel") {
                                isReportSheetPresented = false
                            }
                        }
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Submit") {
                                guard !isSubmitting else { return }
                                isSubmitting = true
                                let input = ModKitReportInput(
                                    targetType: targetType,
                                    targetId: targetId,
                                    targetAuthorId: authorId,
                                    reason: selectedReason,
                                    details: reportDetails.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                                        ? nil
                                        : reportDetails.trimmingCharacters(in: .whitespacesAndNewlines)
                                )
                                Task {
                                    defer { isSubmitting = false }
                                    isReportSheetPresented = false
                                    try? await store.report(input, onHide: onHide)
                                }
                            }
                            .disabled(isSubmitting)
                            .accessibilityIdentifier("modkit.report.submit")
                        }
                    }
                }
                .presentationDetents([.medium, .large])
            }
        }
    }
}
