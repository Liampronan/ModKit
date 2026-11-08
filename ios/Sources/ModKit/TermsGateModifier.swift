import SwiftUI

private struct ModKitTermsGateModifier: ViewModifier {
    @Bindable var store: ModerationStore
    let isEnabled: Bool

    private var shouldPresentSheet: Binding<Bool> {
        Binding(
            get: {
                isEnabled && !store.hasAcceptedTerms
            },
            set: { _ in }
        )
    }

    func body(content: Content) -> some View {
        content
            .sheet(isPresented: shouldPresentSheet) {
                ModKitTermsSheetView(store: store)
                    .interactiveDismissDisabled(true)
            }
    }
}

private struct ModKitTermsSheetView: View {
    let store: ModerationStore
    @State private var isAccepting = false

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 20) {
                VStack(alignment: .leading, spacing: 8) {
                    Image(systemName: "shield.lefthalf.filled.badge.checkmark")
                        .font(.system(size: 40))
                        .foregroundStyle(.tint)
                        .padding(.bottom, 4)

                    Text("Community Guidelines & Terms of Use")
                        .font(.title2.bold())

                    Text("To keep our community safe and welcoming, please review and agree to our Terms of Use before continuing.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }

                VStack(alignment: .leading, spacing: 12) {
                    Label(
                        "Zero tolerance for objectionable, offensive, or illegal content.",
                        systemImage: "exclamationmark.triangle.fill"
                    )
                    .font(.callout)

                    Label(
                        "Zero tolerance for harassment, spam, or abusive behavior.",
                        systemImage: "hand.raised.fill"
                    )
                    .font(.callout)

                    Label(
                        "Reported content is reviewed within 24 hours; violators are removed and banned.",
                        systemImage: "clock.badge.checkmark.fill"
                    )
                    .font(.callout)
                }
                .padding()
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.thinMaterial)
                .clipShape(RoundedRectangle(cornerRadius: 12))

                HStack(spacing: 16) {
                    Link("Read Full Terms of Use", destination: store.termsURL)
                        .font(.footnote.weight(.semibold))
                    Spacer()
                    Link("Contact & Support", destination: store.contactURL)
                        .font(.footnote)
                }

                Spacer()

                Button {
                    guard !isAccepting else { return }
                    isAccepting = true
                    Task {
                        defer { isAccepting = false }
                        try? await store.acceptTerms()
                    }
                } label: {
                    Text("Agree and Continue")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                }
                .buttonStyle(.borderedProminent)
                .disabled(isAccepting)
                .accessibilityIdentifier("modkit.terms.accept")
            }
            .padding(24)
        }
        .presentationDetents([.medium, .large])
    }
}

extension View {
    public func modKitTermsGate(
        store: ModerationStore,
        isEnabled: Bool = true
    ) -> some View {
        modifier(ModKitTermsGateModifier(store: store, isEnabled: isEnabled))
    }
}
