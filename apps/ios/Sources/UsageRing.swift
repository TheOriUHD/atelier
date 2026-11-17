import SwiftUI

/// The circle in the corner: how full the conversation's window is, or how far a plan's window has run. A touch opens the
/// details; holding it chooses what the circle shows.
struct UsageRing: View {
    let store: AppStore
    let open: () -> Void
    @State private var windows: [JSON] = []
    @State private var selected = "context"
    private var provider: String { store.models.first(where: { $0["ref"].string == store.selectedModel })?["providerId"].string ?? "" }
    private var key: String { "usageRing.\(store.address).\(provider)" }
    private var hasContext: Bool { store.transcript.snapshot["context"] != .null }
    private var used: Double {
        if let window = windows.first(where: { $0["key"].string == selected }) { return window["usedPercent"].double / 100 }
        let context = store.transcript.snapshot["context"]
        return Double(context["used"].int) / Double(max(1, context["limit"].int))
    }

    var body: some View {
        Button(action: open) {
            ZStack {
                Circle().stroke(Theme.fillStrong, lineWidth: 2.5)
                Circle().trim(from: 0, to: min(1, max(0, used))).stroke(used >= 0.9 ? Theme.danger : used >= 0.75 ? Theme.waiting : Theme.clay, style: StrokeStyle(lineWidth: 2.5, lineCap: .round)).rotationEffect(.degrees(-90))
            }.frame(width: 18, height: 18).frame(width: 36, height: 36)
        }
        .accessibilityLabel("Context: \(Int(min(1, used) * 100)) percent used")
        .accessibilityHint("Opens the details")
        .contextMenu {
            Button { choose("context") } label: { Label("Context window", systemImage: selected == "context" ? "checkmark" : "circle") }
            ForEach(windows, id: \.self) { window in
                Button { choose(window["key"].string) } label: { Label(window["name"].string, systemImage: selected == window["key"].string ? "checkmark" : "circle") }
            }
        }
        .task(id: provider + ":" + store.transcript.status) {
            selected = UserDefaults.standard.string(forKey: key) ?? "context"
            windows = await ChatPlanUsage.windows(store)
        }
    }

    private func choose(_ value: String) { selected = value; UserDefaults.standard.set(value, forKey: key) }
}
