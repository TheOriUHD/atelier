import SwiftUI

/// One field of a connector's form, read from its flat JSON Schema property.
struct ChatElicitationField: Identifiable, Equatable {
    enum Kind: Equatable { case text, number, integer, boolean, choice, choices }
    let name: String
    let label: String
    var detail = ""
    var required = false
    var kind: Kind = .text
    var keyboard: UIKeyboardType = .default
    var options: [(value: String, label: String)] = []
    var minimum: Double?
    var maximum: Double?
    var maxLength: Int?
    var id: String { name }
    static func == (lhs: ChatElicitationField, rhs: ChatElicitationField) -> Bool { lhs.name == rhs.name && lhs.kind == rhs.kind }

    private static func choices(_ schema: JSON) -> [(String, String)]? {
        let names = schema["enumNames"].array.map(\.string)
        if case .array(let values) = schema["enum"] { return values.enumerated().map { index, value in (Self.text(value), names.indices.contains(index) && !names[index].isEmpty ? names[index] : Self.text(value)) } }
        let variants = schema["oneOf"].array.isEmpty ? schema["anyOf"].array : schema["oneOf"].array
        if variants.isEmpty { return nil }
        return variants.map { (Self.text($0["const"]), $0["title"].string.isEmpty ? Self.text($0["const"]) : $0["title"].string) }
    }

    private static func text(_ value: JSON) -> String {
        switch value {
        case .string(let s): s
        case .number(let n): n.rounded() == n ? String(Int(n)) : String(n)
        case .bool(let b): String(b)
        default: ""
        }
    }

    /// The form a connector asks for, one field per property; properties of other kinds are left out.
    static func fields(_ schema: JSON) -> [ChatElicitationField] {
        let required = Set(schema["required"].array.map(\.string))
        return schema["properties"].entries.compactMap { name, property in
            var field = ChatElicitationField(name: name, label: property["title"].string.isEmpty ? name : property["title"].string, detail: property["description"].string, required: required.contains(name))
            let options = choices(property)
            let items = choices(property["items"])
            if property["type"].string == "array", let items { field.kind = .choices; field.options = items; return field }
            if let options { field.kind = .choice; field.options = options; return field }
            switch property["type"].string {
            case "boolean": field.kind = .boolean
            case "number", "integer":
                field.kind = property["type"].string == "integer" ? .integer : .number
                field.keyboard = field.kind == .integer ? .numberPad : .decimalPad
                if case .number(let low) = property["minimum"] { field.minimum = low }
                if case .number(let high) = property["maximum"] { field.maximum = high }
            case "string":
                field.kind = .text
                switch property["format"].string { case "email": field.keyboard = .emailAddress; case "uri": field.keyboard = .URL; default: break }
                if case .number(let length) = property["maxLength"] { field.maxLength = Int(length) }
            default: return nil
            }
            return field
        }
    }

    func initial(in schema: JSON) -> String {
        let given = schema["properties"][name]["default"]
        switch kind {
        case .boolean: return given.bool ? "true" : "false"
        case .choices: return given.array.map { Self.text($0) }.joined(separator: "\u{1F}")
        default: return given == .null ? "" : Self.text(given)
        }
    }

    /// The answer's content, or the reason it cannot be sent yet.
    static func content(_ fields: [ChatElicitationField], values: [String: String]) -> (content: [String: JSON]?, problem: String?) {
        var content: [String: JSON] = [:]
        for field in fields {
            let value = (values[field.name] ?? "").trimmingCharacters(in: .whitespaces)
            switch field.kind {
            case .boolean: content[field.name] = .bool(value == "true")
            case .choices:
                let picked = value.split(separator: "\u{1F}").map(String.init)
                if picked.isEmpty { if field.required { return (nil, "Choose at least one for \(field.label).") } } else { content[field.name] = .array(picked.map(JSON.string)) }
            case .number, .integer:
                if value.isEmpty { if field.required { return (nil, "Enter \(field.label).") }; continue }
                guard let number = Double(value), number.isFinite, field.kind != .integer || number.rounded() == number else { return (nil, "\(field.label) needs a \(field.kind == .integer ? "whole " : "")number.") }
                if let low = field.minimum, number < low { return (nil, "\(field.label) is at least \(Int(low)).") }
                if let high = field.maximum, number > high { return (nil, "\(field.label) is at most \(Int(high)).") }
                content[field.name] = .number(number)
            case .choice, .text:
                if value.isEmpty { if field.required { return (nil, "Enter \(field.label).") }; continue }
                content[field.name] = .string(value)
            }
        }
        return (content, nil)
    }
}

/// A connector asks for a few values during a tool call (form mode), or for the person to open a link (URL mode).
struct ElicitationForm: View {
    let payload: JSON
    let submit: (JSON) -> Void
    var busy = false
    @State private var values: [String: String] = [:]
    @State private var showProblem = false
    @Environment(\.openURL) private var openURL
    private var schema: JSON { payload["requestedSchema"] }
    private var fields: [ChatElicitationField] { ChatElicitationField.fields(schema) }
    private var result: (content: [String: JSON]?, problem: String?) { ChatElicitationField.content(fields, values: values) }
    private var link: URL? { URL(string: payload["url"].string).flatMap { $0.scheme == "https" || $0.scheme == "http" ? $0 : nil } }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(payload["message"].string).font(.subheadline).foregroundStyle(Theme.inkSecondary).fixedSize(horizontal: false, vertical: true)
            if payload["url"].string.isEmpty {
                ForEach(fields) { field in fieldView(field) }
            } else if let link {
                VStack(alignment: .leading, spacing: 8) {
                    Text(link.absoluteString).font(.mono(.footnote)).foregroundStyle(Theme.ink).textSelection(.enabled).padding(12).frame(maxWidth: .infinity, alignment: .leading).background(Theme.fill, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    Button { openURL(link) } label: { Label("Open link", systemImage: "arrow.up.forward.square") }.font(.subheadline.weight(.medium)).tint(Theme.clay)
                    Text("It opens in your browser, only when you choose.").font(.footnote).foregroundStyle(Theme.inkMuted)
                }
            }
            if showProblem, let problem = result.problem { Text(problem).font(.footnote).foregroundStyle(Theme.danger) }
            HStack(spacing: 10) {
                Button("Decline") { submit(.object(["action": .string("decline")])) }.buttonStyle(QuietButtonStyle()).disabled(busy)
                Button("Submit") { accept() }.buttonStyle(ClayButtonStyle(busy: busy)).disabled(busy)
            }
            Button("Cancel") { submit(.object(["action": .string("cancel")])) }.font(.subheadline).foregroundStyle(Theme.inkMuted).disabled(busy).frame(maxWidth: .infinity)
        }
        .onAppear { for field in fields where values[field.name] == nil { values[field.name] = field.initial(in: schema) } }
    }

    @ViewBuilder private func fieldView(_ field: ChatElicitationField) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            switch field.kind {
            case .boolean:
                Toggle(isOn: Binding(get: { values[field.name] == "true" }, set: { values[field.name] = $0 ? "true" : "false" })) { Text(field.label).font(.subheadline.weight(.medium)) }.tint(Theme.clay)
            case .choice:
                Text(label(field)).font(.subheadline.weight(.medium))
                ForEach(field.options, id: \.value) { option in
                    let selected = values[field.name] == option.value
                    Button { values[field.name] = option.value } label: {
                        HStack { Image(systemName: selected ? "largecircle.fill.circle" : "circle").foregroundStyle(selected ? Theme.clay : Theme.inkMuted); Text(option.label).font(.subheadline).foregroundStyle(Theme.ink); Spacer() }.contentShape(Rectangle())
                    }.buttonStyle(.plain)
                }
            case .choices:
                Text(label(field)).font(.subheadline.weight(.medium))
                ForEach(field.options, id: \.value) { option in
                    let picked = (values[field.name] ?? "").split(separator: "\u{1F}").map(String.init)
                    let selected = picked.contains(option.value)
                    Button { values[field.name] = (selected ? picked.filter { $0 != option.value } : picked + [option.value]).joined(separator: "\u{1F}") } label: {
                        HStack { Image(systemName: selected ? "checkmark.square.fill" : "square").foregroundStyle(selected ? Theme.clay : Theme.inkMuted); Text(option.label).font(.subheadline).foregroundStyle(Theme.ink); Spacer() }.contentShape(Rectangle())
                    }.buttonStyle(.plain)
                }
            case .text, .number, .integer:
                Text(label(field)).font(.subheadline.weight(.medium))
                TextField("", text: Binding(get: { values[field.name] ?? "" }, set: { new in values[field.name] = field.maxLength.map { String(new.prefix($0)) } ?? new }), axis: .vertical)
                    .keyboardType(field.keyboard).textInputAutocapitalization(.never).autocorrectionDisabled()
                    .padding(12).background(Theme.fill, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
            if !field.detail.isEmpty { Text(field.detail).font(.footnote).foregroundStyle(Theme.inkMuted) }
        }
    }

    private func label(_ field: ChatElicitationField) -> String { field.required ? field.label : "\(field.label) (optional)" }

    private func accept() {
        if !payload["url"].string.isEmpty { submit(.object(["action": .string("accept")])); return }
        guard let content = result.content else { showProblem = true; return }
        submit(.object(["action": .string("accept"), "content": .object(content)]))
    }
}
