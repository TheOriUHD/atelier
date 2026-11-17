import PhotosUI
import SwiftUI

// MARK: - Help and feedback: reports, the docs, what's new, versions and diagnostics, licences

private enum HelpRoute: String, Hashable { case issue, feature, diagnostics, licence }

struct HelpSettings: View {
    let store: AppStore
    @State private var route: HelpRoute?

    init(store: AppStore) {
        self.store = store
        #if DEBUG
        _route = State(initialValue: Launch.value("--sub").flatMap { HelpRoute(rawValue: $0) })
        #endif
    }

    private var reportsOff: String? { PersonalReports.problem(store.info) }

    var body: some View {
        PersonalPage(title: "Help and feedback") {
            Section {
                NavigationLink { destination(.issue) } label: { NavRow(symbol: "ladybug", title: "Report an issue", subtitle: "Sent to the Atelier developer, with what you choose to attach.") }
                NavigationLink { destination(.feature) } label: { NavRow(symbol: "lightbulb", title: "Request a feature", subtitle: "An idea or a wish, for the developer's list of requests.") }
                if store.isAdmin, PersonalReports.offered(store.info) != nil { PersonalReportsSwitch(store: store) }
            } header: { Text("Feedback") } footer: {
                if let reportsOff { Text(reportsOff) }
            }
            Section("Help") {
                PersonalLinkRow(title: "Documentation", symbol: "book", url: "https://docs.atelierhq.dev/", subtitle: "docs.atelierhq.dev: guides, settings and what every feature does")
                PersonalLinkRow(title: "What's new", symbol: "sparkles", url: "https://github.com/TheOriUHD/atelier/releases", subtitle: "Release notes")
                NavigationLink { destination(.diagnostics) } label: { NavRow(symbol: "stethoscope", title: "Diagnostics", subtitle: "Versions and system as plain text. Nothing is sent.") }
            }
            Section("About") {
                ValueRow(title: "Atelier for iPhone and iPad", value: "\(PersonalApp.version) (\(PersonalApp.build))")
                ValueRow(title: "Server", value: store.info["version"].string.isEmpty ? "Unknown" : store.info["version"].string)
                ValueRow(title: "This device", value: "\(PersonalApp.family), \(PersonalApp.system)")
                PersonalLinkRow(title: "Website", symbol: "globe", url: "https://atelierhq.dev")
                PersonalLinkRow(title: "Source code", symbol: "chevron.left.forwardslash.chevron.right", url: "https://github.com/TheOriUHD/atelier", subtitle: "github.com/TheOriUHD/atelier")
                NavigationLink { destination(.licence) } label: { NavRow(symbol: "doc.text", title: "Licenses") }
            }
        }
        .navigationDestination(item: $route) { destination($0) }
    }

    @ViewBuilder private func destination(_ route: HelpRoute) -> some View {
        switch route {
        case .issue: PersonalReportPage(store: store, kind: .issue)
        case .feature: PersonalReportPage(store: store, kind: .feature)
        case .diagnostics: PersonalDiagnosticsPage(store: store)
        case .licence: PersonalLicencePage()
        }
    }
}

/// An admin's switch for everyone's reports (`settings.reports.enabled`).
private struct PersonalReportsSwitch: View {
    let store: AppStore
    @State private var on: Bool
    init(store: AppStore) { self.store = store; _on = State(initialValue: PersonalReports.offered(store.info) != false) }
    var body: some View {
        ToggleRow(title: "Allow reports to the Atelier developer", subtitle: "Lets everyone here send issue reports and feature requests. Off, the report buttons say an admin turned them off.",
                  isOn: Binding(get: { on }, set: { value in
                      let before = on; on = value
                      Task {
                          do {
                              _ = try await store.rpc.call("settings.set", ["layer": "global", "path": ["reports", "enabled"], "value": .bool(value)])
                              store.info = store.info.setting("reports", .bool(value))
                          } catch { on = before; store.notify("Couldn't save. \(PersonalFailure.text(error))") }
                      }
                  }))
    }
}

struct PersonalDiagnosticsPage: View {
    let store: AppStore
    @State private var copied = false
    var body: some View {
        let text = PersonalDiagnostics.text(store: store)
        PersonalPage(title: "Diagnostics") {
            Section {
                Text(text).font(.mono(.footnote)).foregroundStyle(Theme.ink).textSelection(.enabled)
            } footer: { Text("A plain-text summary to paste into a report somewhere else. Atelier sends nothing by itself, and the text leaves out keys, addresses, names and message text.") }
            Section {
                ActionRow(title: copied ? "Copied" : "Copy diagnostics", symbol: copied ? "checkmark" : "doc.on.doc") {
                    UIPasteboard.general.string = text; copied = true; store.notify("Copied")
                    Task { try? await Task.sleep(for: .seconds(2)); copied = false }
                }
                ShareLink(item: text) { Label("Share", systemImage: "square.and.arrow.up").foregroundStyle(Theme.clay) }
            }
        }
    }
}

struct PersonalLicencePage: View {
    var body: some View {
        PersonalPage(title: "Licenses") {
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Atelier").font(.system(.title3, design: .serif, weight: .medium))
                    Text("Atelier is source-available under the PolyForm Noncommercial License 1.0.0. You can read, run, change and share the code for noncommercial purposes. It is not open source: commercial use is not covered.").font(.subheadline).foregroundStyle(Theme.inkSecondary)
                    Text("Required Notice: Copyright 2026 TheOriUHD (https://github.com/TheOriUHD/atelier)").font(.mono(.footnote)).foregroundStyle(Theme.inkMuted).textSelection(.enabled)
                }.padding(.vertical, 4)
                PersonalLinkRow(title: "The license text", symbol: "doc.text", url: "https://polyformproject.org/licenses/noncommercial/1.0.0/")
                PersonalLinkRow(title: "The license in plain words", symbol: "book", url: "https://docs.atelierhq.dev/license/")
            }
            Section {
                Text("Atelier for iPhone and iPad is built only with the frameworks that come with iOS. It includes no third-party code.").font(.subheadline).foregroundStyle(Theme.inkSecondary)
            } header: { Text("This app") }
        }
    }
}

// MARK: - The report

struct PersonalReportPage: View {
    let store: AppStore
    @State private var model: PersonalReportModel
    @State private var photos: [PhotosPickerItem] = []
    @State private var pictureProblem: String?
    @State private var tried = false
    @State private var confirm = false
    @State private var previewing: PersonalPreview?
    @State private var copied = false
    @AppStorage("appearance") private var appearance = "system"
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dismiss) private var dismiss

    init(store: AppStore, kind: PersonalReportKind) {
        self.store = store
        _model = State(initialValue: PersonalReportModel(store: store, kind: kind))
    }

    private var theme: String { appearance == "dark" || (appearance == "system" && scheme == .dark) ? "dark" : "light" }

    var body: some View {
        PersonalPage(title: model.receipt == nil ? model.kind.title : "Thank you") {
            if let receipt = model.receipt { receiptSections(receipt) } else { formSections }
        }
        .task(id: "\(model.kind.rawValue)-\(model.withDiagnostics)-\(model.chosenChat ?? "")") { await model.prepare() }
        .onChange(of: photos) { _, items in loadPhotos(items) }
        .sheet(item: $previewing) { preview in PersonalPreviewSheet(preview: preview) }
        .confirmationDialog("Send this to the Atelier developer?", isPresented: $confirm, titleVisibility: .visible) {
            Button(model.kind == .issue ? "Send report" : "Send request") { Task { await model.send(theme: theme) } }
        } message: { Text(consentText) }
    }

    private var consentText: String {
        var items = ["your title and description"]
        if model.diagnosticsToSend != nil { items.append("diagnostics") }
        if model.chatToSend != nil, let chat = model.chats.first(where: { $0.id == model.chosenChat }) { items.append("the conversation “\(chat.title)”") }
        if !model.pictures.isEmpty { items.append("\(model.pictures.count) \(model.pictures.count == 1 ? "picture" : "pictures")") }
        if !model.contact.trimmingCharacters(in: .whitespaces).isEmpty { items.append("your contact") }
        let list = items.count > 1 ? items.dropLast().joined(separator: ", ") + " and " + (items.last ?? "") : items.joined()
        return "This sends \(list). It goes straight to the Atelier developer. Keys and passwords are taken out first."
    }

    // MARK: Form

    @ViewBuilder private var formSections: some View {
        Section {
            Picker("Kind", selection: Binding(get: { model.kind }, set: { model.switchKind($0); tried = false })) {
                ForEach(PersonalReportKind.allCases) { Text($0.tabLabel).tag($0) }
            }.pickerStyle(.segmented).accessibilityLabel("Kind")
        }
        if let unavailable = model.unavailable {
            Section { Label { Text(unavailable).font(.subheadline).foregroundStyle(Theme.ink) } icon: { Image(systemName: "exclamationmark.triangle").foregroundStyle(Theme.waiting) } }.listRowBackground(Theme.waiting.opacity(0.14))
        }
        Section {
            VStack(alignment: .leading, spacing: 4) {
                TextField(model.kind.titlePlaceholder, text: Binding(get: { model.title }, set: { model.title = String($0.prefix(PersonalReportLimits.titleMax)) }), axis: .vertical)
                    .lineLimit(1...3).accessibilityLabel("Title")
                if tried, let problem = model.titleProblem { Text(problem).font(.footnote).foregroundStyle(Theme.danger) }
            }
        } header: { Text(model.kind == .issue ? "What went wrong?" : "What would you like?") }
        Section {
            VStack(alignment: .leading, spacing: 4) {
                PersonalTextBox(title: model.kind.bodyTitle, text: Binding(get: { model.description }, set: { model.description = String($0.prefix(PersonalReportLimits.descriptionMax)) }), placeholder: model.kind.bodyPlaceholder, minHeight: 130)
                if tried, let problem = model.bodyProblem { Text(problem).font(.footnote).foregroundStyle(Theme.danger) }
            }
        } header: { Text(model.kind.bodyTitle) } footer: { if !tried || model.bodyProblem == nil { Text("A sentence or two is plenty.") } }
        Section {
            diagnosticsRow
            chatRow
            picturesRow
        } header: { Text("Attach") } footer: { Text("Nothing is sent until you press Send, and you see everything that goes first.") }
        Section {
            TextField("Contact", text: Binding(get: { model.contact }, set: { model.contact = String($0.prefix(PersonalReportLimits.contactMax)) }), prompt: Text(verbatim: "you@example.com"))
                .keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled().accessibilityLabel("Contact")
        } header: { Text("Contact (optional)") } footer: { Text("An email address or GitHub name, if you'd like an answer. Only the Atelier developer sees it.") }
        if let failure = model.failure { Section { Text(failure).font(.subheadline).foregroundStyle(Theme.danger) } }
        Section {
            Button(model.sending ? "Sending…" : "Send") {
                tried = true
                if model.titleProblem == nil, model.bodyProblem == nil { confirm = true }
            }.buttonStyle(ClayButtonStyle(busy: model.sending)).disabled(model.sending || model.unavailable != nil).personalButtonRow()
        } footer: { Link("What is sent, and where it goes", destination: URL(string: "https://docs.atelierhq.dev/reporting-issues/") ?? URL(fileURLWithPath: "/")).font(.footnote) }
    }

    private var diagnosticsRow: some View {
        VStack(alignment: .leading, spacing: 6) {
            if model.kind == .issue {
                attachHeader("Diagnostics", symbol: "waveform.path.ecg", detail: "Always sent with an issue: Atelier's version, this device, settings, providers and local model servers. Never keys, passwords or personal details.")
            } else {
                ToggleRow(title: "Diagnostics", subtitle: "Atelier's version, this device, settings, providers and local model servers. Never keys, passwords or personal details.", isOn: Binding(get: { model.featureDiagnostics }, set: { model.featureDiagnostics = $0 }))
            }
            if model.withDiagnostics { previewButton(loading: model.preparing, failure: model.prepareFailure, value: model.diagnosticsToSend, title: "Diagnostics") }
        }
    }

    private var chatRow: some View {
        VStack(alignment: .leading, spacing: 6) {
            ToggleRow(title: "A conversation", subtitle: model.withChat && model.chatToSend != nil ? PersonalReportText.coverage(model.chatToSend ?? .null) : "One chat or Code session, with its tool calls, so the problem can be followed step by step. Keys and passwords in it are taken out.",
                      isOn: Binding(get: { model.withChat }, set: { model.withChat = $0 }))
            if model.withChat {
                if model.chats.isEmpty { Text("You have no conversations yet.").font(.footnote).foregroundStyle(Theme.inkMuted) }
                else {
                    Picker("Conversation", selection: Binding(get: { model.chosenChat ?? "" }, set: { model.chatID = $0 })) {
                        ForEach(model.chats.prefix(100)) { Text($0.title).tag($0.id) }
                    }.pickerStyle(.menu).tint(Theme.inkSecondary)
                    previewButton(loading: model.preparing, failure: model.prepareFailure, value: model.chatToSend, title: "Conversation")
                }
            }
        }
    }

    private func attachHeader(_ title: String, symbol: String, detail: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            IconTile(symbol: symbol)
            VStack(alignment: .leading, spacing: 2) { Text(title).foregroundStyle(Theme.ink); Text(detail).font(.footnote).foregroundStyle(Theme.inkMuted).fixedSize(horizontal: false, vertical: true) }
        }
    }

    private func previewButton(loading: Bool, failure: String?, value: JSON?, title: String) -> some View {
        HStack(spacing: 8) {
            if loading { ProgressView().controlSize(.small); Text("Collecting…").font(.footnote).foregroundStyle(Theme.inkMuted) }
            else if let failure { Text(failure).font(.footnote).foregroundStyle(Theme.danger) }
            else if let value { Button("Show what is sent") { previewing = PersonalPreview(title: title, text: value.pretty) }.font(.footnote.weight(.medium)).buttonStyle(.borderless).foregroundStyle(Theme.clay) }
        }
    }

    private var picturesRow: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 12) {
                IconTile(symbol: "photo.badge.plus")
                VStack(alignment: .leading, spacing: 2) {
                    Text("Pictures").foregroundStyle(Theme.ink)
                    Text("Up to \(PersonalReportLimits.screenshots). Take a screenshot with your device and add it here; pictures are made smaller before sending.").font(.footnote).foregroundStyle(Theme.inkMuted)
                }
                Spacer(minLength: 8)
                PhotosPicker(selection: $photos, maxSelectionCount: max(1, PersonalReportLimits.screenshots - model.pictures.count), matching: .images) { Text("Add").font(.subheadline.weight(.medium)) }
                    .disabled(model.pictures.count >= PersonalReportLimits.screenshots)
            }
            if !model.pictures.isEmpty {
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 4), spacing: 8) {
                    ForEach(model.pictures) { item in
                        ZStack(alignment: .topTrailing) {
                            if let image = UIImage(data: item.picture.data) {
                                Image(uiImage: image).resizable().scaledToFill().frame(minWidth: 0, maxWidth: .infinity).aspectRatio(1, contentMode: .fit).clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                            }
                            Button { model.removePicture(item.id) } label: { Image(systemName: "xmark.circle.fill").symbolRenderingMode(.palette).foregroundStyle(.white, .black.opacity(0.6)).font(.title3) }
                                .buttonStyle(.plain).padding(3).accessibilityLabel("Take out this picture")
                        }
                    }
                }
            }
            if let pictureProblem { Text(pictureProblem).font(.footnote).foregroundStyle(Theme.danger) }
        }
    }

    private func loadPhotos(_ items: [PhotosPickerItem]) {
        guard !items.isEmpty else { return }
        Task {
            var datas: [Data] = []
            for item in items { if let data = try? await item.loadTransferable(type: Data.self) { datas.append(data) } }
            photos = []
            pictureProblem = model.addPictures(datas)
        }
    }

    // MARK: Receipt

    @ViewBuilder private func receiptSections(_ receipt: (id: String, kind: PersonalReportKind)) -> some View {
        Section {
            VStack(spacing: 14) {
                Image(systemName: "checkmark.circle").font(.system(size: 40, weight: .light)).foregroundStyle(Theme.success)
                Text("\(receipt.kind.sent) It goes straight to the Atelier developer.").font(.system(.title3, design: .serif, weight: .medium)).multilineTextAlignment(.center)
            }.frame(maxWidth: .infinity).padding(.vertical, 12)
        }.personalPlainRow()
        Section {
            HStack {
                Text(receipt.kind == .issue ? "Report" : "Request").foregroundStyle(Theme.inkSecondary)
                Text(receipt.id).font(.mono(.body)).foregroundStyle(Theme.ink).textSelection(.enabled)
                Spacer(minLength: 8)
                Button(copied ? "Copied" : "Copy") { UIPasteboard.general.string = receipt.id; copied = true; Task { try? await Task.sleep(for: .seconds(1.5)); copied = false } }.buttonStyle(.borderless).foregroundStyle(Theme.clay)
            }
        } footer: { Text("Mention it if you write about this anywhere else, so the two can be matched.") }
        Section { Button("Done") { dismiss() }.buttonStyle(ClayButtonStyle()).personalButtonRow() }
    }
}

struct PersonalPreview: Identifiable { let title: String; let text: String; var id: String { title } }

/// Exactly what goes, as the collector gets it.
struct PersonalPreviewSheet: View {
    let preview: PersonalPreview
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            ScrollView {
                Text(preview.text.count > 200_000 ? String(preview.text.prefix(200_000)) + "\n… (cut here; all of it is sent)" : preview.text)
                    .font(.mono(.caption)).foregroundStyle(Theme.ink).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding(16)
            }
            .background(Theme.sunken)
            .navigationTitle(preview.title).navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        .tint(Theme.clay)
        .presentationDetents([.medium, .large])
    }
}
