import SwiftUI

/// Settings › On-device models: the models this phone can run itself. They are downloaded here, run here, and are offered
/// to the server as this phone's own: the conversation stays on the server, where every other device can read it, but a
/// turn on one of these models is only ever started from this phone.
struct OnDeviceModelsSettings: View {
    @Bindable var store: AppStore
    private var models: LocalModelStore { .shared }
    private var hub: OnDeviceHub { .shared }
    @State private var asking: LocalModelSpec?
    private var device: String { UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone" }

    var body: some View {
        List {
            SettingsSection(footer: explanation) {
                HStack(spacing: 12) {
                    Image(systemName: "cpu").font(.system(size: 22, weight: .light)).foregroundStyle(Theme.clay)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Models on this \(device)").font(.headline)
                        Text(statusLine).font(.subheadline).foregroundStyle(Theme.inkSecondary)
                    }
                    Spacer(minLength: 0)
                    if hub.status == .ready { StatusBadge(text: "Ready", tone: .good) }
                }.padding(.vertical, 4)
            }
            SettingsSection(title: "Models", footer: "Each one downloads once from Hugging Face and stays on this \(device). Delete one any time to get the room back.") {
                ForEach(LocalModelSpec.catalog) { spec in row(spec) }
            }
            SettingsSection(title: "Downloads", footer: "Large downloads wait for Wi-Fi unless you allow mobile data.") {
                ToggleRow(title: "Use mobile data", subtitle: "For the next download.", isOn: Binding(get: { models.allowsCellular }, set: { models.allowsCellular = $0 }))
                ValueRow(title: "Used on this \(device)", value: ByteCountFormatter.string(fromByteCount: models.bytesUsed, countStyle: .file))
                ValueRow(title: "Free", value: ByteCountFormatter.string(fromByteCount: LocalModelStore.freeBytes, countStyle: .file))
            }
        }
        .navigationTitle("On-device models")
        .task { await hub.sync(store) }
        .confirmationDialog("Delete \(asking?.name ?? "this model")?", isPresented: Binding(get: { asking != nil }, set: { if !$0 { asking = nil } }), titleVisibility: .visible) {
            Button("Delete from this \(device)", role: .destructive) { if let asking { models.delete(asking) }; asking = nil }
        } message: { Text("Conversations that used it stay on your server and can go on with any other model.") }
    }

    private var explanation: String {
        "These models run on this \(device) only. Your conversations stay on your server, so you can read them anywhere, but a model on this \(device) answers only when you ask it from here. To use one, pick it in the model menu of a conversation: it works for new conversations and for ones you started elsewhere. Keep Atelier open while it answers."
    }

    private var statusLine: String {
        switch hub.status {
        case .needsNewerServer: "Your server needs to be updated before it can use models on this \(device)."
        case .needsRealServer: "Models on this \(device) work with an Atelier server, not with a computer sharing itself."
        case .failed(let why): why
        case .connecting: "Connecting to your server…"
        case .ready: models.installed.count == 1 ? "1 model, offered to your server." : "\(models.installed.count) models, offered to your server."
        case .idle: models.installed.isEmpty ? "No model downloaded yet." : "Not connected to your server."
        }
    }

    @ViewBuilder private func row(_ spec: LocalModelSpec) -> some View {
        let state = models.state(spec.id)
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(spec.name).font(.body.weight(.medium))
                    Text("\(spec.maker) · \(spec.sizeText)\(spec.thinks ? " · thinks first" : "")").font(.caption).foregroundStyle(Theme.inkMuted)
                }
                Spacer(minLength: 12)
                action(spec, state)
            }
            Text(spec.blurb).font(.footnote).foregroundStyle(Theme.inkSecondary)
            switch state {
            case .downloading(let fraction): ProgressView(value: fraction).tint(Theme.clay)
            case .waitingForWiFi: Label("Waiting for Wi-Fi", systemImage: "wifi").font(.footnote).foregroundStyle(Theme.inkMuted)
            case .failed(let why): Text(why).font(.footnote).foregroundStyle(Theme.danger)
            default: EmptyView()
            }
        }.padding(.vertical, 4)
    }

    @ViewBuilder private func action(_ spec: LocalModelSpec, _ state: LocalModelStore.State) -> some View {
        switch state {
        case .installed:
            Button(role: .destructive) { asking = spec } label: { Image(systemName: "trash") }.buttonStyle(.borderless).accessibilityLabel("Delete \(spec.name)")
        case .downloading, .waitingForWiFi:
            Button("Stop") { models.cancel(spec) }.buttonStyle(.bordered).controlSize(.small)
        case .failed, .notInstalled:
            Button { models.download(spec) } label: { Label(state == .notInstalled ? "Download" : "Try again", systemImage: "arrow.down.circle") }.buttonStyle(.bordered).controlSize(.small).tint(Theme.clay)
        }
    }
}
