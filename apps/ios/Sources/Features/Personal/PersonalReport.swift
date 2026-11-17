import Foundation
import SwiftUI
import UIKit

// MARK: - Issue reports and feature requests (`reports.prepare`, `reports.submit`): the words, the diagnostics and the model

enum PersonalReportKind: String, CaseIterable, Identifiable {
    case issue, feature
    var id: String { rawValue }
    var tabLabel: String { self == .issue ? "Issue" : "Feature request" }
    var title: String { self == .issue ? "Report an issue" : "Request a feature" }
    var titlePlaceholder: String { self == .issue ? "Chat stops after attaching a PDF" : "Search inside attached PDFs" }
    var bodyTitle: String { self == .issue ? "What happened?" : "Describe it" }
    var bodyPlaceholder: String { self == .issue ? "What did you do, what happened, and what did you expect instead?" : "What would it let you do, and how would you use it?" }
    var sent: String { self == .issue ? "Your report is in." : "Your request is in." }
}

enum PersonalReports {
    /// Whether this server takes reports: true or false as `app.info` says, nil on a server from before reports.
    @MainActor static func offered(_ info: JSON) -> Bool? {
        #if DEBUG
        if Demo.requested != nil, info["reports"] == .null { return true }
        #endif
        return info["reports"].boolOrNil
    }

    /// Why a report can't be sent from this server, or nil.
    @MainActor static func problem(_ info: JSON) -> String? {
        switch offered(info) {
        case nil: "This server is too old to send reports. Ask its admin to update it."
        case false?: "An admin turned off reports on this server."
        case true?: nil
        }
    }
}

enum PersonalReportLimits {
    static let titleMin = 6, titleMax = 140, descriptionMin = 20, descriptionMax = 20_000, contactMax = 200
    static let screenshots = 4, screenshotBytes = 2_500_000, screenshotSide: CGFloat = 2560
}

enum PersonalReportText {
    enum Field { case title, description }

    private static func matches(_ pattern: String, _ text: String, options: NSRegularExpression.Options = []) -> Bool {
        (try? NSRegularExpression(pattern: pattern, options: options))?.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
    }

    /// Why a title or description can't be sent yet, in a sentence, or nil when it can. The bar is low on purpose (a sentence or two),
    /// but it must say something: padding, one word repeated or a row of punctuation doesn't count towards it.
    static func problem(_ field: Field, _ text: String) -> String? {
        let min = field == .title ? PersonalReportLimits.titleMin : PersonalReportLimits.descriptionMin
        let max = field == .title ? PersonalReportLimits.titleMax : PersonalReportLimits.descriptionMax
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return field == .title ? "Give it a title." : "Describe it in a sentence or two." }
        if trimmed.count > max { return "That's too long: at most \(PersonalUsage.number(max)) characters." }
        if matches(#"(\p{L})\1{5,}"#, trimmed, options: .caseInsensitive) { return "Leave out the repeated characters." }
        let collapsed = trimmed.replacingOccurrences(of: #"(.)\1{2,}"#, with: "$1$1", options: [.regularExpression])
        let meaningful = collapsed.replacingOccurrences(of: #"[^\p{L}\p{N}]+"#, with: "", options: .regularExpression)
        let words = trimmed.components(separatedBy: CharacterSet.letters.union(.decimalDigits).inverted).filter { $0.unicodeScalars.contains { CharacterSet.letters.contains($0) } }
        let scripts = matches(#"[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]"#, trimmed)
        let shortMessage = field == .title ? "Make the title a few words long." : "Say a little more: what happened, and what you expected."
        if meaningful.count < min || (!scripts && words.count < (field == .title ? 2 : 4)) { return shortMessage }
        if Set(meaningful.lowercased()).count < 5 { return shortMessage }
        var counts: [String: Int] = [:]
        for word in words { counts[word.lowercased(), default: 0] += 1 }
        if words.count >= 6, let most = counts.values.max(), Double(most) > Double(words.count) / 2 { return "Say it in your own words rather than one word repeated." }
        return nil
    }

    /// "All 42 messages", or how much of a long one goes.
    static func coverage(_ chat: JSON) -> String {
        let total = chat["coverage"]["total"].int, included = chat["coverage"]["included"].int, shortened = chat["coverage"]["shortened"].int
        if total == 0 { return "It has no messages yet." }
        let what = included >= total ? "All \(total) message\(total == 1 ? "" : "s")" : "\(included) of its \(total) messages: how it started and the newest ones"
        return shortened > 0 ? "\(what), some shortened to fit." : "\(what)."
    }
}

/// What "Copy diagnostics" puts on the clipboard: versions and the system, never addresses, names, keys or message text.
enum PersonalDiagnostics {
    @MainActor static func text(store: AppStore, now: Date = .now) -> String {
        let info = store.info
        let features = ["imageGeneration": "image generation", "videoGeneration": "video generation", "audioGeneration": "sound generation", "usageLimits": "usage limits", "auditLog": "activity log", "terminalSignIn": "terminal sign-in", "reports": "reports"]
        let offered = features.filter { info[$0.key].bool }.map(\.value).sorted()
        var lines = [
            "Atelier diagnostics, \(now.formatted(.iso8601.year().month().day()))",
            "App: Atelier for iPhone and iPad \(PersonalApp.version) (\(PersonalApp.build))",
            "System: \(PersonalApp.system), \(PersonalApp.machine)",
            "Locale: \(Locale.current.identifier), time zone \(TimeZone.current.identifier)",
            "Server: \(info["version"].string.isEmpty ? "unknown" : info["version"].string)\(info["surface"].string.isEmpty ? "" : " (\(info["surface"].string))")",
            "Role: \(store.role.isEmpty ? "unknown" : store.role)",
            "Connected: \(store.connected ? "yes" : "no")",
            "Server offers: \(offered.isEmpty ? "nothing extra" : offered.joined(separator: ", "))",
            "Models: \(store.models.count), conversations: \(store.sessions.count)",
        ]
        if let error = store.error { lines.append("Last error: \(error.prefix(300))") }
        return lines.joined(separator: "\n")
    }
}

struct PersonalReportPicture: Identifiable, Equatable {
    let id = UUID()
    let picture: PersonalImages.Picture
}

@MainActor @Observable final class PersonalReportModel {
    var kind: PersonalReportKind
    private(set) var drafts: [PersonalReportKind: (title: String, description: String, contact: String)] = [:]
    var featureDiagnostics = false
    var withChat = false
    var chatID: String?
    private(set) var pictures: [PersonalReportPicture] = []
    private(set) var prepared: JSON?
    private(set) var preparing = false
    private(set) var prepareFailure: String?
    private(set) var sending = false
    private(set) var failure: String?
    private(set) var receipt: (id: String, kind: PersonalReportKind)?
    private let store: AppStore
    private var generation = 0

    init(store: AppStore, kind: PersonalReportKind) {
        self.store = store
        self.kind = kind
    }

    var title: String { get { drafts[kind]?.title ?? "" } set { drafts[kind, default: ("", "", "")].title = newValue } }
    var description: String { get { drafts[kind]?.description ?? "" } set { drafts[kind, default: ("", "", "")].description = newValue } }
    var contact: String { get { drafts[kind]?.contact ?? "" } set { drafts[kind, default: ("", "", "")].contact = newValue } }

    /// An issue always carries diagnostics: without them it can rarely be followed up. A feature request only on request.
    var withDiagnostics: Bool { kind == .issue || featureDiagnostics }
    var chats: [Conversation] { store.sessions.filter { $0.raw["temporary"] == .null } }
    var chosenChat: String? { withChat ? (chatID.flatMap { id in chats.contains { $0.id == id } ? id : nil } ?? chats.first?.id) : nil }
    var titleProblem: String? { PersonalReportText.problem(.title, title) }
    var bodyProblem: String? { PersonalReportText.problem(.description, description) }

    /// Nil when reports can be sent; otherwise why not.
    var unavailable: String? { PersonalReports.problem(store.info) }

    func prepare() async {
        guard unavailable == nil, withDiagnostics || chosenChat != nil else { prepared = nil; prepareFailure = nil; return }
        generation += 1
        let mine = generation
        preparing = true; prepareFailure = nil
        defer { if generation == mine { preparing = false } }
        do {
            let result = try await store.rpc.call("reports.prepare", ["kind": .string(kind.rawValue), "diagnostics": .bool(withDiagnostics), "chatSessionId": chosenChat.map { .string($0) } ?? .null])
            if generation == mine { prepared = result }
        } catch is CancellationError { return } catch { if generation == mine { prepared = nil; prepareFailure = PersonalFailure.text(error) } }
    }

    /// The phone's half of the diagnostics, added to what the server collected.
    func clientDiagnostics() -> [String: JSON] {
        let (size, scale) = PersonalApp.screen
        let system: JSON = .obj([
            "os": .obj(["platform": "ios", "name": .string(PersonalApp.system), "release": .string(UIDevice.current.systemVersion), "arch": "arm64", "locale": .string(Locale.current.identifier), "timeZone": .string(TimeZone.current.identifier)]),
            "hardware": .obj(["model": .string(PersonalApp.machine), "cpu": .obj(["model": "unknown", "cores": .number(Double(ProcessInfo.processInfo.processorCount))]),
                              "memory": .obj(["totalBytes": .number(Double(ProcessInfo.processInfo.physicalMemory))]),
                              "displays": .array([.obj(["width": .number(size.width), "height": .number(size.height), "scale": .number(scale)])])]),
            "runtime": .obj([:]),
        ])
        return ["client": system, "notes": .obj(["app": .string("Atelier for iPhone and iPad \(PersonalApp.version) (\(PersonalApp.build))"), "device": .string(PersonalApp.family)])]
    }

    /// `ReportApp` for this app: it works like a browser on the server, so it reports itself as one, and says what it is in the notes.
    func app(theme: String) -> JSON {
        let (size, scale) = PersonalApp.screen
        var app: [String: JSON] = ["version": .string("\(PersonalApp.version) (\(PersonalApp.build))"), "surface": "web", "mode": "web", "window": .obj(["width": .number(size.width), "height": .number(size.height), "ratio": .number(scale)]),
                                   "theme": .string(theme), "language": .string(Locale.current.identifier)]
        if let serverVersion = store.info["version"].stringOrNil { app["serverVersion"] = .string(serverVersion) }
        return .object(app)
    }

    /// The diagnostics as they will be sent: the server's, with this phone's half.
    var diagnosticsToSend: JSON? {
        guard withDiagnostics, let base = prepared?["diagnostics"], base != .null else { return nil }
        return clientDiagnostics().reduce(base) { $0.setting($1.key, $1.value) }
    }

    var chatToSend: JSON? { chosenChat != nil ? prepared.flatMap { $0["chat"] == .null ? nil : $0["chat"] } : nil }

    func addPictures(_ datas: [Data]) -> String? {
        var problem: String?
        for data in datas {
            guard pictures.count < PersonalReportLimits.screenshots else { problem = "At most \(PersonalReportLimits.screenshots) pictures."; break }
            if let picture = PersonalImages.jpeg(from: data, maxSide: PersonalReportLimits.screenshotSide, maxBytes: PersonalReportLimits.screenshotBytes) { pictures.append(PersonalReportPicture(picture: picture)) }
            else { problem = "That picture could not be added." }
        }
        return problem
    }

    func removePicture(_ id: UUID) { pictures.removeAll { $0.id == id } }

    func switchKind(_ new: PersonalReportKind) { kind = new; failure = nil; Task { await prepare() } }

    func send(theme: String) async {
        guard unavailable == nil, titleProblem == nil, bodyProblem == nil, !sending else { return }
        sending = true; failure = nil
        defer { sending = false }
        do {
            if prepared == nil, withDiagnostics || chosenChat != nil { await prepare() }
            if (withDiagnostics || chosenChat != nil), prepared == nil { throw MobileError.message("The diagnostics could not be collected. Turn them off and send again.") }
            var params: [String: JSON] = [
                "kind": .string(kind.rawValue), "title": .string(title.trimmingCharacters(in: .whitespacesAndNewlines)), "description": .string(description.trimmingCharacters(in: .whitespacesAndNewlines)),
                "app": app(theme: theme), "diagnostics": diagnosticsToSend ?? .null, "chat": chatToSend ?? .null,
                "screenshots": .array(pictures.map { .obj(["mime": "image/jpeg", "dataBase64": .string($0.picture.data.base64EncodedString()), "width": .number(Double($0.picture.width)), "height": .number(Double($0.picture.height))]) }),
            ]
            if !contact.trimmingCharacters(in: .whitespaces).isEmpty { params["contact"] = .string(contact.trimmingCharacters(in: .whitespaces)) }
            let result = try await store.rpc.call("reports.submit", params)
            receipt = (result["id"].string, kind)
            drafts[kind] = nil; pictures = []; featureDiagnostics = false; withChat = false; prepared = nil
        } catch is CancellationError { return } catch { failure = PersonalFailure.text(error) }
    }
}
