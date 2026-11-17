import SwiftUI

/// A plan the provider reports on (ChatGPT's windows, Mistral Vibe's monthly allowance), for the person to see how far
/// they are. Only admins can ask the server for it.
@MainActor enum ChatPlanUsage {
    static func providerType(_ store: AppStore) -> String {
        let id = store.models.first { $0["ref"].string == store.selectedModel }?["providerId"].string ?? ""
        return ChatHub.of(store).settings["providers"].array.first { $0["id"].string == id }?["type"].string ?? ""
    }

    static func windows(_ store: AppStore) async -> [JSON] {
        guard store.isAdmin else { return [] }
        let type = providerType(store)
        let id = store.models.first { $0["ref"].string == store.selectedModel }?["providerId"].string ?? ""
        do {
            if type == "chatgpt" {
                let status = try await store.rpc.call("chatgpt.status")
                return [status["limits"]["primary"], status["limits"]["secondary"]].filter { $0 != .null && (!status["plan"].string.lowercased().hasPrefix("pro") || $0["windowMinutes"].int == 10080) }.map {
                    let minutes = $0["windowMinutes"].int
                    return $0.setting("key", .string(String(minutes))).setting("name", .string(minutes == 10080 ? "Weekly" : minutes == 300 ? "Five-hour" : "Plan window"))
                }
            } else if type == "mistral-vibe" {
                let usage = try await store.rpc.call("providers.planUsage", ["id": .string(id)])
                if usage != .null { return [usage.setting("key", .string("month")).setting("name", .string("Monthly allowance"))] }
            }
        } catch { return [] }
        return []
    }
}

/// How full the conversation is and what it cost: the context window by category, the tokens used, and a plan's windows.
struct UsageView: View {
    let store: AppStore
    @State private var breakdown: JSON = .null
    @State private var windows: [JSON] = []
    @State private var state: ChatGalleryModel.LoadState = .idle
    @State private var compacting = false
    @State private var confirm = false
    @Environment(\.dismiss) private var dismiss
    private var live: JSON { store.transcript.snapshot["context"] }
    private var context: JSON { live != .null ? live : breakdown["context"] }
    private var usage: JSON { breakdown["usage"] }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 16) {
                    switch state {
                    case .failed(let message) where context == .null: InlineError(message: message) { Task { await load() } }
                    case .idle, .loading:
                        if context == .null { ProgressView().controlSize(.large).frame(maxWidth: .infinity, minHeight: 200) } else { sections }
                    default: sections
                    }
                }.padding(16).frame(maxWidth: 560).frame(maxWidth: .infinity)
            }
            .background(Theme.sunken)
            .navigationTitle("Context and usage").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .task { await load() }
            .confirmationDialog("Summarize this conversation?", isPresented: $confirm, titleVisibility: .visible) {
                Button("Summarize") { compact() }
            } message: { Text("Earlier messages are replaced by a summary to free up room. The conversation goes on from there.") }
        }
        .tint(Theme.clay)
        .presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
    }

    @ViewBuilder private var sections: some View {
        windowCard
        if !windows.isEmpty { planCard }
        if usage != .null { usageCard }
        Button { dismiss(); openSettings(.usage) } label: { Label("Your usage across Atelier", systemImage: "chart.bar").font(.subheadline.weight(.medium)) }.padding(.top, 4)
    }

    private var windowCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Context window").font(.footnote.weight(.semibold)).foregroundStyle(Theme.inkMuted)
            if context != .null {
                let limit = max(1, context["limit"].int)
                let fraction = Double(context["used"].int) / Double(limit)
                HStack(alignment: .firstTextBaseline) {
                    Text("\(Int((fraction * 100).rounded()))%").font(.system(size: 40, weight: .semibold, design: .serif))
                    Text("of the window").font(.subheadline).foregroundStyle(Theme.inkSecondary)
                }
                let rows = ChatContext.rows(context)
                GeometryReader { proxy in
                    HStack(spacing: 1) { ForEach(rows.filter { $0.tokens > 0 }) { row in Rectangle().fill(row.color).frame(width: max(2, proxy.size.width * Double(row.tokens) / Double(limit))) } }
                        .clipShape(Capsule()).background(Capsule().fill(Theme.fillStrong.opacity(0.5)))
                }.frame(height: 10).accessibilityHidden(true)
                Text("\(ChatText.count(context["used"].int)) of \(ChatText.count(limit)) tokens").font(.footnote).foregroundStyle(Theme.inkMuted).monospacedDigit()
                VStack(spacing: 10) {
                    ForEach(rows) { row in
                        HStack(spacing: 10) {
                            RoundedRectangle(cornerRadius: 3).fill(row.color).frame(width: 12, height: 12)
                            Text(row.label).font(.subheadline)
                            Spacer()
                            Text(ChatText.tokens(row.tokens)).font(.subheadline.monospacedDigit()).foregroundStyle(Theme.inkSecondary)
                            Text(ChatText.percent(row.tokens, of: limit)).font(.footnote.monospacedDigit()).foregroundStyle(Theme.inkMuted).frame(width: 46, alignment: .trailing)
                        }.accessibilityElement(children: .combine)
                    }
                }
                if context["threshold"].int > 0 { Text("Older messages are summarized on their own once about \(ChatText.tokens(context["threshold"].int)) tokens are used.").font(.footnote).foregroundStyle(Theme.inkMuted) }
                if store.selected != nil, store.transcript.messages.count > 1 {
                    Button { confirm = true } label: { HStack { if compacting { ProgressView() }; Text("Summarize the conversation") } }.buttonStyle(QuietButtonStyle()).disabled(compacting || ["running", "waiting"].contains(store.transcript.status))
                }
            } else { Text("Not available yet. Choose a model and send a message first.").font(.subheadline).foregroundStyle(Theme.inkMuted) }
        }.frame(maxWidth: .infinity, alignment: .leading).padding(18).card()
    }

    private var planCard: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Your plan").font(.footnote.weight(.semibold)).foregroundStyle(Theme.inkMuted)
            ForEach(windows, id: \.self) { window in
                VStack(alignment: .leading, spacing: 8) {
                    HStack { Text(window["name"].string).font(.subheadline.weight(.medium)); Spacer(); Text("\(Int(window["usedPercent"].double.rounded()))% used").font(.footnote).foregroundStyle(Theme.inkMuted).monospacedDigit() }
                    bar(min(1, window["usedPercent"].double / 100))
                    if window["resetsAt"] != .null { Text("Starts again \(Date(timeIntervalSince1970: window["resetsAt"].double > 1e12 ? window["resetsAt"].double / 1000 : window["resetsAt"].double).formatted(date: .abbreviated, time: .shortened))").font(.footnote).foregroundStyle(Theme.inkMuted) }
                }
            }
        }.frame(maxWidth: .infinity, alignment: .leading).padding(18).card()
    }

    private var usageCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("This conversation").font(.footnote.weight(.semibold)).foregroundStyle(Theme.inkMuted)
            stat("Sent", usage["input"].int)
            stat("Written", usage["output"].int)
            if usage["cacheRead"].int > 0 || usage["cacheWrite"].int > 0 {
                HStack { Text("Cache read and written").font(.subheadline).foregroundStyle(Theme.inkSecondary); Spacer(); Text("\(ChatText.tokens(usage["cacheRead"].int)) / \(ChatText.tokens(usage["cacheWrite"].int))").font(.subheadline).monospacedDigit() }
            }
            if usage["requests"].int > 0 { stat("Requests", usage["requests"].int) }
            if usage["costUsd"] != .null { HStack { Text("Cost").font(.subheadline).foregroundStyle(Theme.inkSecondary); Spacer(); Text(ChatText.usd(usage["costUsd"].double)).font(.subheadline).monospacedDigit() } }
            if usage["tokensPerSecond"] != .null { HStack { Text("Last reply").font(.subheadline).foregroundStyle(Theme.inkSecondary); Spacer(); Text(String(format: "%.1f tokens a second", usage["tokensPerSecond"].double)).font(.subheadline).monospacedDigit() } }
        }.frame(maxWidth: .infinity, alignment: .leading).padding(18).card()
    }

    private func load() async {
        guard store.selected != nil else { state = .loaded; return }
        state = .loading
        do {
            breakdown = try await ChatActions.contextBreakdown(store)
            state = .loaded
        } catch is CancellationError { return } catch { state = .failed(ChatError.text(error)) }
        windows = await ChatPlanUsage.windows(store)
    }

    private func compact() {
        compacting = true
        Task {
            defer { compacting = false }
            do { try await ChatActions.compact(store); store.notify("Summarizing"); dismiss() } catch { store.error = ChatError.text(error) }
        }
    }

    private func bar(_ fraction: Double) -> some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Capsule().fill(Theme.fillStrong)
                Capsule().fill(fraction >= 0.9 ? Theme.danger : fraction >= 0.75 ? Theme.waiting : Theme.clay).frame(width: max(8, proxy.size.width * min(1, max(0, fraction))))
            }
        }.frame(height: 8)
    }
    private func stat(_ label: String, _ value: Int) -> some View {
        HStack { Text(label).font(.subheadline).foregroundStyle(Theme.inkSecondary); Spacer(); Text(value.formatted()).font(.subheadline).monospacedDigit() }
    }
}
