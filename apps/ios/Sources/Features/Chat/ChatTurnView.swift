import SwiftUI
import AVFoundation

/// One turn: a person's message as a soft bubble on the right, or the assistant's reply laid out as a page.
struct TurnView: View {
    let turn: Turn
    let store: AppStore
    let isLast: Bool
    let running: Bool
    /// The message the person edits, and the artifact or file the transcript opens: the page provides them.
    var onEdit: ((Turn) -> Void)?
    var onOpenArtifact: ((JSON) -> Void)?
    var onViewEdit: ((ToolStep) -> Void)?
    @State private var editing = false
    @State private var reacting = false
    @State private var areaItem: JSON?
    private var hub: ChatHub { ChatHub.of(store) }
    private var snapshot: JSON { store.transcript.snapshot }
    private var sessionID: String { store.selected ?? "" }
    private var coop: JSON { hub.coop[sessionID] ?? .null }
    private var shared: Bool { coop != .null }
    private var me: String { coop["me"].string }
    private var isHost: Bool { !shared || coop["role"].string == "host" }
    private var mayEdit: Bool { !shared || (coop["role"].string != "viewer" && coop["ended"].bool == false) }
    /// The versions of each message on screen; the page works them out once for every turn.
    var siblings: [String: [String]] = [:]
    private var busy: Bool { running }

    var body: some View {
        switch turn.role {
        case .user: user
        case .assistant: assistant
        case .note: note
        }
    }

    // MARK: notes between turns

    @ViewBuilder private var note: some View {
        if let line = turn.mutedLine {
            Text(line).font(.footnote).foregroundStyle(Theme.inkMuted).frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
        } else if turn.notice?["kind"].string == "moved" {
            let to = turn.notice?["to"]["root"].string ?? ""
            Label("Moved to \((to as NSString).lastPathComponent.isEmpty ? to : (to as NSString).lastPathComponent)", systemImage: "folder").font(.footnote).foregroundStyle(Theme.inkMuted).frame(maxWidth: .infinity, alignment: .leading)
        } else if let first = turn.blocks.first, case .notice(_, let notice) = first {
            NoticeLine(notice: notice)
        } else {
            ChatCompactionLine(turn: turn)
        }
    }

    // MARK: a person's message

    private var user: some View {
        VStack(alignment: .trailing, spacing: 8) {
            if shared, !turn.author.isEmpty { ChatAuthorLabel(name: coopName(turn.author), asked: turn.answerWith.isEmpty ? nil : ChatModels.name(String(turn.answerWith.split(separator: ":", maxSplits: 1).last ?? ""), in: store.models)) }
            if turn.notice?["kind"].string == "loop" {
                Label("Loop, run \(turn.notice?["run"].int ?? 0)", systemImage: "repeat").font(.caption.weight(.semibold)).foregroundStyle(Theme.inkSecondary).padding(.horizontal, 10).padding(.vertical, 4).background(Theme.fill, in: Capsule())
            }
            ForEach(Array(turn.quotes.enumerated()), id: \.offset) { _, quote in ChatQuoteBlock(text: quote) }
            ForEach(Array(turn.areas.enumerated()), id: \.offset) { _, area in
                VStack(alignment: .trailing, spacing: 4) {
                    BlobImage(blob: area["image"]["blob"].string, mime: area["image"]["mime"].string, maxHeight: 160, corner: 12)
                    Text("Change the marked area").font(.caption).foregroundStyle(Theme.inkMuted)
                }
            }
            ForEach(turn.blocks) { block in
                switch block {
                case .file(_, let part): AttachmentView(part: part, store: store, onReference: reference, alignment: .trailing)
                case .text(_, let text):
                    Group {
                        if turn.notice?["kind"].string == "command" { Text(ChatCommandText.attributed(text)) } else { Text(text) }
                    }
                    .font(.system(.body)).foregroundStyle(Theme.ink).textSelection(.enabled)
                    .padding(.horizontal, 16).padding(.vertical, 11)
                    .background(Theme.fill, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                    .environment(\.layoutDirection, MarkdownInline.isRightToLeft(text) ? .rightToLeft : .leftToRight)
                default: EmptyView()
                }
            }
            ChatReactionPills(store: store, messageID: turn.id, align: .trailing)
            userActions
        }
        .frame(maxWidth: 560, alignment: .trailing)
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.leading, 44)
        .contextMenu { userMenu }
        .sheet(isPresented: $editing) { ChatEditSheet(store: store, turn: turn) }
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder private var userActions: some View {
        let versions = siblings[turn.id] ?? []
        if versions.count > 1 || (isLast && !busy && mayEdit) {
            HStack(spacing: 14) {
                ChatVersionSwitcher(store: store, messageID: turn.id, siblings: versions, disabled: busy)
                if isLast, !busy, mayEdit, !turn.plainText.isEmpty {
                    Button { startEditing() } label: { Image(systemName: "pencil") }.accessibilityLabel("Edit message")
                }
                if isLast, !turn.plainText.isEmpty { Button { UIPasteboard.general.string = turn.plainText; UIImpactFeedbackGenerator(style: .light).impactOccurred() } label: { Image(systemName: "doc.on.doc") }.accessibilityLabel("Copy message") }
            }.buttonStyle(.plain).font(.system(size: 14)).foregroundStyle(Theme.inkMuted)
        }
    }

    @ViewBuilder private var userMenu: some View {
        if !turn.plainText.isEmpty {
            Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = turn.plainText }
            Button("Quote in reply", systemImage: "quote.opening") { quote(turn.plainText) }
        }
        if mayEdit, !busy, !turn.plainText.isEmpty, turn.notice == nil {
            Button("Edit message", systemImage: "pencil") { startEditing() }
        }
        if mayEdit, !busy { Button("Try again", systemImage: "arrow.clockwise") { retry(turn.id) } }
        if shared { reactMenu(messageID: turn.id) }
    }

    private func startEditing() { editing = true }

    // MARK: the assistant's reply

    private var assistant: some View {
        VStack(alignment: .leading, spacing: 14) {
            if shared, let name = answeredFor { Text("for \(name)").font(.caption).foregroundStyle(Theme.inkMuted) }
            ForEach(Array(turn.blocks.enumerated()), id: \.element.id) { index, block in
                blockView(block, last: running && isLast && index == turn.blocks.count - 1)
            }
            ChatReactionPills(store: store, messageID: turn.lastMessageID, align: .leading)
            if !running, turn.hasReply { actions }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contextMenu { assistantMenu }
        .fullScreenCover(item: Binding(get: { areaItem.map { AreaBox(item: $0) } }, set: { if $0 == nil { areaItem = nil } })) { ChatAreaEditor(store: store, item: $0.item).environment(\.chatServer, store.address) }
        .accessibilityElement(children: .contain)
    }

    private struct AreaBox: Identifiable { let item: JSON; var id: String { item["blob"].string } }

    @ViewBuilder private func blockView(_ block: TurnBlock, last: Bool) -> some View {
        switch block {
        case .text(_, let text): MarkdownView(text: text)
        case .thinking(_, let text): ThinkingView(text: text, active: last)
        case .tools(_, let steps): ToolGroupView(steps: steps, live: last, output: snapshot["toolOutput"].entries.reduce(into: [String: String]()) { $0[$1.0] = $1.1.string }, onViewEdit: onViewEdit)
        case .file(_, let part): AttachmentView(part: part, store: store, onReference: reference)
        case .failure(_, let error):
            ChatMessageError(error: error, retry: error["retryable"] == .bool(false) || !mayEdit ? nil : { retry(turn.messageIDs.first ?? turn.id) })
        case .refusal:
            ChatProviderStopped(edit: mayEdit && !running ? { if let asked = askedTurnID { editAsked(asked) } } : nil, retry: mayEdit && !running ? { retry(turn.messageIDs.first ?? turn.id) } : nil)
        case .artifact(_, let step):
            ArtifactCard(step: step, artifacts: store.artifacts, writing: last || (running && !step.finished), partialInput: hub.toolInputs.first { $0.key.hasPrefix(turn.messageIDs.last ?? "") }?.value) { onOpenArtifact?($0) }
        case .visual(_, let step): ChatInlineVisual(step: step, running: running && !step.finished)
        case .media(_, let step): GeneratedMediaView(step: step, progress: snapshot["toolProgress"][step.id], waiting: snapshot["session"]["status"].string == "waiting", onReference: { reference($0) }, onChangeArea: mayEdit && !busy ? { areaItem = $0 } : nil)
        case .notice(_, let notice): NoticeLine(notice: notice)
        }
    }

    private var answeredFor: String? {
        guard shared else { return nil }
        let id = turn.author
        guard !id.isEmpty, id != me else { return nil }
        return coopName(id)
    }

    /// The person's message this turn answers, when it can be edited.
    private var askedTurnID: String? {
        let messages = store.transcript.messages
        guard let first = turn.messageIDs.first, let index = messages.firstIndex(where: { $0["id"].string == first }) else { return nil }
        return messages[..<index].last { $0["role"].string == "user" && !$0["parts"].array.allSatisfy { $0["type"].string == "context" } }?["id"].string
    }

    private func editAsked(_ id: String) {
        guard let message = store.transcript.messages.first(where: { $0["id"].string == id }) else { return }
        onEdit?(Turn(id: id, role: .user, blocks: [], source: message, lastMessageID: id))
    }

    private var actions: some View {
        HStack(spacing: 18) {
            Button { UIPasteboard.general.string = turn.plainText; UIImpactFeedbackGenerator(style: .light).impactOccurred(); store.notify("Copied") } label: { Image(systemName: "doc.on.doc") }.accessibilityLabel("Copy reply")
            if mayEdit { Button { retry(turn.messageIDs.first ?? turn.id) } label: { Image(systemName: "arrow.clockwise") }.accessibilityLabel("Try again") }
            ChatReadAloudButton(id: turn.lastMessageID, text: turn.plainText)
            ChatVersionSwitcher(store: store, messageID: turn.id, siblings: siblings[turn.id] ?? [], disabled: busy || !isHost)
            Menu {
                assistantMenu
            } label: { Image(systemName: "ellipsis") }.accessibilityLabel("More")
            Spacer(minLength: 0)
            if !turn.model.isEmpty { Text(ChatModels.name(turn.model, in: store.models)).font(.caption).foregroundStyle(Theme.inkMuted).lineLimit(1) }
        }
        .buttonStyle(.plain).font(.system(size: 15)).foregroundStyle(Theme.inkMuted).padding(.top, 2)
    }

    @ViewBuilder private var assistantMenu: some View {
        if !turn.plainText.isEmpty {
            Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = turn.plainText }
            Button("Quote in reply", systemImage: "quote.opening") { quote(turn.plainText) }
        }
        if mayEdit, !busy {
            Button("Try again", systemImage: "arrow.clockwise") { retry(turn.messageIDs.first ?? turn.id) }
            if isHost { retryWithMenu }
        }
        if shared, mayEdit, !busy { secondOpinionMenu }
        if shared { reactMenu(messageID: turn.lastMessageID) }
        if let time = turn.finalCreatedAt > 0 ? turn.finalCreatedAt : nil {
            Text(Date(timeIntervalSince1970: time / 1000).formatted(date: .abbreviated, time: .shortened))
        }
    }

    private var retryWithMenu: some View {
        let groups = ChatModels.groups(store.models, providerNames: hub.providerNames)
        return Menu {
            ForEach(groups) { group in
                Section(group.label) {
                    ForEach(group.models, id: \.self) { model in
                        Button { retry(turn.messageIDs.first ?? turn.id, model: model["ref"].string) } label: { Text(model["displayName"].string); Text(ChatModels.subtitle(model)) }.disabled(model["available"] == .bool(false))
                    }
                }
            }
        } label: { Label("Try again with…", systemImage: "arrow.triangle.2.circlepath") }
    }

    private var secondOpinionMenu: some View {
        let groups = ChatModels.groups(store.models, providerNames: hub.providerNames)
        return Menu {
            ForEach(groups) { group in
                Section(group.label) {
                    ForEach(group.models, id: \.self) { model in
                        Button(model["displayName"].string) { Task { do { try await ChatActions.secondOpinion(store, messageId: turn.messageIDs.first ?? turn.id, model: model["ref"].string) } catch { store.error = ChatError.text(error) } } }.disabled(model["available"] == .bool(false))
                    }
                }
            }
        } label: { Label("Second opinion", systemImage: "person.2") }
    }

    private func reactMenu(messageID: String) -> some View {
        Menu {
            ForEach(ChatReactions.all, id: \.self) { emoji in
                Button(emoji) { react(messageID, emoji, on: true) }
            }
        } label: { Label("React", systemImage: "face.smiling") }
    }

    // MARK: actions

    private func react(_ message: String, _ emoji: String, on: Bool) { Task { do { try await ChatActions.react(store, messageId: message, emoji: emoji, on: on) } catch { store.error = ChatError.text(error) } } }

    private func retry(_ message: String, model: String? = nil) {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        Task {
            do { if let model { try await ChatActions.retry(store, message, with: model) } else { try await ChatActions.retry(store, message) } }
            catch { store.error = ChatError.text(error) }
        }
    }

    private func quote(_ text: String) {
        let quoted = String(text.trimmingCharacters(in: .whitespacesAndNewlines).prefix(4000))
        guard !quoted.isEmpty, store.attachments.filter({ $0["type"].string == "context" }).count < 5 else { return }
        if store.attachments.contains(where: { $0["notice"]["text"].string == quoted }) { return }
        store.attachments.append(.obj(["type": "context", "text": "", "notice": .obj(["kind": "quote", "text": .string(quoted)])]))
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        store.notify("Quoted in your reply")
    }

    /// A picture of the conversation becomes a reference attached to the next message.
    private func reference(_ item: JSON) {
        let blob = item["blob"].string
        guard !blob.isEmpty, !store.attachments.contains(where: { $0["blob"].string == blob }) else { return }
        store.attachments.append(.obj(["type": "image", "blob": .string(blob), "mime": .string(item["mime"].string), "name": .string(item["id"].string.isEmpty ? "Picture" : item["id"].string)]))
        store.notify("Added to your reply")
    }

    private func coopName(_ id: String) -> String {
        if id == me { return "You" }
        return coop["participants"].array.first { $0["id"].string == id }?["name"].string ?? "Someone who left"
    }
}

// MARK: - Pieces

/// "Compacted conversation · saved 666K tokens": a muted line that opens the summary.
struct ChatCompactionLine: View {
    let turn: Turn
    @State private var open = false
    private var saved: Int { turn.notice?["saved"].int ?? 0 }
    private var summary: String { turn.source["parts"].array.filter { $0["type"].string == "text" }.map { $0["text"].string }.joined(separator: "\n\n") }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button { withAnimation(.snappy) { open.toggle() } } label: {
                HStack(spacing: 8) {
                    Rectangle().fill(Theme.hairline).frame(height: 1)
                    Text("Earlier messages were summarized\(saved > 0 ? ", saving \(ChatText.tokens(saved)) tokens" : "")").font(.caption).foregroundStyle(Theme.inkMuted).fixedSize()
                    Image(systemName: "chevron.right").font(.system(size: 9, weight: .bold)).foregroundStyle(Theme.inkMuted).rotationEffect(.degrees(open ? 90 : 0))
                    Rectangle().fill(Theme.hairline).frame(height: 1)
                }.contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityHint(open ? "Hides the summary" : "Shows the summary")
            if open, !summary.isEmpty { MarkdownView(text: summary) }
        }
    }
}

struct ChatQuoteBlock: View {
    let text: String
    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Capsule().fill(Theme.inkMuted.opacity(0.4)).frame(width: 2)
            Text(text).font(.subheadline).foregroundStyle(Theme.inkSecondary).lineLimit(4).multilineTextAlignment(.leading)
        }.frame(maxWidth: 480, alignment: .trailing).accessibilityLabel("Quoted text: \(text)")
    }
}

enum ChatCommandText {
    /// A command the person ran: its `/name` in clay.
    static func attributed(_ text: String) -> AttributedString {
        var result = AttributedString(text)
        if text.hasPrefix("/") {
            let end = text.firstIndex(where: \.isWhitespace) ?? text.endIndex
            if let range = result.range(of: String(text[..<end])) { result[range].foregroundColor = Theme.clay }
        }
        return result
    }
}

struct ChatAuthorLabel: View {
    let name: String
    var asked: String?
    var body: some View {
        HStack(spacing: 6) {
            Avatar(name: name, size: 16)
            Text(asked.map { "\(name), asked for \($0)" } ?? name).font(.caption).foregroundStyle(Theme.inkMuted).lineLimit(1)
        }
    }
}

/// "‹ 2/3 ›": the versions of a message, one retry or edit at a time.
struct ChatVersionSwitcher: View {
    let store: AppStore
    let messageID: String
    let siblings: [String]
    let disabled: Bool

    var body: some View {
        if siblings.count > 1, let index = siblings.firstIndex(of: messageID) {
            HStack(spacing: 2) {
                Button { go(siblings[index - 1]) } label: { Image(systemName: "chevron.left").frame(width: 24, height: 28) }.disabled(disabled || index <= 0).accessibilityLabel("Previous version")
                Text("\(index + 1)/\(siblings.count)").font(.caption.monospacedDigit()).accessibilityLabel("Version \(index + 1) of \(siblings.count)")
                Button { go(siblings[index + 1]) } label: { Image(systemName: "chevron.right").frame(width: 24, height: 28) }.disabled(disabled || index >= siblings.count - 1).accessibilityLabel("Next version")
            }.font(.system(size: 12, weight: .semibold)).buttonStyle(.plain).foregroundStyle(Theme.inkMuted)
        }
    }

    private func go(_ id: String) {
        UISelectionFeedbackGenerator().selectionChanged()
        Task { do { try await ChatActions.switchBranch(store, to: id) } catch { store.error = ChatError.text(error) } }
    }
}

/// The emoji people put on a message in a shared conversation; tapping one adds or takes back yours.
struct ChatReactionPills: View {
    let store: AppStore
    let messageID: String
    let align: HorizontalAlignment
    private var hub: ChatHub { ChatHub.of(store) }
    private var me: String { hub.coop[store.selected ?? ""]?["me"].string ?? "" }
    private var live: [JSON] { hub.reactions[store.selected ?? ""]?[messageID] ?? store.transcript.snapshot["reactions"][messageID].array }

    var body: some View {
        if !live.isEmpty {
            HStack(spacing: 6) {
                ForEach(live, id: \.self) { reaction in
                    let mine = reaction["participants"].array.contains { $0.string == me }
                    Button {
                        Task { do { try await ChatActions.react(store, messageId: messageID, emoji: reaction["emoji"].string, on: !mine) } catch { store.error = ChatError.text(error) } }
                    } label: {
                        Text("\(reaction["emoji"].string) \(reaction["participants"].array.count)").font(.caption.weight(.medium)).padding(.horizontal, 9).padding(.vertical, 4)
                            .background(mine ? Theme.clay.opacity(0.15) : Theme.fill, in: Capsule())
                            .overlay(Capsule().stroke(mine ? Theme.clay.opacity(0.5) : .clear, lineWidth: 1))
                    }.buttonStyle(.plain).accessibilityLabel("\(reaction["emoji"].string), \(reaction["participants"].array.count) \(reaction["participants"].array.count == 1 ? "person" : "people")\(mine ? ", including you" : "")")
                }
            }.frame(maxWidth: .infinity, alignment: align == .trailing ? .trailing : .leading)
        }
    }
}

/// A reply that failed: what went wrong, the settings page that fixes it, and Try again.
struct ChatMessageError: View {
    let error: JSON
    var retry: (() -> Void)?
    private var fix: SettingsPageID? { error["fix"].stringOrNil.flatMap(SettingsPageID.fix) }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "exclamationmark.circle.fill").foregroundStyle(Theme.danger)
                Text(error["message"].string).font(.subheadline).foregroundStyle(Theme.ink).fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            HStack(spacing: 14) {
                if let fix { Button("Fix in Settings") { openSettings(fix) }.font(.subheadline.weight(.semibold)) }
                if error["code"].string == "limit_reached" { Button("See your usage") { openSettings(.usage) }.font(.subheadline.weight(.semibold)) }
                if let retry { Button { retry() } label: { Label("Try again", systemImage: "arrow.clockwise") }.font(.subheadline.weight(.semibold)) }
            }.tint(Theme.clay)
        }
        .padding(14).background(Theme.removed, in: RoundedRectangle(cornerRadius: 14, style: .continuous)).accessibilityElement(children: .contain)
    }
}

/// The provider ended the reply itself: said as theirs, not Atelier's.
struct ChatProviderStopped: View {
    var edit: (() -> Void)?
    var retry: (() -> Void)?
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("The model provider stopped this response.\(edit != nil || retry != nil ? " Edit your message or try again." : "")", systemImage: "hand.raised.slash").font(.subheadline).foregroundStyle(Theme.inkSecondary)
            HStack(spacing: 14) {
                if let edit { Button { edit() } label: { Label("Edit", systemImage: "pencil") } }
                if let retry { Button { retry() } label: { Label("Try again", systemImage: "arrow.clockwise") } }
            }.font(.subheadline.weight(.semibold)).tint(Theme.clay)
        }
    }
}

/// An interactive picture or diagram the model drew in its reply: a small page that runs inside a sealed cell.
struct ChatInlineVisual: View {
    let step: ToolStep
    let running: Bool
    @State private var full = false
    private var input: JSON { step.call["input"] }
    private var title: String { input["title"].string.isEmpty ? "Picture" : input["title"].string }
    private var html: String { input["html"].string }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if step.failed || (!running && !step.finished) {
                Label("The picture could not be drawn.", systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(Theme.inkMuted)
            } else if !step.finished {
                HStack(spacing: 8) { ProgressView().controlSize(.small); Text("Drawing \(title)").font(.footnote).foregroundStyle(Theme.inkMuted) }.padding(.vertical, 8)
            } else {
                IsolatedHTML(content: html, scripts: true).frame(height: 300).clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Theme.hairline, lineWidth: 0.5))
                    .accessibilityLabel(input["description"].string.isEmpty ? title : input["description"].string)
                HStack {
                    Text(title).font(.caption).foregroundStyle(Theme.inkMuted).lineLimit(1)
                    Spacer()
                    Button { full = true } label: { Label("Full screen", systemImage: "arrow.up.left.and.arrow.down.right").font(.caption) }.buttonStyle(.plain).foregroundStyle(Theme.inkMuted)
                }
            }
        }
        .fullScreenCover(isPresented: $full) {
            NavigationStack {
                IsolatedHTML(content: html, scripts: true).ignoresSafeArea(edges: .bottom).navigationTitle(title).navigationBarTitleDisplayMode(.inline)
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { full = false } } }
            }.tint(Theme.clay)
        }
    }
}

// MARK: - Read aloud

@MainActor @Observable final class ChatSpeech: NSObject, AVSpeechSynthesizerDelegate {
    static let shared = ChatSpeech()
    var speaking: String?
    private let synthesizer = AVSpeechSynthesizer()

    override init() { super.init(); synthesizer.delegate = self }

    func toggle(id: String, text: String) {
        if speaking == id { synthesizer.stopSpeaking(at: .immediate); speaking = nil; return }
        synthesizer.stopSpeaking(at: .immediate)
        let plain = text.replacingOccurrences(of: "[`*#>_]", with: "", options: .regularExpression)
        let utterance = AVSpeechUtterance(string: plain)
        utterance.voice = AVSpeechSynthesisVoice(language: Locale.current.identifier.replacingOccurrences(of: "_", with: "-"))
        speaking = id
        synthesizer.speak(utterance)
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) { Task { @MainActor in ChatSpeech.shared.speaking = nil } }
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) { Task { @MainActor in ChatSpeech.shared.speaking = nil } }
}

struct ChatReadAloudButton: View {
    let id: String
    let text: String
    var body: some View {
        let speaking = ChatSpeech.shared.speaking == id
        Button { ChatSpeech.shared.toggle(id: id, text: text) } label: { Image(systemName: speaking ? "speaker.slash" : "speaker.wave.2") }
            .accessibilityLabel(speaking ? "Stop reading aloud" : "Read aloud")
    }
}


/// Editing a person's message: it is sent again as a new version, with its pictures and quotes kept.
struct ChatEditSheet: View {
    let store: AppStore
    let turn: Turn
    @State private var text: String
    @Environment(\.dismiss) private var dismiss

    init(store: AppStore, turn: Turn) {
        self.store = store; self.turn = turn
        let said = turn.plainText.isEmpty ? turn.source["parts"].array.filter { $0["type"].string == "text" }.map { $0["text"].string }.joined(separator: "\n\n") : turn.plainText
        _text = State(initialValue: said)
    }

    var body: some View {
        NavigationStack {
            TextEditor(text: $text).font(.body).scrollContentBackground(.hidden).padding().background(Theme.background)
                .navigationTitle("Edit message").navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Send") {
                            let kept = turn.source["parts"].array.filter { part in
                                let type = part["type"].string
                                return type == "image" || type == "document" || (type == "context" && ["quote", "area"].contains(part["notice"]["kind"].string))
                            }
                            let parts = kept + [JSON.text(text.trimmingCharacters(in: .whitespacesAndNewlines))]
                            dismiss()
                            Task { do { try await ChatActions.edit(store, messageId: turn.id, parts: parts) } catch { store.error = ChatError.text(error) } }
                        }.disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty).tint(Theme.clay)
                    }
                }
        }.presentationDetents([.medium, .large])
    }
}
