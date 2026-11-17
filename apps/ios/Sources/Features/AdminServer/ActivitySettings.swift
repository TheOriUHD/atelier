import SwiftUI

// MARK: - Model

/// A saved export, ready to share.
struct AdminExportFile: Identifiable, Equatable {
    let id = UUID()
    let url: URL
    let count: Int
    /// More events matched than the export holds (the newest are in).
    let truncated: Bool
}

/// The Activity page's data: a filtered list that loads a page at a time, the retention, and the export.
@MainActor @Observable final class AdminActivityModel {
    enum Phase: Equatable { case idle, loading, loaded, failed(String) }

    private let rpc: Connection
    var filter = AdminAuditFilter()
    private(set) var events: [AdminAuditEvent] = []
    private(set) var next: String?
    private(set) var retentionDays: Int?
    private(set) var phase: Phase = .idle
    private(set) var loadingMore = false
    private(set) var moreProblem: String?
    private(set) var exporting = false
    /// A change that did not go through, in words, for the page's alert.
    var failure: String?
    /// Each reload gets a number, so an answer for a filter that has since changed is dropped.
    private var generation = 0

    init(rpc: Connection) { self.rpc = rpc }

    private func params(cursor: String?) -> [String: JSON] {
        var out = filter.params()
        out["limit"] = .number(Double(AdminAudit.pageSize))
        if let cursor { out["cursor"] = .string(cursor) }
        return out
    }

    /// Loads the first page again. `clear` empties the list first (the filter changed); a refresh keeps what is shown.
    func reload(clear: Bool = false) async {
        generation += 1
        let mine = generation
        if clear || events.isEmpty { events = []; next = nil; phase = .loading }
        moreProblem = nil
        do {
            if Launch.value("--state") == "loading" { try await Task.sleep(for: .seconds(3600)) }
            let page = AdminAuditPage(try await rpc.adminCall("audit.list", params(cursor: nil)))
            guard mine == generation else { return }
            events = page.events; next = page.next; retentionDays = page.retentionDays; phase = .loaded
        } catch is CancellationError { return } catch {
            guard mine == generation else { return }
            let message = AdminFailure.message(for: error)
            if events.isEmpty { phase = .failed(message) } else { failure = message }
        }
    }

    /// Loads the next, older page.
    func loadMore() async {
        guard let cursor = next, !loadingMore, moreProblem == nil else { return }
        loadingMore = true
        let mine = generation
        defer { loadingMore = false }
        do {
            let page = AdminAuditPage(try await rpc.adminCall("audit.list", params(cursor: cursor)))
            guard mine == generation else { return }
            let known = Set(events.map(\.id))
            events += page.events.filter { !known.contains($0.id) }
            next = page.next
        } catch is CancellationError { return } catch {
            guard mine == generation else { return }
            moreProblem = AdminFailure.message(for: error)
        }
    }

    func retryMore() async { moreProblem = nil; await loadMore() }

    /// Saves everything the filters match as a JSON file (at most the newest 50,000).
    func export() async -> AdminExportFile? {
        guard !exporting else { return nil }
        exporting = true; defer { exporting = false }
        do {
            let out = try await rpc.adminCall("audit.export", filter.params())
            let url = FileManager.default.temporaryDirectory.appending(path: AdminAudit.exportFileName())
            try Data(out.pretty.utf8).write(to: url, options: [.atomic, .completeFileProtection])
            return AdminExportFile(url: url, count: out["events"].array.count, truncated: out["truncated"].bool)
        } catch is CancellationError { return nil } catch {
            failure = error is MobileError ? AdminFailure.message(for: error) : "The file could not be saved. \(error.localizedDescription)"
            return nil
        }
    }

    /// How long events are kept: 7 to 365 days.
    func setRetention(_ days: Int) async -> Bool {
        do {
            _ = try await rpc.adminCall("settings.set", ["layer": "global", "path": .array([.string("audit"), .string("retentionDays")]), "value": .number(Double(days))])
            retentionDays = days
            return true
        } catch is CancellationError { return false } catch { failure = AdminFailure.message(for: error); return false }
    }
}

// MARK: - Page

/// Settings › Admin › Activity: who changed what on this server, newest first.
struct ActivitySettings: View {
    let store: AppStore
    @State private var model: AdminActivityModel
    @State private var exported: AdminExportFile?
    @State private var dateSheet = AdminDebug.is("dates")
    @State private var pendingRetention: Int?
    @State private var loadedFilter: AdminAuditFilter?
    @State private var pushedEvent: String?

    init(store: AppStore) {
        self.store = store
        _model = State(initialValue: AdminActivityModel(rpc: store.rpc))
    }

    var body: some View {
        content
            .scrollContentBackground(.hidden).background(Theme.sunken)
            .navigationTitle("Activity").navigationBarTitleDisplayMode(.inline)
            .searchable(text: $model.filter.person, placement: .navigationBarDrawer(displayMode: .always), prompt: "Person (username)")
            .textInputAutocapitalization(.never).autocorrectionDisabled()
            .toolbar {
                ToolbarItemGroup(placement: .primaryAction) {
                    filterMenu
                    Button { Task { exported = await model.export() } } label: {
                        if model.exporting { ProgressView().accessibilityLabel("Exporting") } else { Label("Export", systemImage: "square.and.arrow.up") }
                    }.disabled(model.exporting || model.phase != .loaded)
                }
            }
            // One task per filter: typing in the search field asks again only once it pauses, and an older ask is dropped.
            .task(id: model.filter) {
                let current = model.filter
                if let loaded = loadedFilter {
                    if loaded.params() == current.params() { return }
                    if loaded.trimmedPerson != current.trimmedPerson {
                        try? await Task.sleep(for: .milliseconds(350))
                        guard !Task.isCancelled else { return }
                    }
                }
                loadedFilter = current
                await model.reload(clear: true)
            }
            .refreshable { await model.reload() }
            .adminAlert($model.failure)
            .adminToast(store)
            .navigationDestination(isPresented: Binding(get: { pushedEvent != nil }, set: { if !$0 { pushedEvent = nil } })) {
                if let event = model.events.first(where: { $0.id == pushedEvent }) { AdminActivityDetail(event: event) }
            }
            .onChange(of: model.phase) { _, phase in
                guard phase == .loaded else { return }
                if AdminDebug.is("export"), exported == nil { Task { exported = await model.export() } }
                if let id = AdminDebug.parts(after: "event")?.first { pushedEvent = id }
            }
            .sheet(item: $exported) { file in AdminExportSheet(file: file) }
            .sheet(isPresented: $dateSheet) { AdminDateRangeSheet(filter: $model.filter) }
    }

    @ViewBuilder private var content: some View {
        switch model.phase {
        case .idle, .loading:
            ProgressView().controlSize(.large).frame(maxWidth: .infinity, maxHeight: .infinity)
        case .failed(let message):
            ScrollView { AdminFailureView(message: message) { Task { await model.reload(clear: true) } }.padding(.top, 60) }
        case .loaded:
            if model.events.isEmpty {
                ScrollView {
                    VStack(spacing: 0) {
                        if model.filter.isActive {
                            EmptyState(title: "Nothing matches", symbol: "line.3.horizontal.decrease.circle", message: "No activity fits these filters.", actionTitle: "Clear filters") { model.filter = AdminAuditFilter() }
                        } else {
                            EmptyState(title: "Nothing recorded yet", symbol: "clock.arrow.circlepath", message: "Sign-ins and the changes admins make show up here.")
                        }
                    }.padding(.top, 60)
                }
            } else { list }
        }
    }

    private var list: some View {
        List {
            if model.filter.isActive && !model.filter.summary.isEmpty {
                Section {
                    HStack {
                        Label(model.filter.summary, systemImage: "line.3.horizontal.decrease.circle").font(.subheadline).foregroundStyle(Theme.inkSecondary)
                        Spacer(minLength: 8)
                        Button("Clear") { model.filter = AdminAuditFilter() }.font(.subheadline).buttonStyle(.borderless)
                    }
                }
            }
            ForEach(AdminAudit.days(model.events)) { day in
                Section(day.title) {
                    ForEach(day.events) { event in
                        NavigationLink { AdminActivityDetail(event: event) } label: { AdminEventRow(event: event) }
                    }
                }
            }
            if model.next != nil || model.moreProblem != nil {
                Section {
                    if let problem = model.moreProblem {
                        VStack(spacing: 8) {
                            Text(problem).font(.footnote).foregroundStyle(Theme.inkMuted).multilineTextAlignment(.center)
                            Button("Try again") { Task { await model.retryMore() } }.buttonStyle(QuietButtonStyle()).frame(maxWidth: 200)
                        }.frame(maxWidth: .infinity)
                    } else {
                        HStack { Spacer(); ProgressView(); Spacer() }
                            .listRowBackground(Color.clear)
                            .task(id: model.events.count) { await model.loadMore() }
                    }
                }
            } else {
                Section { Text("That is everything in the log.").font(.footnote).foregroundStyle(Theme.inkMuted).frame(maxWidth: .infinity) }.listRowBackground(Color.clear)
            }
            if let days = model.retentionDays { keep(days) }
        }
        .listStyle(.insetGrouped)
        .tint(Theme.clay)
    }

    private var filterMenu: some View {
        Menu {
            Picker("Type", selection: $model.filter.category) {
                Text("All activity").tag(AdminAuditCategory?.none)
                ForEach(AdminAuditCategory.allCases) { Label($0.title, systemImage: $0.symbol).tag(Optional($0)) }
            }
            Button("Date range…", systemImage: "calendar") { dateSheet = true }
            if model.filter.isActive { Button("Clear filters", systemImage: "xmark.circle") { model.filter = AdminAuditFilter() } }
        } label: {
            Label("Filter", systemImage: model.filter.isActive ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle")
        }
    }

    @ViewBuilder private func keep(_ days: Int) -> some View {
        let choices = Array(Set(AdminAudit.retentionChoices + [days])).sorted()
        Section {
            PickRow(title: "Keep activity for", selection: Binding(get: { days }, set: { new in
                if new < days { pendingRetention = new } else { Task { if await model.setRetention(new) { store.notify("Saved") } } }
            }), options: choices.map { ($0, "\($0) days") })
            .confirmationDialog("Keep activity for \(pendingRetention ?? 0) days?", isPresented: Binding(get: { pendingRetention != nil }, set: { if !$0 { pendingRetention = nil } }), titleVisibility: .visible, presenting: pendingRetention) { days in
                Button("Keep \(days) days", role: .destructive) { Task { if await model.setRetention(days) { store.notify("Saved") } } }
            } message: { _ in Text("Events older than that are deleted once a day, and this cannot be undone.") }
        } header: {
            Text("Keep and export")
        } footer: {
            Text("Events older than this are deleted once a day. Between 7 and 365 days. Export saves everything the filters above match, as a JSON file.")
        }
    }
}

// MARK: - Rows

struct AdminEventRow: View {
    let event: AdminAuditEvent

    private var tint: Color {
        switch event.tone {
        case .danger: Theme.danger
        case .warning: Color(hex: 0xB77800)
        case .normal: Theme.inkSecondary
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            IconTile(symbol: event.symbol, tint: event.tone == .normal ? Theme.clay : tint, size: 34)
            VStack(alignment: .leading, spacing: 5) {
                Text(event.sentence).foregroundStyle(Theme.ink).lineLimit(3).fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 6) {
                    switch event.tone {
                    case .danger: StatusBadge(text: event.title, tone: .bad)
                    case .warning: StatusBadge(text: event.title, tone: .warn)
                    case .normal: EmptyView()
                    }
                    Text([event.tone == .normal ? event.title : nil, event.actor, event.at.formatted(date: .omitted, time: .shortened)].compactMap { $0 }.joined(separator: " · "))
                }
                .font(.footnote).foregroundStyle(Theme.inkMuted).lineLimit(1)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// One event, with everything it carries, in words.
struct AdminActivityDetail: View {
    let event: AdminAuditEvent

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 12) {
                    HStack(spacing: 8) {
                        IconTile(symbol: event.symbol, size: 34)
                        switch event.tone {
                        case .danger: StatusBadge(text: event.title, tone: .bad)
                        case .warning: StatusBadge(text: event.title, tone: .warn)
                        case .normal: StatusBadge(text: event.title, tone: .neutral)
                        }
                    }
                    Text(event.sentence).font(.system(.title3, design: .serif, weight: .medium)).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                }.padding(.vertical, 6)
            }
            Section("Details") {
                ForEach(event.rows) { row in
                    ValueRow(title: row.label, value: row.value, mono: row.label == "Address", copyable: true)
                }
            }
        }
        .listStyle(.insetGrouped).scrollContentBackground(.hidden).background(Theme.sunken).tint(Theme.clay)
        .navigationTitle("Event").navigationBarTitleDisplayMode(.inline)
    }
}

// MARK: - Sheets

struct AdminExportSheet: View {
    let file: AdminExportFile
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            VStack(spacing: 22) {
                VStack(spacing: 10) {
                    Image(systemName: "doc.text").font(.system(size: 30, weight: .light)).foregroundStyle(Theme.clay).accessibilityHidden(true)
                    Text("Activity exported").font(.system(.title2, design: .serif, weight: .medium))
                    Text(file.count == 1 ? "1 event is saved as a JSON file." : "\(file.count.formatted()) events are saved as a JSON file.")
                        .font(.subheadline).foregroundStyle(Theme.inkSecondary).multilineTextAlignment(.center)
                    if file.truncated {
                        Text("More events matched than a file holds, so these are the newest ones. Narrow the filters to get older ones.")
                            .font(.footnote).foregroundStyle(Theme.inkMuted).multilineTextAlignment(.center)
                    }
                }
                ShareLink(item: file.url) { Label("Share or save the file…", systemImage: "square.and.arrow.up") }.buttonStyle(ClayButtonStyle())
                Text("The file names people and the addresses they signed in from. Keep it private.").font(.footnote).foregroundStyle(Theme.inkMuted).multilineTextAlignment(.center)
                Spacer(minLength: 0)
            }
            .frame(maxWidth: 460).padding(.horizontal, 24).padding(.top, 28).frame(maxWidth: .infinity)
            .background(Theme.background)
            .navigationTitle("Export").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        .tint(Theme.clay)
        .presentationDetents([.medium, .large])
        .onDisappear { try? FileManager.default.removeItem(at: file.url) }
    }
}

struct AdminDateRangeSheet: View {
    @Binding var filter: AdminAuditFilter
    @Environment(\.dismiss) private var dismiss

    private var from: Binding<Date> { Binding(get: { filter.from ?? .now }, set: { filter.from = $0 }) }
    private var to: Binding<Date> { Binding(get: { filter.to ?? .now }, set: { filter.to = $0 }) }

    var body: some View {
        NavigationStack {
            List {
                Section("Quick ranges") {
                    Button("Today") { filter.from = .now; filter.to = nil }
                    Button("Last 7 days") { filter.from = Calendar.current.date(byAdding: .day, value: -6, to: .now); filter.to = nil }
                    Button("Last 30 days") { filter.from = Calendar.current.date(byAdding: .day, value: -29, to: .now); filter.to = nil }
                }
                Section {
                    Toggle("From", isOn: Binding(get: { filter.from != nil }, set: { filter.from = $0 ? .now : nil })).tint(Theme.clay)
                    if filter.from != nil { DatePicker("From date", selection: from, in: ...(filter.to ?? .distantFuture), displayedComponents: .date).datePickerStyle(.compact) }
                    Toggle("Until", isOn: Binding(get: { filter.to != nil }, set: { filter.to = $0 ? .now : nil })).tint(Theme.clay)
                    if filter.to != nil { DatePicker("Until date", selection: to, in: (filter.from ?? .distantPast)..., displayedComponents: .date).datePickerStyle(.compact) }
                } footer: { Text("Whole days, in your time zone.") }
                if filter.from != nil || filter.to != nil {
                    Section { Button("Any date", role: .destructive) { filter.from = nil; filter.to = nil } }
                }
            }
            .listStyle(.insetGrouped).scrollContentBackground(.hidden).background(Theme.sunken)
            .navigationTitle("Date range").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        .tint(Theme.clay)
        .presentationDetents([.medium, .large])
    }
}
