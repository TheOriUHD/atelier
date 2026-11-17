import SwiftUI

// MARK: - General: how Atelier looks, the models new conversations start with, dictation, notifications

/// What General needs besides the preferences: the server's settings (for names and what it offers), the image models and dictation.
@MainActor @Observable final class PersonalGeneralExtras {
    var settings: JSON = .null
    var imageModels: [JSON] = []
    var dictation: JSON = .null
    private(set) var loaded = false
    private let call: PersonalCall
    init(call: @escaping PersonalCall) { self.call = call }

    func load() async {
        // Each is best effort: an older server may lack one, and the page still works without it.
        settings = (try? await call("settings.get", [:]))?["effective"] ?? settings
        imageModels = (try? await call("imageModels.list", [:]))?.array ?? imageModels
        dictation = (try? await call("dictation.status", [:])) ?? dictation
        loaded = true
    }

    var providerNames: [String: String] {
        var names: [String: String] = [:]
        for provider in settings["providers"].array + settings["imageProviders"].array { names[provider["id"].string] = provider["name"].string }
        return names
    }

    var imageGenerationOn: Bool { settings["imageGeneration"]["enabled"].boolOrNil ?? false }
    var videoOn: Bool { settings["imageGeneration"]["videoEnabled"].boolOrNil != false }
    var audioOn: Bool { settings["imageGeneration"]["audioEnabled"].boolOrNil != false }

    func output(_ model: JSON) -> String { model["capabilities"]["output"].stringOrNil ?? "image" }

    func imageOptions(_ kind: PersonalGeneralSlot.Kind) -> [PersonalModelOption] {
        PersonalModelOption.options(from: imageModels, providerNames: providerNames) { _ in true }.filter { option in
            guard let model = imageModels.first(where: { $0["ref"].string == option.ref }) else { return false }
            switch kind {
            case .image: return output(model) == "image"
            case .video: return output(model) == "video"
            case .speech, .music, .sound:
                return output(model) == "audio" && model["capabilities"]["audio"]["kinds"].array.contains(.string(kind.rawValue))
            }
        }
    }

    /// The server's own default for a slot, for the "Server default" row.
    func serverDefault(_ key: String, in options: [PersonalModelOption]) -> PersonalModelOption? {
        options.first { $0.ref == settings["models"]["defaults"][key].string } ?? options.first
    }
}

struct PersonalGeneralSlot: Identifiable {
    enum Kind: String { case image, video, speech, music, sound }
    let kind: Kind
    var id: String { kind.rawValue }
    var title: String {
        switch kind {
        case .image: "Default image model"
        case .video: "Default video model"
        case .speech: "Default speech model"
        case .music: "Default music model"
        case .sound: "Default sound effects model"
        }
    }
    var subtitle: String {
        switch kind {
        case .image: "What makes your images, unless you pick another in a conversation or name one when you ask."
        case .video: "What makes your videos, unless you name another when you ask. A model that makes video from a picture only needs one to start from."
        case .speech: "What reads text aloud for you, unless you name another when you ask. Each model has its own voices."
        case .music: "What makes your songs and background music, unless you name another when you ask."
        case .sound: "What makes your sound effects and ambience, unless you name another when you ask."
        }
    }
    var noun: String {
        switch kind {
        case .image: "Your images"
        case .video: "Your videos"
        case .speech: "Your speech"
        case .music: "Your music"
        case .sound: "Your sound effects"
        }
    }
}

/// A title with what it is set to on the right, in a row that opens a list of choices.
struct PersonalChoiceLabel: View {
    let title: String
    var subtitle: String?
    let value: String
    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text(title).foregroundStyle(Theme.ink)
                Spacer(minLength: 8)
                Text(value).font(.subheadline).foregroundStyle(Theme.inkMuted).lineLimit(1).truncationMode(.tail).frame(maxWidth: 170, alignment: .trailing)
            }
            if let subtitle { Text(subtitle).font(.footnote).foregroundStyle(Theme.inkMuted) }
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

struct GeneralSettings: View {
    let store: AppStore
    @State private var prefs: PersonalPrefs
    @State private var extras: PersonalGeneralExtras
    @AppStorage("appearance") private var appearance = "system"
    /// Debug builds launched with `--sub model|language|source` open that choice page, to look at it.
    @State private var debugRoute: String?

    init(store: AppStore) {
        self.store = store
        _prefs = State(initialValue: PersonalPrefs(store: store))
        _extras = State(initialValue: PersonalGeneralExtras(call: store.personalCall))
        #if DEBUG
        _debugRoute = State(initialValue: Launch.value("--sub"))
        #endif
    }

    var body: some View {
        PersonalPage(title: "General") {
            Section {
                Picker("Theme", selection: $appearance) {
                    Text("System").tag("system")
                    Text("Light").tag("light")
                    Text("Dark").tag("dark")
                }
                .pickerStyle(.segmented).padding(.vertical, 2)
                .accessibilityLabel("Theme")
            } header: { Text("Appearance") } footer: {
                Text("The theme is for this device. Chat font, text size, width and motion are saved to your account for your computer and the browser. This app uses the text size you set in iOS.")
            }
            PersonalPrefsGate(prefs: prefs) {
                Section {
                    PrefPickRow(prefs: prefs, path: ["appearance", "chatFont"], title: "Chat font", options: [("serif", "Atelier Serif"), ("sans", "Atelier Sans"), ("system", "System"), ("dyslexic", "OpenDyslexic")], defaultValue: "serif")
                    PrefPickRow(prefs: prefs, path: ["appearance", "textSize"], title: "Transcript text size", options: [("s", "Small"), ("m", "Medium"), ("l", "Large")], defaultValue: "m")
                    PrefPickRow(prefs: prefs, path: ["appearance", "transcriptWidth"], title: "Transcript width", options: [("narrow", "Narrow"), ("medium", "Medium"), ("wide", "Wide")], defaultValue: "medium")
                    PrefPickRow(prefs: prefs, path: ["appearance", "motion"], title: "Motion", subtitle: "Reduce animation in streaming responses and other interface elements.", options: [("system", "System"), ("reduced", "Reduced")], defaultValue: "system")
                }
                chatSection
                dictationSection
                Section {
                    PrefToggleRow(prefs: prefs, path: ["notifications", "taskFinished"], title: "Notify me when a task finishes", subtitle: "A system notification when a chat's task ends while you're in another window or app.", defaultValue: true)
                    PrefToggleRow(prefs: prefs, path: ["notifications", "permissionNeeded"], title: "Notify me when a task needs me", subtitle: "A system notification when a chat's task waits for your answer or permission.", defaultValue: true)
                } header: { Text("Notifications") } footer: {
                    Text("These apply on your computer and in the browser. Atelier on iPhone and iPad can't be notified while it is closed: server tasks keep running, and open the app to see where they got to.")
                }
            }
        }
        .task { await prefs.load(); await extras.load() }
        .refreshable { await prefs.load(); await extras.load() }
        #if DEBUG
        .navigationDestination(item: $debugRoute) { name in
            switch name {
            case "model": PersonalModelChoicePage(title: "Default model", footer: "New chats start with this model. “Server default” follows the one set for everyone.", options: textModels, unsetLabel: "Server default (Opus 5.5)", selection: prefs.string(["models", "chat"])) { _ in }
            case "language": PersonalLanguagePage(selection: prefs.string(["dictation", "language"], default: "auto")) { _ in }
            default: PersonalOptionsPage(title: "Speech-to-text service", footer: "Automatic uses Atelier's own speech model.", options: [PersonalOption(id: "auto", label: "Automatic", detail: "Now: Nemotron 3.5 ASR · Atelier, on this server"), PersonalOption(id: "a", label: "Voxtral Realtime · Mistral", detail: "Words appear as you speak"), PersonalOption(id: "b", label: "Whisper · OpenAI", detail: "A phrase at a time, at each pause")], selection: "auto") { _ in }
            }
        }
        #endif
    }

    // MARK: Models

    private var textModels: [PersonalModelOption] {
        PersonalModelOption.options(from: store.models, providerNames: extras.providerNames)
    }

    @ViewBuilder private var chatSection: some View {
        let options = textModels
        let server = extras.serverDefault("chat", in: options)
        let chosen = prefs.string(["models", "chat"])
        Section {
            NavigationLink {
                PersonalModelChoicePage(title: "Default model", footer: "New chats start with this model. “Server default” follows the one set for everyone.", options: options,
                                        unsetLabel: "Server default\(server.map { " (\($0.name))" } ?? "")", selection: chosen) { ref in Task { await setModel("chat", ref) } }
            } label: {
                PersonalChoiceLabel(title: "Default model", subtitle: "New chats start with this model.", value: chosenName(chosen, in: options, fallback: "Server default"))
            }
            PrefToggleRow(prefs: prefs, path: ["models", "rememberLast"], title: "Start with the model I used last",
                          subtitle: "The model you pick in a conversation is the one the next new conversation starts with. Turn it off to always start with the one chosen above.", defaultValue: true)
            if extras.imageGenerationOn {
                ForEach(slots) { slot in slotRow(slot) }
            }
        } header: { Text("Chat") } footer: {
            if !chosen.isEmpty, !options.contains(where: { $0.ref == chosen }), !store.models.isEmpty {
                Text("The model you chose is no longer available. New chats start with the server default until you choose another.")
            }
        }
    }

    private var slots: [PersonalGeneralSlot] {
        var list: [PersonalGeneralSlot] = []
        if shows(.image) { list.append(.init(kind: .image)) }
        if extras.videoOn, shows(.video) { list.append(.init(kind: .video)) }
        if extras.audioOn && store.offers("audioGeneration") { for kind in [PersonalGeneralSlot.Kind.speech, .music, .sound] where shows(kind) { list.append(.init(kind: kind)) } }
        return list
    }

    private func shows(_ kind: PersonalGeneralSlot.Kind) -> Bool { !extras.imageOptions(kind).isEmpty || !prefs.string(["models", kind.rawValue]).isEmpty }

    private func slotRow(_ slot: PersonalGeneralSlot) -> some View {
        let options = extras.imageOptions(slot.kind)
        let server = extras.serverDefault(slot.kind.rawValue, in: options)
        let chosen = prefs.string(["models", slot.kind.rawValue])
        return NavigationLink {
            PersonalModelChoicePage(title: slot.title, footer: slot.subtitle, options: options, unsetLabel: "Server default\(server.map { " (\($0.name))" } ?? "")", selection: chosen) { ref in Task { await setModel(slot.kind.rawValue, ref) } }
        } label: {
            PersonalChoiceLabel(title: slot.title, subtitle: slot.subtitle, value: chosenName(chosen, in: options, fallback: "Server default"))
        }
    }

    private func chosenName(_ ref: String, in options: [PersonalModelOption], fallback: String) -> String {
        if ref.isEmpty { return fallback }
        return options.first { $0.ref == ref }?.name ?? "Unavailable"
    }

    private func setModel(_ key: String, _ ref: String?) async {
        if let ref { await prefs.set(["models", key], .string(ref)) } else { await prefs.reset(["models", key]) }
    }

    // MARK: Dictation

    @ViewBuilder private var dictationSection: some View {
        let status = extras.dictation
        if status != .null, status["enabled"].bool || store.isAdmin {
            Section {
                if store.isAdmin {
                    ToggleRow(title: "Dictation", subtitle: "The microphone in the message box: speech turns into text as people speak, with a speech-to-text service of the providers set up here.",
                              isOn: Binding(get: { status["enabled"].bool }, set: { on in saveSetting(["dictation", "enabled"], .bool(on)) }))
                }
                if status["enabled"].bool {
                    if store.isAdmin { sourceRow(status) }
                    if store.isAdmin, status["builtin"]["state"].string != "" , status["builtin"]["state"].string != "unsupported" { modelRow(status["builtin"]) }
                    NavigationLink {
                        PersonalLanguagePage(selection: prefs.string(["dictation", "language"], default: "auto")) { code in Task { await prefs.set(["dictation", "language"], .string(code)) } }
                    } label: {
                        PersonalChoiceLabel(title: "Dictation language", subtitle: "The language you speak. Auto lets the service hear it; naming it helps with short phrases and names.", value: PersonalLanguage.label(for: prefs.string(["dictation", "language"], default: "auto")))
                    }
                    PrefToggleRow(prefs: prefs, path: ["dictation", "holdToRecord"], title: "Hold to record", subtitle: "Holding the microphone button or the dictate shortcut records until you let go. A tap still starts and stops dictating.", defaultValue: true)
                }
            } header: { Text("Dictation") } footer: {
                if status["enabled"].bool { Text("Dictation runs on your server. Your voice is sent there while you dictate and not kept.") }
            }
        }
    }

    @ViewBuilder private func sourceRow(_ status: JSON) -> some View {
        let sources = status["sources"].array
        if sources.isEmpty {
            Text("None of the providers here offers speech-to-text yet. Add Mistral, OpenAI, Groq, ElevenLabs or Deepgram, or a local Whisper server, and it shows here.")
                .font(.footnote).foregroundStyle(Theme.inkMuted)
        } else {
            let chosen = status["chosen"].stringOrNil
            let name: (JSON) -> String = { "\($0["label"].string) · \($0["provider"].string)" }
            let current = sources.first { $0["id"].string == chosen }
            NavigationLink {
                PersonalOptionsPage(title: "Speech-to-text service", footer: "Automatic uses Atelier's own speech model. A provider can take its place: Mistral's Voxtral Realtime (live), a local Whisper server, OpenAI, Groq, ElevenLabs or Deepgram.",
                                    options: [PersonalOption(id: "auto", label: "Automatic", detail: status["source"] == .null ? nil : "Now: \(name(status["source"]))")] + sources.map { PersonalOption(id: $0["id"].string, label: name($0), detail: $0["live"].bool ? "Words appear as you speak" : "A phrase at a time, at each pause") },
                                    selection: current?["id"].string ?? "auto") { value in saveSetting(["dictation", "source"], value == "auto" ? nil : .string(value)) }
            } label: {
                PersonalChoiceLabel(title: "Speech-to-text service", value: current.map { $0["label"].string } ?? "Automatic")
            }
        }
    }

    @ViewBuilder private func modelRow(_ state: JSON) -> some View {
        let megabytes: (JSON) -> String = { "\(Int((Double($0.int) / 1e6).rounded())) MB" }
        switch state["state"].string {
        case "ready":
            ValueRow(title: "Atelier's speech model", value: "Downloaded", subtitle: "Runs on your server for everyone who dictates.")
        case "downloading":
            VStack(alignment: .leading, spacing: 8) {
                Text("Atelier's speech model").foregroundStyle(Theme.ink)
                ProgressView(value: Double(state["received"].int), total: Double(max(1, state["total"].int)))
                Text("Downloading: \(megabytes(state["received"])) of \(megabytes(state["total"])).").font(.footnote).foregroundStyle(Theme.inkMuted)
            }
        case "failed":
            VStack(alignment: .leading, spacing: 6) {
                ActionRow(title: "Try the speech model download again", symbol: "arrow.clockwise") { prepareSpeechModel() }
                Text("The download failed: \(state["error"].string.isEmpty ? "unknown error" : state["error"].string)").font(.footnote).foregroundStyle(Theme.danger)
            }
        default:
            VStack(alignment: .leading, spacing: 6) {
                ActionRow(title: "Download Atelier's speech model", symbol: "arrow.down.circle") { prepareSpeechModel() }
                Text("Not downloaded yet (\(megabytes(state["bytes"]))). The first dictation downloads it, or download it now.").font(.footnote).foregroundStyle(Theme.inkMuted)
            }
        }
    }

    private func prepareSpeechModel() {
        personalAction(store) { extras.dictation = try await store.rpc.call("dictation.prepare"); store.notify("Downloading the speech model") }
    }

    private func saveSetting(_ path: [String], _ value: JSON?) {
        personalAction(store) {
            let pathJSON = JSON.array(path.map { JSON.string($0) })
            if let value { _ = try await store.rpc.call("settings.set", ["layer": "global", "path": pathJSON, "value": value]) }
            else { _ = try await store.rpc.call("settings.reset", ["layer": "global", "path": pathJSON]) }
            await extras.load()
        }
    }
}
