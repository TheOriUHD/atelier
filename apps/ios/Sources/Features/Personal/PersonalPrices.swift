import SwiftUI

// MARK: - Prices (an admin's): dollars per million tokens for each model, kept in the system settings' price table (`settings.pricing`)

enum PersonalPricing {
    struct Price: Equatable {
        var input: Double
        var output: Double
        var cacheRead: Double?
        var cacheWrite: Double?
    }

    struct Entry: Identifiable, Equatable {
        let ref: String
        let price: Price
        /// The whole stored price, so what this page doesn't edit (a long-context price) is kept.
        let stored: JSON
        var id: String { ref }
    }

    /// The price table of the effective settings, by model ref.
    static func entries(_ pricing: JSON) -> [Entry] {
        pricing.entries.compactMap { ref, value in
            guard case .number(let input) = value["input"], case .number(let output) = value["output"] else { return nil }
            var price = Price(input: input, output: output)
            if case .number(let n) = value["cacheRead"] { price.cacheRead = n }
            if case .number(let n) = value["cacheWrite"] { price.cacheWrite = n }
            return Entry(ref: ref, price: price, stored: value)
        }
    }

    static let message = "Enter dollars per million tokens, like 3 or 0.25."

    /// Whether a typed amount is a plain decimal number; an optional field may be empty.
    static func valid(_ text: String, required: Bool) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty { return !required }
        return trimmed.range(of: #"^(\d+\.?\d*|\.\d+)$"#, options: .regularExpression) != nil
    }

    static func problem(model: String, input: String, output: String, cacheRead: String, cacheWrite: String) -> String? {
        if model.isEmpty { return "Choose a model." }
        if !valid(input, required: true) || !valid(output, required: true) || !valid(cacheRead, required: false) || !valid(cacheWrite, required: false) { return message }
        return nil
    }

    /// The price as the settings store it, with what was stored before kept (a long-context price).
    static func json(input: String, output: String, cacheRead: String, cacheWrite: String, keeping stored: JSON = .null) -> JSON {
        var object: [String: JSON]
        if case .object(let existing) = stored { object = existing } else { object = [:] }
        object["input"] = .number(Double(input.trimmingCharacters(in: .whitespaces)) ?? 0)
        object["output"] = .number(Double(output.trimmingCharacters(in: .whitespaces)) ?? 0)
        let read = cacheRead.trimmingCharacters(in: .whitespaces), write = cacheWrite.trimmingCharacters(in: .whitespaces)
        if read.isEmpty { object.removeValue(forKey: "cacheRead") } else { object["cacheRead"] = .number(Double(read) ?? 0) }
        if write.isEmpty { object.removeValue(forKey: "cacheWrite") } else { object["cacheWrite"] = .number(Double(write) ?? 0) }
        return .object(object)
    }

    /// "3", "0.25", "15.5": a price as it is typed.
    static func text(_ value: Double?) -> String {
        guard let value else { return "" }
        return value == value.rounded() ? String(Int(value)) : String(value)
    }

    static func display(_ value: Double?) -> String { value.map { PersonalUsage.usd($0) } ?? "as input" }
}

struct PersonalPricesPage: View {
    let store: AppStore
    @State private var prices: Resource<JSON>
    @State private var editing: PersonalPriceDraft?
    @State private var removing: PersonalPricing.Entry?
    @State private var names: [String: String] = [:]

    init(store: AppStore) {
        self.store = store
        let call = store.personalCall
        _prices = State(initialValue: .personal { try await call("settings.get", [:])["effective"]["pricing"] })
    }

    var body: some View {
        PersonalPage(title: "Prices") {
            PersonalLoad(resource: prices) { pricing in
                let entries = PersonalPricing.entries(pricing)
                Section {
                    if entries.isEmpty {
                        Text("No prices yet. Requests count their tokens, without a cost.").font(.subheadline).foregroundStyle(Theme.inkMuted)
                    } else {
                        ForEach(entries) { entry in
                            Button { editing = PersonalPriceDraft(entry: entry) } label: { row(entry) }.buttonStyle(.plain)
                                .swipeActions { Button("Remove", role: .destructive) { removing = entry } }
                        }
                    }
                } footer: {
                    Text("Dollars per million tokens, per model, in place of the provider's list price (Anthropic, OpenAI and Mistral models without one here use it). A price counts for requests made after it is set.")
                }
                Section { ActionRow(title: "Add a price", symbol: "plus") { editing = PersonalPriceDraft(entry: nil) } }
            }
        }
        .task { await prices.reload(); names = Dictionary(store.models.map { ($0["ref"].string, $0["displayName"].string) }, uniquingKeysWith: { first, _ in first }) }
        .refreshable { await prices.reload() }
        .sheet(item: $editing) { draft in
            PersonalPriceEditor(draft: draft, models: store.models.filter { !$0["hidden"].bool }, pricing: prices.value ?? .null, names: names) { ref, price in
                try await save(setting: ref, to: price)
            }
        }
        .confirmationDialog(removing.map { "Remove the price of \(name($0.ref))?" } ?? "Remove?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), titleVisibility: .visible, presenting: removing) { entry in
            Button("Remove price", role: .destructive) { personalAction(store) { try await save(setting: entry.ref, to: nil); store.notify("Price removed") } }
        } message: { _ in Text("Requests made from now on count their tokens without a cost.") }
    }

    private func name(_ ref: String) -> String { names[ref] ?? String(ref.split(separator: "/", maxSplits: 1).last ?? Substring(ref)) }

    private func row(_ entry: PersonalPricing.Entry) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline) {
                Text(name(entry.ref)).foregroundStyle(Theme.ink).lineLimit(2)
                Spacer(minLength: 8)
                Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Color(uiColor: .tertiaryLabel))
            }
            Text("Input \(PersonalPricing.display(entry.price.input)) · Output \(PersonalPricing.display(entry.price.output))").font(.footnote).foregroundStyle(Theme.inkSecondary).monospacedDigit()
            Text("Cache read \(PersonalPricing.display(entry.price.cacheRead)) · Cache write \(PersonalPricing.display(entry.price.cacheWrite))").font(.footnote).foregroundStyle(Theme.inkMuted).monospacedDigit()
        }.contentShape(Rectangle()).accessibilityElement(children: .combine)
    }

    /// Writes the whole table with one price changed (or taken out), as the desktop does.
    private func save(setting ref: String, to price: JSON?) async throws {
        var table: [String: JSON] = [:]
        if case .object(let existing) = prices.value ?? .null { table = existing }
        if let price { table[ref] = price } else { table.removeValue(forKey: ref) }
        _ = try await store.rpc.call("settings.set", ["layer": "global", "path": ["pricing"], "value": .object(table)])
        await prices.reload()
    }
}

struct PersonalPriceDraft: Identifiable {
    let entry: PersonalPricing.Entry?
    var id: String { entry?.ref ?? "new" }
}

struct PersonalPriceEditor: View {
    let draft: PersonalPriceDraft
    let models: [JSON]
    let pricing: JSON
    let names: [String: String]
    let save: (String, JSON) async throws -> Void
    @State private var model: String
    @State private var input: String
    @State private var output: String
    @State private var cacheRead: String
    @State private var cacheWrite: String
    @State private var saving = false
    @State private var failure: String?
    @State private var tried = false
    @Environment(\.dismiss) private var dismiss

    init(draft: PersonalPriceDraft, models: [JSON], pricing: JSON, names: [String: String], save: @escaping (String, JSON) async throws -> Void) {
        self.draft = draft; self.models = models; self.pricing = pricing; self.names = names; self.save = save
        _model = State(initialValue: draft.entry?.ref ?? "")
        _input = State(initialValue: PersonalPricing.text(draft.entry?.price.input))
        _output = State(initialValue: PersonalPricing.text(draft.entry?.price.output))
        _cacheRead = State(initialValue: PersonalPricing.text(draft.entry?.price.cacheRead))
        _cacheWrite = State(initialValue: PersonalPricing.text(draft.entry?.price.cacheWrite))
    }

    private var problem: String? { PersonalPricing.problem(model: model, input: input, output: output, cacheRead: cacheRead, cacheWrite: cacheWrite) }
    private var choices: [JSON] { models.filter { pricing[$0["ref"].string] == .null } }

    var body: some View {
        NavigationStack {
            PersonalPage(title: draft.entry == nil ? "Add a price" : "Edit price") {
                Section {
                    if let entry = draft.entry {
                        ValueRow(title: "Model", value: names[entry.ref] ?? entry.ref)
                    } else {
                        Picker("Model", selection: $model) {
                            Text("Choose a model").tag("")
                            ForEach(choices, id: \.self) { Text($0["displayName"].string).tag($0["ref"].string) }
                        }.pickerStyle(.menu).tint(Theme.inkSecondary)
                    }
                }
                Section {
                    amount("Input", $input, required: true)
                    amount("Output", $output, required: true)
                    amount("Cache read", $cacheRead, required: false)
                    amount("Cache write", $cacheWrite, required: false)
                } header: { Text("Dollars per million tokens") } footer: {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Leave the cache prices empty to count them as input.")
                        if tried, let problem { Text(problem).foregroundStyle(Theme.danger) }
                        if let failure { Text(failure).foregroundStyle(Theme.danger) }
                    }
                }
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(saving) }
                ToolbarItem(placement: .confirmationAction) { Button("Save") { submit() }.disabled(saving) }
            }
        }
        .tint(Theme.clay)
        .presentationDetents([.medium, .large])
    }

    private func amount(_ title: String, _ text: Binding<String>, required: Bool) -> some View {
        HStack {
            Text(title).foregroundStyle(Theme.ink)
            Spacer(minLength: 8)
            TextField(required ? "0.00" : "As input", text: text).keyboardType(.decimalPad).multilineTextAlignment(.trailing).font(.body.monospacedDigit())
                .frame(maxWidth: 120)
                .foregroundStyle(tried && !PersonalPricing.valid(text.wrappedValue, required: required) ? Theme.danger : Theme.ink)
                .accessibilityLabel("\(title), dollars per million tokens")
        }
    }

    private func submit() {
        tried = true; failure = nil
        guard problem == nil else { return }
        saving = true
        Task {
            defer { saving = false }
            do {
                try await save(model, PersonalPricing.json(input: input, output: output, cacheRead: cacheRead, cacheWrite: cacheWrite, keeping: draft.entry?.stored ?? .null))
                dismiss()
            } catch is CancellationError { return } catch { failure = PersonalFailure.text(error) }
        }
    }
}
