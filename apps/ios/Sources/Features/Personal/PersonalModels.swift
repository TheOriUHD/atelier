import SwiftUI

// MARK: - Choosing a model for a slot (the defaults in General, the model that does memory work)

struct PersonalModelOption: Identifiable, Equatable {
    let ref: String
    let name: String
    let provider: String
    /// The computer a personal model runs on.
    let device: String?
    /// False while a personal model's computer is not connected: listed, but it can't answer.
    let available: Bool
    var id: String { ref }

    /// The visible models of a list (`models.list` or `imageModels.list`), in the server's order.
    static func options(from models: [JSON], providerNames: [String: String], include: (JSON) -> Bool = { _ in true }) -> [PersonalModelOption] {
        models.filter { !$0["hidden"].bool && include($0) }.map { model in
            let providerID = model["providerId"].string
            let device = model["personal"]["deviceName"].stringOrNil
            let provider = device ?? providerNames[providerID] ?? model["providerName"].stringOrNil ?? providerID
            return PersonalModelOption(ref: model["ref"].string, name: model["displayName"].string, provider: provider, device: device, available: model["available"].boolOrNil ?? true)
        }
    }

    /// Options grouped by where they come from, in order of first appearance.
    static func grouped(_ options: [PersonalModelOption]) -> [(provider: String, models: [PersonalModelOption])] {
        var order: [String] = []
        var groups: [String: [PersonalModelOption]] = [:]
        for option in options {
            if groups[option.provider] == nil { order.append(option.provider) }
            groups[option.provider, default: []].append(option)
        }
        return order.map { ($0, groups[$0] ?? []) }
    }
}

/// A pushed list of models with a "server default" row first; choosing one closes it.
struct PersonalModelChoicePage: View {
    let title: String
    var footer: String?
    let options: [PersonalModelOption]
    let unsetLabel: String
    /// The ref chosen, "" for the default.
    let selection: String
    let choose: (String?) -> Void
    @Environment(\.dismiss) private var dismiss

    private var unavailable: Bool { !selection.isEmpty && !options.contains { $0.ref == selection } }

    var body: some View {
        PersonalPage(title: title) {
            Section {
                row(unsetLabel, subtitle: nil, selected: selection.isEmpty, offline: false) { choose(nil) }
                if unavailable { row("\(selection) (unavailable)", subtitle: "This model is no longer offered. The default is used until you choose another.", selected: true, offline: true) { choose(selection) } }
            } footer: { if let footer { Text(footer) } }
            ForEach(PersonalModelOption.grouped(options), id: \.provider) { group in
                Section(group.provider) {
                    ForEach(group.models) { model in
                        row(model.name, subtitle: model.available ? nil : "Not connected right now", selected: selection == model.ref, offline: !model.available) { choose(model.ref) }
                    }
                }
            }
        }
    }

    private func row(_ title: String, subtitle: String?, selected: Bool, offline: Bool, action: @escaping () -> Void) -> some View {
        Button { action(); dismiss() } label: {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).foregroundStyle(offline ? Theme.inkSecondary : Theme.ink)
                    if let subtitle { Text(subtitle).font(.footnote).foregroundStyle(Theme.inkMuted) }
                }
                Spacer(minLength: 8)
                if selected { Image(systemName: "checkmark").font(.body.weight(.semibold)).foregroundStyle(Theme.clay) }
            }.contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

// MARK: - Languages dictation hears

struct PersonalLanguage: Identifiable, Hashable {
    let code: String
    let label: String
    let native: String
    var id: String { code }

    static let auto = PersonalLanguage(code: "auto", label: "Auto", native: "")

    static func label(for code: String) -> String { all.first { $0.code == code }?.label ?? (code == "auto" || code.isEmpty ? "Auto" : code) }

    /// The languages the desktop's menu offers, most spoken first.
    static let all: [PersonalLanguage] = [
        ("en", "English", "English"), ("zh", "Chinese", "中文"), ("hi", "Hindi", "हिन्दी"), ("es", "Spanish", "Español"), ("fr", "French", "Français"),
        ("ar", "Arabic", "العربية"), ("pt", "Portuguese", "Português"), ("ru", "Russian", "Русский"), ("de", "German", "Deutsch"), ("ja", "Japanese", "日本語"),
        ("it", "Italian", "Italiano"), ("ko", "Korean", "한국어"), ("tr", "Turkish", "Türkçe"), ("nl", "Dutch", "Nederlands"), ("pl", "Polish", "Polski"),
        ("uk", "Ukrainian", "Українська"), ("vi", "Vietnamese", "Tiếng Việt"), ("id", "Indonesian", "Bahasa Indonesia"), ("th", "Thai", "ไทย"), ("sv", "Swedish", "Svenska"),
        ("da", "Danish", "Dansk"), ("no", "Norwegian", "Norsk"), ("fi", "Finnish", "Suomi"), ("cs", "Czech", "Čeština"), ("sk", "Slovak", "Slovenčina"),
        ("hu", "Hungarian", "Magyar"), ("ro", "Romanian", "Română"), ("bg", "Bulgarian", "Български"), ("el", "Greek", "Ελληνικά"), ("he", "Hebrew", "עברית"),
        ("fa", "Persian", "فارسی"), ("ur", "Urdu", "اردو"), ("bn", "Bengali", "বাংলা"), ("ta", "Tamil", "தமிழ்"), ("ms", "Malay", "Bahasa Melayu"),
        ("tl", "Tagalog", "Tagalog"), ("sw", "Swahili", "Kiswahili"), ("ca", "Catalan", "Català"), ("hr", "Croatian", "Hrvatski"), ("sr", "Serbian", "Српски"),
        ("sl", "Slovenian", "Slovenščina"), ("lt", "Lithuanian", "Lietuvių"), ("lv", "Latvian", "Latviešu"), ("et", "Estonian", "Eesti"), ("is", "Icelandic", "Íslenska"),
        ("ga", "Irish", "Gaeilge"), ("cy", "Welsh", "Cymraeg"), ("af", "Afrikaans", "Afrikaans"),
    ].map { PersonalLanguage(code: $0.0, label: $0.1, native: $0.2) }

    /// The languages matching what was typed, in their own name or in English.
    static func matching(_ query: String) -> [PersonalLanguage] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return all }
        return all.filter { $0.label.lowercased().contains(q) || $0.native.lowercased().contains(q) || $0.code == q }
    }
}

struct PersonalLanguagePage: View {
    let selection: String
    let choose: (String) -> Void
    @State private var query = ""
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        PersonalPage(title: "Dictation language") {
            if query.isEmpty {
                Section {
                    row(PersonalLanguage.auto, hint: "The service hears which language it is.")
                } footer: { Text("Naming the language you speak helps with short phrases and names.") }
            }
            Section {
                ForEach(PersonalLanguage.matching(query)) { row($0, hint: nil) }
            }
        }
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search languages")
    }
    private func row(_ language: PersonalLanguage, hint: String?) -> some View {
        Button { choose(language.code); dismiss() } label: {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(language.label).foregroundStyle(Theme.ink)
                    if let hint { Text(hint).font(.footnote).foregroundStyle(Theme.inkMuted) }
                    else if !language.native.isEmpty && language.native != language.label { Text(language.native).font(.footnote).foregroundStyle(Theme.inkMuted) }
                }
                Spacer(minLength: 8)
                if selection == language.code { Image(systemName: "checkmark").font(.body.weight(.semibold)).foregroundStyle(Theme.clay) }
            }.contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selection == language.code ? .isSelected : [])
    }
}

// MARK: - A short list of named choices on its own page

struct PersonalOption: Identifiable, Equatable {
    let id: String
    let label: String
    var detail: String?
}

/// A pushed list of choices with a check on the current one; choosing one closes it.
struct PersonalOptionsPage: View {
    let title: String
    var footer: String?
    let options: [PersonalOption]
    let selection: String
    let choose: (String) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        PersonalPage(title: title) {
            Section {
                ForEach(options) { option in
                    Button { choose(option.id); dismiss() } label: {
                        HStack(spacing: 10) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(option.label).foregroundStyle(Theme.ink)
                                if let detail = option.detail { Text(detail).font(.footnote).foregroundStyle(Theme.inkMuted) }
                            }
                            Spacer(minLength: 8)
                            if selection == option.id { Image(systemName: "checkmark").font(.body.weight(.semibold)).foregroundStyle(Theme.clay) }
                        }.contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(selection == option.id ? .isSelected : [])
                }
            } footer: { if let footer { Text(footer) } }
        }
    }
}
