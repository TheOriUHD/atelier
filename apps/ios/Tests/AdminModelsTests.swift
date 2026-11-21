import XCTest
@testable import Atelier

/// Logic of the admin pages for providers, media, models, capabilities and secrets: parsers, forms, formatters, and the
/// sign-in flows driven by canned answers. The procedures themselves are exercised against a real server in
/// `AdminModelsIntegrationTests`.
@MainActor final class AdminModelsTests: XCTestCase {
    private func json(_ text: String) -> JSON { try! JSONDecoder().decode(JSON.self, from: Data(text.utf8)) }

    // MARK: The wizards' pages come from ids, never from state kept beside the stack

    /// A pushed form is rebuilt from the id in its route. A route whose id could not be resolved came up as an empty page
    /// (a blank sheet with only a back button), so every service that can be chosen must resolve.
    func testEveryServiceThatCanBeChosenCanBeRebuiltFromItsRoute() {
        for preset in AMMediaPreset.all {
            let route = AMMediaWizardRoute.form(preset.id)
            guard case .form(let id) = route, let found = AMMediaPreset.find(id) else { return XCTFail("\(preset.id) does not resolve") }
            XCTAssertEqual(AMMediaForm.new(found, taken: []).preset.id, preset.id)
        }
        for type in AMProviderType.choosable {
            XCTAssertEqual(AMProviderType(rawValue: type.rawValue), type)
            XCTAssertEqual(AMProviderForm.new(type, taken: []).type, type)
        }
        for preset in AMTextPreset.all {
            XCTAssertEqual(AMTextPreset.all.first { $0.id == preset.id }, preset)
            XCTAssertEqual(AMProviderForm.preset(preset, taken: []).preset, preset)
        }
        XCTAssertEqual(Set(AMTextPreset.all.map(\.id)).count, AMTextPreset.all.count, "ids are unique")
    }

    func testTheDescriptionExampleMatchesTheKindOfModelAndFitsOnOneLine() {
        let examples = [AMMediaModel.Kind.image, .video, .audio].map(AMMediaModelDetail.goodAtExample)
        XCTAssertEqual(Set(examples).count, 3)
        for example in examples { XCTAssertFalse(example.isEmpty); XCTAssertLessThanOrEqual(example.count, 40) }
    }

    // MARK: Failures and paths

    func testFailuresAreClassifiedFromTheServersWords() {
        XCTAssertEqual(AMFailure.from(MobileError.message("Only admins can do this.")), .forbidden)
        XCTAssertEqual(AMFailure.from(MobileError.message("Unknown method imageModels.list")), .unsupported)
        XCTAssertEqual(AMFailure.from(MobileError.message("The key was rejected.")), .message("The key was rejected."))
        XCTAssertEqual(AMFailure.from(MobileError.rpc(code: -32000, appCode: "forbidden", message: "Not allowed", fix: nil)), .forbidden)
        XCTAssertEqual(AMFailure.from(MobileError.rpc(code: -32601, appCode: "", message: "Method not found", fix: nil)), .unsupported)
        XCTAssertEqual(AMFailure.from(MobileError.rpc(code: -32000, appCode: "invalid", message: "Bad address", fix: nil)), .message("Bad address"))
        XCTAssertEqual(AMFailure.forbidden.localizedDescription, "Only admins of this server can do this.")
        XCTAssertEqual(AMFailure.unsupported.localizedDescription, "This server doesn't support this yet.")
    }

    func testPathsReadAndReplaceNestedSettings() {
        let settings = json(#"{"providers":[{"id":"a","enabled":true},{"id":"b"}],"models":{"defaults":{"chat":"x/y"}}}"#)
        XCTAssertEqual(settings.at(["providers", 1, "id"]).string, "b")
        XCTAssertEqual(settings.at(["models", "defaults", "chat"]).string, "x/y")
        XCTAssertEqual(settings.at(["providers", 9, "id"]), .null)
        let changed = settings.replacing(["providers", 0, "enabled"][...], with: false)
        XCTAssertEqual(changed.at(["providers", 0, "enabled"]), .bool(false))
        XCTAssertEqual(changed.at(["providers", 1, "id"]).string, "b", "the rest is untouched")
        let removed = settings.replacing(["models", "defaults", "chat"][...], with: nil)
        XCTAssertEqual(removed.at(["models", "defaults"]), .object([:]))
        let created = JSON.null.replacing(["a", "b"][...], with: 1)
        XCTAssertEqual(created.at(["a", "b"]).int, 1)
    }

    // MARK: Form helpers

    func testSlugsAreLowercaseDashedAndShort() {
        XCTAssertEqual(AMForm.slugify("Ollama (home server)"), "ollama-home-server")
        XCTAssertEqual(AMForm.slugify("  Café Müller  "), "cafe-muller")
        XCTAssertEqual(AMForm.slugify("!!!"), "")
        XCTAssertEqual(AMForm.slugify(String(repeating: "a", count: 80)).count, 48)
        XCTAssertEqual(AMForm.uniqueID("ollama", taken: ["ollama", "ollama-2"]), "ollama-3")
        XCTAssertEqual(AMForm.uniqueID("", taken: []), "provider")
        XCTAssertTrue(AMForm.isValidID("my-provider-2"))
        XCTAssertFalse(AMForm.isValidID("-bad"))
        XCTAssertFalse(AMForm.isValidID("Bad"))
        XCTAssertFalse(AMForm.isValidID(""))
    }

    func testCountsAreEmptyForAutomaticAndInvalidOutsideTheRange() {
        XCTAssertEqual(AMForm.count("", max: 64), .automatic)
        XCTAssertEqual(AMForm.count(" 8 ", max: 64), .value(8))
        XCTAssertEqual(AMForm.count("0", max: 64), .invalid)
        XCTAssertEqual(AMForm.count("65", max: 64), .invalid)
        XCTAssertEqual(AMForm.count("two", max: 64), .invalid)
        XCTAssertEqual(AMForm.positive("24", max: 100), 24)
        XCTAssertEqual(AMForm.positive("1,5", max: 100), 1.5)
        XCTAssertNil(AMForm.positive("-1", max: 100))
    }

    func testAKeyIsNeverShownOnlyItsMaskedTail() {
        let secrets = [AMSecret(json: json(#"{"id":"provider-a","label":"A","kind":"api_key","masked":"••••3f9a","usedBy":[],"createdAt":1,"rotatedAt":null,"lastUsedAt":null}"#))]
        XCTAssertEqual(AMForm.keyHint("${secret:provider-a}", secrets: secrets), "••••3f9a")
        XCTAssertEqual(AMForm.keyHint("${secret:unknown}", secrets: secrets), "••••")
        XCTAssertEqual(AMForm.keyHint("${OPENAI_API_KEY}", secrets: secrets), "${OPENAI_API_KEY}")
        XCTAssertEqual(AMForm.keyHint("sk-live-abcdef", secrets: secrets), "••••", "a raw value is never echoed")
        XCTAssertNil(AMForm.keyHint(nil, secrets: secrets))
        XCTAssertNil(AMForm.keyHint("", secrets: secrets))
    }

    func testFormattersSayTheNumbersPlainly() {
        XCTAssertEqual(AMFormat.tokens(200_000), "200K")
        XCTAssertEqual(AMFormat.tokens(1_000_000), "1M")
        XCTAssertEqual(AMFormat.tokens(1_500_000), "1.5M")
        XCTAssertEqual(AMFormat.tokens(512), "512")
        XCTAssertEqual(AMFormat.plural(1, "model"), "1 model")
        XCTAssertEqual(AMFormat.plural(3, "model"), "3 models")
        XCTAssertEqual(AMFormat.duration(ms: 8), "8 ms")
        XCTAssertEqual(AMFormat.duration(ms: 1400), "1.4 s")
        XCTAssertEqual(AMFormat.bytes(715_000_000), "715 MB")
        XCTAssertEqual(AMFormat.bytes(2_100_000_000), "2.1 GB")
        XCTAssertEqual(AMFormat.address("http://localhost:11434/"), "localhost:11434")
        XCTAssertEqual(AMFormat.ago(nil), "Never")
    }

    // MARK: Providers

    func testANewProviderStartsFromItsTypeAndNeedsAKeyOnlyWhereHostedAPIsDo() {
        let ollama = AMProviderForm.new(.ollama, taken: [])
        XCTAssertEqual(ollama.baseURL, "http://localhost:11434")
        XCTAssertEqual(ollama.id, "ollama")
        XCTAssertTrue(ollama.errors(taken: [], editing: false, hasStoredKey: false).isEmpty, "a local server needs no key")
        let anthropic = AMProviderForm.new(.anthropic, taken: ["anthropic"])
        XCTAssertEqual(anthropic.id, "anthropic-2", "an id that is taken gets a number")
        XCTAssertEqual(anthropic.errors(taken: ["anthropic"], editing: false, hasStoredKey: false)[.apiKey], "Anthropic needs an API key.")
        var typed = anthropic
        typed.apiKey = " sk-ant-123 "
        XCTAssertNil(typed.errors(taken: [], editing: false, hasStoredKey: false)[.apiKey])
        XCTAssertEqual(typed.draft()["apiKey"], .string("sk-ant-123"), "the key is trimmed and sent")
    }

    func testEditingKeepsTheStoredKeyAndSendsNoneUnlessOneIsTyped() {
        let config = AMProvider(json: json(#"{"id":"openai","type":"openai","name":"OpenAI","baseUrl":"https://api.openai.com","apiKey":"${secret:provider-openai}","headers":{"X-Team":"a"},"enabled":true,"parallelRequests":4}"#))
        var form = AMProviderForm(config: config)
        XCTAssertTrue(form.errors(taken: ["openai"], editing: true, hasStoredKey: true).isEmpty)
        XCTAssertNotNil(form.errors(taken: ["openai"], editing: true, hasStoredKey: false)[.apiKey])
        let draft = form.draft()
        XCTAssertNil(draft["apiKey"], "nothing typed: the server keeps its key")
        XCTAssertEqual(draft["parallelRequests"], .number(4))
        XCTAssertEqual(draft["headers"]?["X-Team"], .string("a"))
        form.apiKey = "new"
        XCTAssertEqual(form.draft()["apiKey"], .string("new"))
    }

    func testAKeyFromTheEnvironmentIsImportedByName() {
        let found = AMDetected(json: json(#"{"type":"anthropic","baseUrl":"https://api.anthropic.com","label":"Anthropic","via":"env","envVar":"ANTHROPIC_API_KEY"}"#))!
        XCTAssertEqual(found.whereFound, "ANTHROPIC_API_KEY is set on the server")
        let form = AMProviderForm.detected(found, taken: [])
        XCTAssertTrue(form.errors(taken: [], editing: false, hasStoredKey: false).isEmpty)
        XCTAssertEqual(form.draft()["apiKeyFromEnv"], .string("ANTHROPIC_API_KEY"))
        XCTAssertNil(form.draft()["apiKey"])
        let port = AMDetected(json: json(#"{"type":"ollama","baseUrl":"http://localhost:11434","label":"Ollama","via":"port"}"#))!
        XCTAssertEqual(port.whereFound, "Running at localhost:11434")
    }

    func testTheFormChecksEachFieldWithWordsNotCodes() {
        var form = AMProviderForm.new(.openaiCompatible, taken: [])
        form.name = " "
        form.baseURL = "localhost:1234"
        form.id = "Bad Id"
        form.parallelRequests = "100"
        form.modelsAtOnce = "x"
        form.vramGB = "-3"
        form.headers = [.init(name: "bad name", value: "v")]
        let errors = form.errors(taken: [], editing: false, hasStoredKey: false)
        XCTAssertEqual(errors[.name], "Enter a name.")
        XCTAssertEqual(errors[.baseURL], "Enter an address starting with http:// or https://.")
        XCTAssertNotNil(errors[.id])
        XCTAssertEqual(errors[.parallel], "Leave empty for automatic, or enter 1 to 64.")
        XCTAssertEqual(errors[.modelsAtOnce], "Leave empty for automatic, or enter 1 to 16.")
        XCTAssertNotNil(errors[.vram])
        XCTAssertEqual(errors[.headers], "A header needs a name without spaces.")
        form.headers = [.init(name: "X-A", value: "1"), .init(name: "x-a", value: "2")]
        XCTAssertEqual(form.errors(taken: [], editing: false, hasStoredKey: false)[.headers], "Each header can only be set once.")
    }

    func testTheIDFollowsTheNameUntilItIsEditedByHand() {
        var form = AMProviderForm.new(.ollama, taken: [])
        form.rename("Home GPU", taken: [])
        XCTAssertEqual(form.id, "home-gpu")
        form.id = "mine"; form.idEdited = true
        form.rename("Another name", taken: [])
        XCTAssertEqual(form.id, "mine")
    }

    func testMemoryBudgetIsSentInGiBFromGB() {
        var form = AMProviderForm.new(.ollama, taken: [])
        form.vramGB = "24"
        let sent = form.draft()["vramGiB"]?.doubleOrNil ?? 0
        XCTAssertEqual(sent, 24e9 / 1_073_741_824, accuracy: 0.0001)
        let config = AMProvider(json: json(#"{"id":"o","type":"ollama","name":"O","baseUrl":"http://x:1","headers":{},"enabled":true,"vramGiB":22.35}"#))
        XCTAssertEqual(AMProviderForm(config: config).vramGB, "24")
    }

    func testHostedServicesByNameAreOpenAICompatibleProviders() {
        let form = AMProviderForm.preset(AMTextPreset.all[0], taken: [])
        XCTAssertEqual(form.type, .openaiCompatible)
        XCTAssertTrue(form.needsKey)
        XCTAssertEqual(form.baseURL, "https://openrouter.ai/api/v1")
        XCTAssertNil(form.connectDraft()["apiKey"], "OpenRouter's connect makes its own key")
        let config = AMProvider(json: json(#"{"id":"or","type":"openai-compatible","name":"OpenRouter","baseUrl":"https://openrouter.ai/api/v1","headers":{},"enabled":true}"#))
        XCTAssertEqual(config.preset?.id, "openrouter")
    }

    func testHealthIsOneWordPerState() {
        func status(ok: Bool, warnings: [String] = [], checked: Double = 1) -> AMProviderStatus {
            AMProviderStatus(json: .obj(["providerId": "p", "ok": .bool(ok), "modelCount": 3, "warnings": .array(warnings.map { .string($0) }), "checkedAt": .number(checked)]))
        }
        XCTAssertEqual(AMHealth(enabled: false, status: status(ok: true)), .disabled)
        XCTAssertEqual(AMHealth(enabled: true, status: nil), .notChecked)
        XCTAssertEqual(AMHealth(enabled: true, status: status(ok: true, checked: 0)), .notChecked)
        XCTAssertEqual(AMHealth(enabled: true, status: status(ok: false)), .unreachable)
        XCTAssertEqual(AMHealth(enabled: true, status: status(ok: true, warnings: ["slow"])), .warnings)
        XCTAssertEqual(AMHealth(enabled: true, status: status(ok: true)), .connected)
        XCTAssertEqual(AMTestOutcome(status: status(ok: true)).summary, "Connected · 3 models")
        XCTAssertEqual(AMTestOutcome(status: status(ok: false)).summary, "Could not connect.")
    }

    func testChatGPTPlansAndLimitsReadPlainly() {
        XCTAssertEqual(AMChatGPT.planLabel("prolite"), "Pro 100")
        XCTAssertEqual(AMChatGPT.planLabel("pro"), "Pro 200")
        XCTAssertEqual(AMChatGPT.planLabel("pro_max"), "Pro 500")
        XCTAssertEqual(AMChatGPT.planLabel("plus"), "Plus")
        let limits = AMChatGPT.limits(json(#"{"primary":{"usedPercent":18.4,"windowMinutes":300,"resetsAt":null},"secondary":{"usedPercent":61,"windowMinutes":10080,"resetsAt":null}}"#))
        XCTAssertEqual(limits.map(\.title), ["5-hour limit", "Weekly limit"])
        XCTAssertEqual(limits.map(\.value), ["18% used", "61% used"])
    }

    // MARK: Models

    private func model(_ text: String) -> AMModel { AMModel(json: json(text)) }

    func testAModelReadsItsAbilitiesAndSaysThemInWords() {
        let item = model(#"{"ref":"anthropic/opus","providerId":"anthropic","modelId":"opus","displayName":"Opus","contextLength":1000000,"maxOutput":64000,"capabilities":{"tools":"native","vision":true,"pdf":true,"reasoning":"effort","caching":true},"tier":"full","source":"catalog","hidden":false,"favorite":true,"order":1,"effortLevels":["low","high","xhigh"],"recommendedEffort":{"chat":"medium","work":"high","code":"high"}}"#)
        XCTAssertEqual(item.summary, "1M context, vision, reasoning")
        XCTAssertEqual(item.effortLevels, ["low", "high", "xhigh"])
        XCTAssertEqual(AMModelDetail.effortName("xhigh"), "Extra")
        let local = model(#"{"ref":"ollama/x","providerId":"ollama","modelId":"x","displayName":"x","contextLength":8192,"maxOutput":2048,"capabilities":{"tools":"prompted","vision":false,"pdf":false,"reasoning":"none","caching":false},"tier":"compact","source":"default","hidden":true,"favorite":false,"order":1,"free":true,"manual":true}"#)
        XCTAssertEqual(local.summary, "8K context, prompted tools, free")
        XCTAssertTrue(local.manual)
        XCTAssertTrue(local.hidden)
    }

    func testRecalculateAllSaysHowManyModelsItCalculatedAndWhyTheOthersHaveNoNumber() {
        func sized(_ id: String, _ calculation: String?) -> AMModel {
            let extra = calculation.map { #","calculation":{"state":"\#($0)"}"# } ?? ""
            return model(#"{"ref":"gpu/\#(id)","providerId":"gpu","modelId":"\#(id)","displayName":"\#(id)","contextLength":8192,"maxOutput":2048,"capabilities":{"tools":"native","vision":false,"pdf":false,"reasoning":"none","caching":false},"tier":"compact","source":"detected","hidden":false,"favorite":false,"order":1\#(extra)}"#)
        }
        let mixed = [sized("a", "calculated"), sized("b", "too-large"), sized("c", "unsupported"), sized("d", "not-applicable")]
        XCTAssertEqual(AMModelsModel.calculationSummary(mixed, unreachable: 0), "Calculated 1 of 3 models. 1 doesn't fit the memory budget; 1 can't be sized.")
        XCTAssertEqual(AMModelsModel.calculationSummary([sized("a", "calculated")], unreachable: 2), "Calculated 1 of 1 models. 2 providers couldn't be reached, so their last calculation was kept.")
        XCTAssertTrue(AMModelsModel.calculationSummary([sized("a", nil)], unreachable: 0).hasPrefix("Nothing to calculate"), "no budget, or an older server: nothing is claimed")
        let gemma = model(#"{"ref":"gpu/g","providerId":"gpu","modelId":"g","displayName":"g","contextLength":32768,"maxOutput":2048,"capabilities":{"tools":"native","vision":false,"pdf":false,"reasoning":"none","caching":false},"tier":"compact","source":"detected","hidden":false,"favorite":false,"order":1,"calculation":{"state":"unsupported","detail":"No."},"contextUnsized":{"reason":"architecture","architecture":"mamba9"}}"#)
        XCTAssertEqual(gemma.calculationLabel, "mamba9 isn't supported")
        XCTAssertEqual(gemma.calculationDetail, "No.")
        XCTAssertNil(sized("z", nil).calculationLabel)
    }

    func testTheModelListFiltersBySearchScopeAndAbility() {
        let a = model(#"{"ref":"p/a","providerId":"p","modelId":"alpha","displayName":"Alpha","contextLength":1000,"maxOutput":1,"capabilities":{"tools":"native","vision":true,"pdf":false,"reasoning":"none","caching":false},"tier":"full","source":"detected","hidden":false,"favorite":true,"order":1}"#)
        let b = model(#"{"ref":"p/b","providerId":"p","modelId":"beta","displayName":"Beta","contextLength":1000,"maxOutput":1,"capabilities":{"tools":"none","vision":false,"pdf":false,"reasoning":"toggle","caching":false},"tier":"full","source":"detected","hidden":true,"favorite":false,"order":1,"free":true}"#)
        var filter = AMModelFilter()
        XCTAssertTrue(filter.matches(a, providerName: "P") && filter.matches(b, providerName: "P"))
        filter.scope = .hidden
        XCTAssertFalse(filter.matches(a, providerName: "P")); XCTAssertTrue(filter.matches(b, providerName: "P"))
        filter.scope = .all; filter.tools = true
        XCTAssertTrue(filter.matches(a, providerName: "P")); XCTAssertFalse(filter.matches(b, providerName: "P"))
        filter.tools = false; filter.free = true
        XCTAssertFalse(filter.matches(a, providerName: "P")); XCTAssertTrue(filter.matches(b, providerName: "P"))
        filter.free = false; filter.search = "ALP"
        XCTAssertTrue(filter.matches(a, providerName: "P")); XCTAssertFalse(filter.matches(b, providerName: "P"))
        filter.search = "provider-name"
        XCTAssertTrue(filter.matches(a, providerName: "Provider-Name"), "the provider's name is searched too")
        XCTAssertTrue(AMModelFilter(favoritesOnly: true).active)
    }

    func testTheOverrideFormWritesOnlyWhatChangedAndClearsWhatWasEmptied() {
        let stored = json(#"{"displayName":"Opus 5.5","contextLength":65536,"toolCalling":"prompted"}"#)
        var form = AMOverrideForm(overrides: stored)
        XCTAssertEqual(form.contextLength, "65536")
        XCTAssertEqual(form.toolCalling, "prompted")
        XCTAssertTrue(form.changes(from: stored).isEmpty, "nothing edited, nothing written")
        form.contextLength = "131072"
        form.toolCalling = "auto"
        form.temperature = "0.4"
        form.vision = "yes"
        let changes = form.changes(from: stored)
        XCTAssertEqual(changes.map(\.key), ["contextLength", "temperature", "toolCalling", "vision"])
        func change(_ key: String) -> JSON? { changes.first { $0.key == key }?.value ?? nil }
        XCTAssertEqual(change("contextLength"), .number(131072))
        XCTAssertNil(change("toolCalling"), "automatic removes the override")
        XCTAssertTrue(changes.contains { $0.key == "toolCalling" && $0.value == nil })
        XCTAssertEqual(change("vision"), .bool(true))
    }

    func testTheOverrideFormChecksNumbers() {
        var form = AMOverrideForm()
        form.contextLength = "0"; form.maxOutput = "abc"; form.temperature = "2.5"
        let errors = form.errors()
        XCTAssertEqual(errors[.context], "Enter a whole number of tokens.")
        XCTAssertEqual(errors[.output], "Enter a whole number of tokens.")
        XCTAssertEqual(errors[.temperature], "Enter a number from 0 to 2.")
        form.contextLength = "8192"; form.maxOutput = ""; form.temperature = "1,5"
        XCTAssertTrue(form.errors().isEmpty)
        XCTAssertEqual(form.values()["temperature"] ?? nil, .number(1.5))
    }

    // MARK: Secrets

    func testSecretsSayWhatUsesThemAndGetUniqueIDs() {
        let secret = AMSecret(json: json(#"{"id":"s","label":"S","kind":"api_key","masked":"••••1234","usedBy":["providers.anthropic.apiKey","mcpServers.github.headers.Authorization","capabilities.webSearch.apiKey","mcpServers.github.env.TOKEN"],"createdAt":1,"rotatedAt":null,"lastUsedAt":null}"#))
        XCTAssertEqual(secret.usedByLabels(providers: ["anthropic": "Anthropic"]), ["Provider Anthropic", "Connector github", "Web search"])
        XCTAssertEqual(secret.kindLabel, "API key")
        XCTAssertEqual(AMSecretsModel.newID(label: "Docs connector token", taken: []), "docs-connector-token")
        XCTAssertEqual(AMSecretsModel.newID(label: "Docs connector token", taken: ["docs-connector-token"]), "docs-connector-token-2")
        XCTAssertEqual(AMSecretsModel.newID(label: "???", taken: []), "secret")
    }

    // MARK: Capabilities

    func testSearchStatusIsSaidTheWayTheDesktopSaysIt() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        let nowMs = now.timeIntervalSince1970 * 1000
        func status(_ engines: String, mode: String = "auto") -> AMSearchStatus { AMSearchStatus(json: json(#"{"mode":"\#(mode)","engines":\#(engines)}"#)) }
        XCTAssertEqual(status("[]").summary(now: now), "Ready. Atelier picks an engine on the first search.")
        XCTAssertEqual(status(#"[{"id":"a","name":"DuckDuckGo","kind":"web","state":"ok"},{"id":"b","name":"Brave","kind":"web","state":"limited","retryAt":\#(nowMs + 150_000)}]"#).summary(now: now),
                       "Working. Answered by DuckDuckGo; Brave is catching its breath.")
        XCTAssertEqual(status(#"[{"id":"a","name":"DuckDuckGo","kind":"web","state":"limited","retryAt":\#(nowMs + 180_000)}]"#).summary(now: now),
                       "Search engines are limiting requests from this server. Atelier tries again in about 3 minutes.")
        XCTAssertEqual(status("[]", mode: "brave").summary(now: now), "Using the search service you set up. Atelier does not fall back to other engines.")
        XCTAssertEqual(status(#"[{"id":"n","name":"Bing News","kind":"news","state":"ok"},{"id":"g","name":"Google News","kind":"news","state":"unknown"}]"#).groupLines(now: now),
                       ["News: Bing News working, Google News not used yet."])
        XCTAssertEqual(AMSearchEngine.brave.secretID, "web-search-brave")
    }

    func testTheSpeechModelsDownloadIsReadAsProgressAndWords() {
        let downloading = AMSpeechModel(json: json(#"{"state":"downloading","received":214000000,"total":715000000}"#))!
        XCTAssertEqual(downloading.fraction, 214.0 / 715.0, accuracy: 0.001)
        XCTAssertEqual(downloading.detail, "Downloading: 214 MB of 715 MB.")
        XCTAssertEqual(AMSpeechModel(json: json(#"{"state":"missing","bytes":715000000}"#))!.detail, "Not downloaded yet (715 MB). The first dictation downloads it, or download it now.")
        XCTAssertEqual(AMSpeechModel(json: json(#"{"state":"failed","error":"No space left."}"#))!.detail, "The download failed: No space left.")
        XCTAssertEqual(AMSpeechModel(json: json(#"{"state":"failed","error":"The download was interrupted."}"#))!.detail, "The download was interrupted.")
        XCTAssertEqual(AMSpeechModel(json: json(#"{"state":"ready"}"#))!.detail, "Downloaded. It runs on the server, for everyone who dictates.")
        XCTAssertNil(AMSpeechModel(json: .null))
        let status = AMDictationStatus(json: json(#"{"enabled":true,"source":null,"sources":[{"id":"text:m:v","label":"Voxtral","provider":"Mistral","live":true}],"chosen":null,"builtin":{"state":"ready"}}"#))
        XCTAssertEqual(status.sources.first?.label, "Voxtral")
        XCTAssertEqual(status.builtin?.state, .ready)
    }

    // MARK: Media

    func testEveryMediaServiceIsAPresetWithAKeyRule() {
        XCTAssertEqual(AMMediaPreset.all.count, 60)
        XCTAssertEqual(AMMediaPreset.find("comfyui")?.key, AMMediaPreset.KeyNeed.none)
        XCTAssertEqual(AMMediaPreset.find("openai")?.key, .required)
        XCTAssertTrue(AMMediaPreset.find("comfyui")!.runsLocally)
        XCTAssertTrue(AMMediaPreset.find("openai")!.mayCostMoney)
        XCTAssertTrue(AMMediaPreset.find("azure")!.hasTypedModels)
        XCTAssertEqual(AMMediaPreset.of(preset: nil, type: "bfl").id, "bfl")
        XCTAssertEqual(Set(AMMediaPreset.all.map(\.id)).count, AMMediaPreset.all.count, "ids are unique")
    }

    func testAMediaFormNeedsTheKeyItsServiceNeedsAndSendsWhatWasEntered() {
        let openai = AMMediaPreset.find("openai")!
        var form = AMMediaForm.new(openai, taken: ["openai"])
        XCTAssertEqual(form.id, "openai-2")
        XCTAssertEqual(form.errors(taken: ["openai"], editing: false, hasStoredKey: false)[.apiKey], "OpenAI needs an API key.")
        form.keyFrom = "openai-text"
        XCTAssertTrue(form.errors(taken: [], editing: false, hasStoredKey: false).isEmpty, "copying a text provider's key is a key")
        XCTAssertEqual(form.draft()["apiKeyFromProvider"], .string("openai-text"))
        XCTAssertEqual(form.draft()["type"], .string("openai-images"))
        XCTAssertEqual(form.draft()["preset"], .string("openai"))
        let local = AMMediaForm.new(AMMediaPreset.find("comfyui")!, taken: [])
        XCTAssertTrue(local.errors(taken: [], editing: false, hasStoredKey: false).isEmpty)
        var azure = AMMediaForm.new(AMMediaPreset.find("azure")!, taken: [])
        azure.apiKey = "k"
        let errors = azure.errors(taken: [], editing: false, hasStoredKey: false)
        XCTAssertEqual(errors[.baseURL], "Put the name of your resource in place of YOUR-RESOURCE.")
        XCTAssertEqual(errors[.models], "Add at least one deployment.")
    }

    func testAServerFoundHereIsAddedFromItsPreset() {
        let found = AMDetectedMedia(json: json(#"{"preset":"kokoro","type":"openai-speech","baseUrl":"http://localhost:8880","label":"Kokoro-FastAPI"}"#))
        let draft = AMMediaForm.detectedDraft(found, taken: [])
        XCTAssertEqual(draft["id"], .string("kokoro-fastapi"))
        XCTAssertEqual(draft["type"], .string("openai-speech"))
        XCTAssertEqual(draft["baseUrl"], .string("http://localhost:8880"))
        XCTAssertNil(draft["apiKey"])
    }

    func testKeysAndGPUsCanBeSharedWithTextProviders() {
        func provider(_ text: String) -> AMProvider { AMProvider(json: json(text)) }
        let openai = provider(#"{"id":"openai","type":"openai","name":"OpenAI","baseUrl":"https://api.openai.com","apiKey":"${secret:provider-openai}","headers":{},"enabled":true}"#)
        let noKey = provider(#"{"id":"o2","type":"openai","name":"No key","baseUrl":"https://api.openai.com","headers":{},"enabled":true}"#)
        let ollama = provider(#"{"id":"ollama","type":"ollama","name":"Ollama","baseUrl":"http://127.0.0.1:11434","headers":{},"enabled":true}"#)
        XCTAssertEqual(AMMediaKeys.sources(for: AMMediaPreset.find("openai")!, providers: [openai, noKey, ollama]).map(\.id), ["openai"])
        XCTAssertTrue(AMMediaKeys.sources(for: AMMediaPreset.find("comfyui")!, providers: [openai]).isEmpty)
        let partners = AMMediaKeys.gpuPartners(baseURL: "http://localhost:8188", providers: [openai, ollama])
        XCTAssertEqual(partners.map(\.provider.id), ["ollama"], "hosted providers have no GPU to share")
        XCTAssertTrue(partners[0].sameHost)
    }

    func testAMediaModelReadsWhatItMakes() {
        let video = AMMediaModel(json: json(#"{"ref":"g/v","providerId":"g","modelId":"v","displayName":"V","source":"catalog","hidden":false,"favorite":false,"order":1,"capabilities":{"output":"video","family":"hosted","promptStyle":"natural","negativePrompt":false,"sizes":{"kind":"fixed","list":[{"width":1,"height":1}]},"maxCount":1,"edit":false,"mask":false,"maxReferences":0,"transparent":false,"seed":false,"previews":false,"tunable":false,"video":{"durations":{"kind":"list","seconds":[4,6,8]},"defaultSeconds":6,"fps":[24,30],"defaultFps":24,"resolutions":["720p"],"firstFrame":true,"lastFrame":false,"audio":"always"}}}"#))
        XCTAssertEqual(video.kind, .video)
        XCTAssertEqual(video.summary, "Video, 4 to 8 s, with sound, can start from a picture")
        XCTAssertEqual(video.resolutions, ["720p"])
        let speech = AMMediaModel(json: json(#"{"ref":"e/s","providerId":"e","modelId":"s","displayName":"S","source":"catalog","hidden":false,"favorite":false,"order":1,"capabilities":{"output":"audio","audio":{"kinds":["speech","music"],"voices":[{"id":"a","name":"A"},{"id":"b","name":"B"}],"maxSpeakers":2,"lyrics":true,"durations":{"kind":"range","min":3,"max":180}},"family":"hosted","promptStyle":"natural","negativePrompt":false,"sizes":{"kind":"fixed","list":[{"width":1,"height":1}]},"maxCount":1,"edit":false,"mask":false,"maxReferences":0,"transparent":false,"seed":false,"previews":false,"tunable":false}}"#))
        XCTAssertEqual(speech.summary, "Speech, Music, 2 voices, dialogue, lyrics, 3 s to 3 min")
        XCTAssertEqual(AMMediaDefault.speech.title, "Default speech model")
        XCTAssertTrue(AMMediaDefault.speech.fits(speech)); XCTAssertTrue(AMMediaDefault.music.fits(speech)); XCTAssertFalse(AMMediaDefault.sound.fits(speech)); XCTAssertFalse(AMMediaDefault.image.fits(speech))
    }

    func testTheMediaOverrideFormKeepsTuningVideoAndSoundApart() {
        var form = AMMediaOverrideForm()
        form.steps = "30"; form.guidance = "7,5"; form.sampler = "euler"; form.seconds = "6"; form.voice = "rachel"
        XCTAssertTrue(form.errors().isEmpty)
        let values = form.values()
        XCTAssertEqual(values["tuning"] ?? nil, .obj(["steps": 30, "guidance": 7.5, "sampler": "euler"]))
        XCTAssertEqual(values["video"] ?? nil, .obj(["seconds": 6]))
        XCTAssertEqual(values["audio"] ?? nil, .obj(["voice": "rachel"]))
        XCTAssertNil(values["displayName"] ?? nil)
        form.steps = "500"; form.fps = "0"; form.soundSeconds = "99999"
        XCTAssertEqual(Set(form.errors().keys), [.steps, .fps, .soundSeconds])
        let stored = json(#"{"tuning":{"steps":30},"description":"Posters"}"#)
        let edited = AMMediaOverrideForm(overrides: stored)
        XCTAssertTrue(edited.changes(from: stored).isEmpty)
        var cleared = edited; cleared.steps = ""; cleared.description = ""
        XCTAssertEqual(cleared.changes(from: stored).map(\.key), ["description", "tuning"])
    }

    func testTheLimitsAcceptWholeNumbersAndDollars() {
        let perReply = AMLimitSpec.images[0]
        XCTAssertEqual(perReply.parse("8"), .number(8))
        XCTAssertNil(perReply.parse("0")); XCTAssertNil(perReply.parse("101")); XCTAssertNil(perReply.parse("1.5")); XCTAssertNil(perReply.parse(""))
        XCTAssertEqual(perReply.problem, "Enter a whole number from 1 to 100.")
        let perDay = AMLimitSpec.images[1]
        XCTAssertEqual(perDay.parse("40"), .number(40))
        XCTAssertEqual(perDay.problem, "Enter a whole number, or leave it empty for no limit.")
        let spend = AMLimitSpec.images[2]
        XCTAssertEqual(spend.parse("2.50"), .number(2.5)); XCTAssertEqual(spend.parse("2,5"), .number(2.5)); XCTAssertNil(spend.parse("0")); XCTAssertNil(spend.parse("$3")); XCTAssertNil(spend.parse("1.2.3"))
        XCTAssertEqual(AMLimitSpec.videos[0].fallback, "2")
        XCTAssertEqual(AMLimitSpec.sounds[0].fallback, "6")
    }

    // MARK: Workflows

    func testAWorkflowListsTheInputsItCanFillAndWhatIsMapped() {
        let graph = json(#"{"10":{"class_type":"KSampler","inputs":{"seed":1,"steps":20,"model":["4",0]}},"6":{"class_type":"CLIPTextEncode","inputs":{"text":"a cat"},"_meta":{"title":"Positive"}},"9":{"class_type":"SaveImage","inputs":{"filename_prefix":"a","images":["8",0]}}}"#)
        let inputs = AMWorkflow.inputs(graph)
        XCTAssertEqual(inputs.map(\.value), ["6|text", "9|filename_prefix", "10|seed", "10|steps"], "by node number, links left out")
        XCTAssertEqual(inputs[0].label, "Positive #6 · text")
        var workflow = json(#"{"id":"w","name":"W","graph":{},"map":{"prompt":{"node":"6","input":"text"}}}"#).setting("graph", graph)
        let prompt = AMWorkflow.slots.first { $0.key == "prompt" }!
        XCTAssertEqual(AMWorkflow.chosen(workflow, slot: prompt), "6|text")
        XCTAssertEqual(AMWorkflow.options(workflow, slot: prompt, inputs: inputs).map(\.value), ["6|text", "9|filename_prefix"], "text inputs only")
        workflow = AMWorkflow.setting(workflow, slot: "seed", to: "10|seed")
        XCTAssertEqual(workflow["map"]["seed"]["input"].string, "seed")
        XCTAssertEqual(AMWorkflow.summary(workflow), "Prompt, Seed")
        workflow = AMWorkflow.setting(workflow, slot: "seed", to: nil)
        XCTAssertEqual(workflow["map"]["seed"], .null)
        XCTAssertFalse(AMWorkflow.savesSound(workflow))
        XCTAssertTrue(AMWorkflow.savesSound(json(#"{"graph":{"3":{"class_type":"SaveAudioMP3"}},"map":{"output":"3"}}"#)))
    }

    // MARK: The sign-in flows, with canned answers

    private func stubbed(_ answers: @escaping (String) throws -> JSON?) -> AppStore {
        let store = AppStore()
        store.rpc.stub = { method, _ in try answers(method) }
        return store
    }

    func testChatGPTSignInShowsTheCodeThenAddsTheProvider() async throws {
        var polls = 0
        var saved: [String: JSON] = [:]
        let store = AppStore()
        store.rpc.stub = { method, params in
            switch method {
            case "chatgpt.signIn": return ["url": "https://auth.openai.com/codex/device", "userCode": "ABCD-EFGH"]
            case "chatgpt.status":
                polls += 1
                return polls < 3 ? ["signedIn": false, "signingIn": true] : ["signedIn": true, "signingIn": false, "email": "me@example.com"]
            case "providers.save": saved = params; return ["id": "chatgpt"]
            default: return nil
            }
        }
        let flow = AMSignInFlow(kind: .chatgpt, store: store)
        flow.interval = .milliseconds(5)
        await flow.start()
        XCTAssertEqual(flow.phase, .waiting)
        XCTAssertEqual(flow.code, "ABCD-EFGH")
        XCTAssertEqual(flow.link?.host, "auth.openai.com")
        XCTAssertNil(flow.openNow, "with a code, the person opens the page themselves")
        await flow.watch()
        XCTAssertEqual(flow.phase, .done)
        XCTAssertEqual(flow.account, "me@example.com")
        XCTAssertEqual(saved["type"], .string("chatgpt"))
        XCTAssertEqual(saved["id"], .string("chatgpt"))
        XCTAssertEqual(polls, 3)
    }

    func testASignInWithNoCodeOpensItsOwnPage() async {
        let store = stubbed { $0 == "chatgpt.signIn" ? ["url": "https://auth.openai.com/oauth"] : nil }
        let flow = AMSignInFlow(kind: .chatgpt, store: store)
        await flow.start()
        XCTAssertNil(flow.code)
        XCTAssertEqual(flow.openNow?.absoluteString, "https://auth.openai.com/oauth")
    }

    func testCopilotShowsItsCodeAndSaysWhyASignInFailed() async {
        let store = stubbed { method in
            switch method {
            case "copilot.signIn": return ["userCode": "WDJB-MJHT", "verificationUri": "https://github.com/login/device", "expiresAt": .number((Date.now.timeIntervalSince1970 + 900) * 1000)]
            case "copilot.status": return ["signedIn": false, "signingIn": false, "error": "The code expired."]
            default: return nil
            }
        }
        let flow = AMSignInFlow(kind: .copilot, store: store)
        flow.interval = .milliseconds(5)
        await flow.start()
        XCTAssertEqual(flow.code, "WDJB-MJHT")
        XCTAssertNotNil(flow.expiresAt)
        await flow.watch()
        XCTAssertEqual(flow.phase, .failed("The code expired."))
    }

    func testCancellingASignInTellsTheServerOnce() async {
        var cancelled = 0
        let store = stubbed { method in
            switch method {
            case "copilot.signIn": return ["userCode": "X", "verificationUri": "https://github.com/login/device", "expiresAt": 0]
            case "copilot.cancel": cancelled += 1; return ["ok": true]
            default: return nil
            }
        }
        let flow = AMSignInFlow(kind: .copilot, store: store)
        await flow.start()
        await flow.cancel()
        await flow.cancel()
        XCTAssertEqual(flow.phase, .idle)
        XCTAssertEqual(cancelled, 1)
    }

    func testASignInThatCannotStartSaysWhy() async {
        let store = stubbed { _ in throw MobileError.message("Unknown method copilot.signIn") }
        let flow = AMSignInFlow(kind: .copilot, store: store)
        await flow.start()
        XCTAssertEqual(flow.phase, .failed("This server doesn't support this yet."))
    }

    func testOpenRouterConnectWaitsForTheBrowserThenReportsTheProvider() async {
        var polls = 0
        let store = stubbed { method in
            switch method {
            case "openrouter.connect": return ["url": "https://openrouter.ai/auth?x=1"]
            case "openrouter.status":
                polls += 1
                return polls < 2 ? ["connecting": true] : ["connecting": false, "provider": ["id": "openrouter", "name": "OpenRouter"]]
            default: return nil
            }
        }
        let flow = AMOpenRouterFlow(store: store)
        flow.interval = .milliseconds(5)
        await flow.connect(draft: ["id": "openrouter"])
        XCTAssertEqual(flow.phase, .waiting)
        XCTAssertEqual(flow.openNow?.host, "openrouter.ai")
        await flow.watch()
        XCTAssertEqual(flow.phase, .done("OpenRouter"))
    }

    func testOpenRouterReportsAFailedConnect() async {
        let store = stubbed { method in
            switch method {
            case "openrouter.connect": return ["url": "https://openrouter.ai/auth"]
            case "openrouter.status": return ["connecting": false, "error": "OpenRouter refused the connection."]
            default: return nil
            }
        }
        let flow = AMOpenRouterFlow(store: store)
        flow.interval = .milliseconds(5)
        await flow.connect(draft: [:])
        await flow.watch()
        XCTAssertEqual(flow.phase, .failed("OpenRouter refused the connection."))
    }

    // MARK: Settings and the demo

    func testASettingShowsAtOnceAndIsUndoneWhenTheServerRefuses() async throws {
        var refuse = false
        let store = stubbed { method in
            switch method {
            case "settings.get": return ["effective": ["capabilities": ["webFetch": true]]]
            case "settings.set": if refuse { throw MobileError.message("Only admins can do this.") }; return ["ok": true]
            default: return nil
            }
        }
        let settings = AMSettings(store: store)
        try await settings.load()
        XCTAssertEqual(settings.value(["capabilities", "webFetch"]), .bool(true))
        try await settings.set(["capabilities", "webFetch"], .bool(false))
        XCTAssertEqual(settings.value(["capabilities", "webFetch"]), .bool(false))
        refuse = true
        do { try await settings.set(["capabilities", "webFetch"], .bool(true)); XCTFail("must throw") } catch { XCTAssertEqual(error as? AMFailure, .forbidden) }
        XCTAssertEqual(settings.value(["capabilities", "webFetch"]), .bool(false), "the old value is back")
    }

    func testTheDemoAnswersEveryProcedureThePagesCall() throws {
        for method in ["settings.get", "providers.status", "providers.detect", "models.list", "secrets.list", "search.status", "dictation.status", "imageProviders.status", "imageModels.list", "imageProviders.detect"] {
            XCTAssertNotNil(try AdminModelsDemo.respond(method, [:]), method)
        }
        XCTAssertNil(try AdminModelsDemo.respond("sessions.list", [:]), "what isn't this area's is left to the others")
    }
}

// MARK: - Against a real server

/// Every procedure the admin pages call, with the exact parameters the app sends, against a throwaway server
/// (`scripts/live-server.mjs`). Set ATELIER_TEST_SERVER, ATELIER_TEST_USER and ATELIER_TEST_PASSWORD (an admin) to run it;
/// ATELIER_TEST_MEMBER_USER and ATELIER_TEST_MEMBER_PASSWORD (an ordinary user) add the "admins only" case.
@MainActor final class AdminModelsIntegrationTests: XCTestCase {
    private func ok(_ value: Bool, _ message: String = "", file: StaticString = #filePath, line: UInt = #line) { XCTAssertTrue(value, message, file: file, line: line) }
    private func same<T: Equatable>(_ value: T, _ expected: T, file: StaticString = #filePath, line: UInt = #line) { XCTAssertEqual(value, expected, file: file, line: line) }

    private func environment() throws -> (address: String, user: String, password: String) {
        let env = ProcessInfo.processInfo.environment
        guard let address = env["ATELIER_TEST_SERVER"], let user = env["ATELIER_TEST_USER"], let password = env["ATELIER_TEST_PASSWORD"] else {
            throw XCTSkip("Set a throwaway server and an admin to run the admin integration tests")
        }
        return (address, user, password)
    }

    /// The scripted model server the throwaway server starts, one port above its https front.
    private func modelURL(_ address: String) -> String {
        let port = URL(string: address)?.port ?? 17441
        return "http://127.0.0.1:\(port + 1)"
    }

    private func signIn() async throws -> (store: AppStore, api: AMAPI, address: String) {
        let (address, user, password) = try environment()
        let store = AppStore()
        store.address = address
        try await store.login(username: user, password: password)
        return (store, AMAPI(store: store), address)
    }

    func testProvidersEndToEnd() async throws {
        let (store, api, address) = try await signIn()
        let providers = AMProvidersModel(store: store)
        await providers.resource.reload()
        let first = try XCTUnwrap(providers.resource.value)
        XCTAssertTrue(first.providers.contains { $0.id == "demo" })
        XCTAssertEqual(first.statuses["demo"]?.ok, true)
        XCTAssertEqual(first.statuses["demo"]?.modelCount, 1)
        await providers.rescan()
        if case .failed(let message) = providers.scan { XCTFail("detect failed: \(message)") }

        // A provider tested, saved, switched off and on, and removed, with the drafts the form builds.
        var form = AMProviderForm.new(.openaiCompatible, taken: Set(first.providers.map(\.id)), name: "Probe model", baseURL: modelURL(address) + "/v1")
        XCTAssertTrue(form.errors(taken: Set(first.providers.map(\.id)), editing: false, hasStoredKey: false).isEmpty)
        let tested = try await api.call("providers.test", form.draft())
        let outcome = AMTestOutcome(status: AMProviderStatus(json: tested["status"]))
        XCTAssertTrue(outcome.ok, outcome.summary)
        XCTAssertEqual(outcome.summary.hasPrefix("Connected · 1 model"), true)
        form.baseURL = "http://127.0.0.1:9/v1"
        let down = AMTestOutcome(status: AMProviderStatus(json: try await api.call("providers.test", form.draft())["status"]))
        XCTAssertFalse(down.ok)
        XCTAssertFalse(down.summary.isEmpty)
        form.baseURL = modelURL(address) + "/v1"
        let saved = try await api.call("providers.save", form.draft())
        XCTAssertEqual(saved["id"].string, "probe-model")
        await providers.resource.reload()
        let probe = try XCTUnwrap(providers.resource.value?.providers.first { $0.id == "probe-model" })
        XCTAssertTrue(probe.enabled)
        XCTAssertEqual(probe.baseURL, modelURL(address) + "/v1")
        await providers.setEnabled(probe, false)
        XCTAssertEqual(providers.resource.value?.providers.first { $0.id == "probe-model" }?.enabled, false)
        await providers.setEnabled(probe, true)
        XCTAssertEqual(providers.resource.value?.providers.first { $0.id == "probe-model" }?.enabled, true)
        XCTAssertEqual(providers.resource.value?.statuses["probe-model"]?.ok, true)
        await providers.check("probe-model")
        XCTAssertTrue(store.models.contains { $0["ref"].string == "probe-model/demo-model" }, "chat's model picker follows")

        // A hosted provider without a key is refused with words, and with a key its secret is listed (masked) and protected.
        var hosted = AMProviderForm.new(.anthropic, taken: [], name: "Probe hosted", baseURL: modelURL(address))
        XCTAssertNotNil(hosted.errors(taken: [], editing: false, hasStoredKey: false)[.apiKey])
        do { _ = try await api.call("providers.save", hosted.draft()); XCTFail("a hosted provider needs its key") } catch { XCTAssertTrue(AMFailure.from(error).localizedDescription.contains("API key")) }
        hosted.apiKey = "sk-probe-1234567890"
        _ = try await api.call("providers.save", hosted.draft())
        let secrets = AMSecretsModel(store: store)
        await secrets.resource.reload()
        let secret = try XCTUnwrap(secrets.resource.value?.secrets.first { $0.id == "provider-probe-hosted" })
        XCTAssertEqual(secret.masked, "••••7890")
        XCTAssertFalse(secret.masked.contains("sk-probe"))
        XCTAssertEqual(secret.usedByLabels(providers: secrets.resource.value?.providerNames ?? [:]), ["Provider Probe hosted"])
        do { try await secrets.delete(secret.id); XCTFail("a secret in use can't be deleted") } catch { XCTAssertTrue(AMFailure.from(error).localizedDescription.contains("still referenced")) }
        await providers.resource.reload()
        let hostedConfig = try XCTUnwrap(providers.resource.value?.providers.first { $0.id == "probe-hosted" })
        XCTAssertEqual(AMForm.keyHint(hostedConfig.apiKey, secrets: providers.resource.value?.secrets ?? []), "••••7890")
        ok(await providers.remove(hostedConfig))
        ok(await providers.remove(probe))
        XCTAssertEqual(providers.resource.value?.providers.contains { $0.id == "probe-model" || $0.id == "probe-hosted" }, false)
        await secrets.resource.reload()
        XCTAssertEqual(secrets.resource.value?.secrets.contains { $0.id == "provider-probe-hosted" }, false, "removing a provider deletes its key")

        // The sign-in procedures answer with the shapes the flows read, and can be cancelled.
        let chatgpt = AMSignInFlow(kind: .chatgpt, store: store)
        await chatgpt.start()
        if case .failed(let message) = chatgpt.phase { XCTFail("chatgpt.signIn failed: \(message)") }
        XCTAssertEqual(chatgpt.phase, .waiting)
        XCTAssertNotNil(chatgpt.link)
        await chatgpt.cancel()
        same(try await api.call("chatgpt.status")["signingIn"].bool, false)
        let copilot = AMSignInFlow(kind: .copilot, store: store)
        await copilot.start()
        XCTAssertEqual(copilot.phase, .waiting)
        XCTAssertNotNil(copilot.code)
        XCTAssertNotNil(copilot.expiresAt)
        await copilot.cancel()
        same(try await api.call("copilot.status")["signingIn"].bool, false)
        let openrouter = AMOpenRouterFlow(store: store)
        await openrouter.connect(draft: AMProviderForm.preset(AMTextPreset.all[0], taken: []).connectDraft())
        XCTAssertEqual(openrouter.phase, .waiting)
        XCTAssertEqual(openrouter.openNow?.host, "openrouter.ai")
        await openrouter.cancel()
        same(try await api.call("openrouter.status")["connecting"].bool, false)
        let usage = try await api.call("providers.planUsage", ["id": "demo"])
        XCTAssertEqual(usage, .null, "planUsage answers null where a provider has no allowance")
        try await store.logout()
    }

    func testModelsEndToEnd() async throws {
        let (store, api, address) = try await signIn()
        let models = AMModelsModel(store: store)
        await models.resource.reload()
        let list = try XCTUnwrap(models.resource.value)
        let ref = "demo/demo-model"
        XCTAssertTrue(list.models.contains { $0.ref == ref })
        XCTAssertEqual(list.providerNames["demo"], "Demo model")

        await models.setFlag(ref, key: "favorite", on: true)
        await models.resource.reload()
        XCTAssertEqual(models.model(ref)?.favorite, true)
        await models.setFlag(ref, key: "hidden", on: true)
        await models.resource.reload()
        XCTAssertEqual(models.model(ref)?.hidden, true)
        await models.setFlag(ref, key: "hidden", on: false)
        await models.setFlag(ref, key: "favorite", on: false)

        var form = AMOverrideForm(overrides: models.overrides(ref))
        form.displayName = "Probe name"; form.contextLength = "16384"; form.maxOutput = "2048"; form.temperature = "0.3"; form.vision = "yes"; form.promptTier = "compact"
        XCTAssertTrue(form.errors().isEmpty)
        ok(await models.save(ref, form: form))
        XCTAssertEqual(models.model(ref)?.displayName, "Probe name")
        XCTAssertEqual(models.model(ref)?.contextLength, 16384)
        XCTAssertEqual(models.model(ref)?.maxOutput, 2048)
        XCTAssertEqual(models.model(ref)?.vision, true)
        XCTAssertEqual(models.overrides(ref)["temperature"].doubleOrNil, 0.3)

        let probe = try await models.probe(ref)
        XCTAssertFalse(probe.detail.isEmpty)
        XCTAssertFalse(probe.native, "the scripted model has no native tool calls")

        // Defaults and aliases point at a model, and go back to unset.
        ok(await models.setChoice(["models", "defaults", "chat"], ref: ref))
        XCTAssertEqual(models.choice(["models", "defaults", "chat"]).model?.ref, ref)
        ok(await models.setChoice(["models", "aliases", "opus"], ref: ref))
        ok(await models.setChoice(["models", "aliases", "opus"], ref: nil))
        ok(await models.setChoice(["models", "defaults", "chat"], ref: nil))
        XCTAssertNil(models.choice(["models", "defaults", "chat"]).ref)

        // A model added by its name, and removed again.
        ok(await models.addManual(providerID: "demo", modelID: "extra-model"))
        XCTAssertEqual(models.model("demo/extra-model")?.manual, true)
        ok(await models.resetOverrides("demo/extra-model"))
        XCTAssertNil(models.model("demo/extra-model"))

        let message = await models.calculateAll()
        XCTAssertNotNil(message)
        ok(await models.resetOverrides(ref))
        XCTAssertEqual(models.model(ref)?.displayName, "demo-model")
        _ = address; _ = api
        try await store.logout()
    }

    func testSecretsEndToEnd() async throws {
        let (store, _, _) = try await signIn()
        let secrets = AMSecretsModel(store: store)
        await secrets.resource.reload()
        let id = AMSecretsModel.newID(label: "Probe token", taken: Set(secrets.resource.value?.secrets.map(\.id) ?? []))
        try await secrets.save(id: id, label: "Probe token", kind: "token", value: "supersecretvalue-4321")
        let stored = try XCTUnwrap(secrets.resource.value?.secrets.first { $0.id == id })
        XCTAssertEqual(stored.masked, "••••4321")
        XCTAssertFalse(stored.masked.contains("supersecret"), "the value never comes back")
        XCTAssertEqual(stored.kind, "token")
        XCTAssertNil(stored.rotatedAt)
        XCTAssertTrue(stored.usedBy.isEmpty)
        try await secrets.save(id: id, label: "Probe token", kind: "token", value: "another-value-9876")
        let rotated = try XCTUnwrap(secrets.resource.value?.secrets.first { $0.id == id })
        XCTAssertEqual(rotated.masked, "••••9876")
        XCTAssertNotNil(rotated.rotatedAt)
        try await secrets.delete(id)
        XCTAssertEqual(secrets.resource.value?.secrets.contains { $0.id == id }, false)
        try await store.logout()
    }

    func testCapabilitiesEndToEnd() async throws {
        let (store, api, _) = try await signIn()
        let caps = AMCapabilitiesModel(store: store)
        await caps.resource.reload()
        let snapshot = try XCTUnwrap(caps.resource.value)
        XCTAssertNotNil(snapshot.search, "search.status")
        XCTAssertFalse(snapshot.search?.engines.isEmpty ?? true)
        XCTAssertNotNil(snapshot.dictation, "dictation.status")
        XCTAssertEqual(snapshot.dictation?.enabled, true)
        XCTAssertNotNil(snapshot.dictation?.builtin)

        // Switches, read back from the server itself.
        func server(_ path: [JSON]) async throws -> JSON { try await api.call("settings.get")["effective"].at(path) }
        try await caps.settings.set(["capabilities", "webSearch", "enabled"], false)
        let off = try await server(["capabilities", "webSearch", "enabled"])
        XCTAssertEqual(off, .bool(false))
        try await caps.settings.reset(["capabilities", "webSearch", "enabled"])
        let on = try await server(["capabilities", "webSearch", "enabled"])
        XCTAssertEqual(on, .bool(true))
        try await caps.settings.set(["capabilities", "webSearch", "provider"], "searxng")
        try await caps.saveSearxngURL("http://127.0.0.1:1")
        let url = try await server(["capabilities", "webSearch", "url"])
        XCTAssertEqual(url, .string("http://127.0.0.1:1"))
        try await caps.saveSearxngURL("")
        let cleared = try await server(["capabilities", "webSearch", "url"])
        XCTAssertEqual(cleared, .null)
        try await caps.settings.set(["capabilities", "webSearch", "provider"], "brave")
        try await caps.saveSearchKey(.brave, value: "brave-key-5555")
        XCTAssertEqual(caps.keyHint(for: .brave), "••••5555")
        let reference = try await server(["capabilities", "webSearch", "apiKey"])
        XCTAssertEqual(reference, .string("${secret:web-search-brave}"), "settings hold a reference, never the key")
        try await caps.settings.reset(["capabilities", "webSearch", "apiKey"])
        try await caps.settings.reset(["capabilities", "webSearch", "provider"])
        _ = try await api.call("secrets.delete", ["id": "web-search-brave"])
        await caps.testSearch()
        switch caps.searchTest { case .done, .failed: break; default: XCTFail("the test must end") }
        XCTAssertNotNil(snapshot.search?.summary())

        try await caps.settings.set(["prompts", "organizationInstructions"], "Answer in British English.")
        let instructions = try await server(["prompts", "organizationInstructions"])
        XCTAssertEqual(instructions, .string("Answer in British English."))
        try await caps.settings.set(["prompts", "organizationInstructions"], "")
        try await caps.settings.set(["memory", "manualEditing"], true)
        try await caps.settings.reset(["memory", "manualEditing"])
        try await caps.settings.set(["safeguards", "enabled"], true)
        try await caps.settings.set(["safeguards", "categories", "selfHarm"], true)
        try await caps.settings.set(["safeguards", "profile"], "younger")
        try await caps.settings.set(["safeguards", "crisisResources"], "A helpline")
        let safeguards: [[JSON]] = [["safeguards", "enabled"], ["safeguards", "categories", "selfHarm"], ["safeguards", "profile"], ["safeguards", "crisisResources"]]
        for path in safeguards { try await caps.settings.reset(path) }
        let generation: [[JSON]] = [["imageGeneration", "enabled"], ["imageGeneration", "videoEnabled"], ["imageGeneration", "audioEnabled"]]
        for path in generation {
            try await caps.settings.set(path, false)
            try await caps.settings.reset(path)
        }

        await caps.setDictationSource("builtin")
        XCTAssertEqual(caps.resource.value?.dictation?.chosen, "builtin")
        await caps.setDictationSource(nil)
        XCTAssertNil(caps.resource.value?.dictation?.chosen)
        try await caps.settings.set(["dictation", "enabled"], false)
        await caps.refreshDictation()
        XCTAssertEqual(caps.resource.value?.dictation?.enabled, false)
        try await caps.settings.reset(["dictation", "enabled"])
        try await store.logout()
    }

    func testMediaEndToEnd() async throws {
        let (store, api, address) = try await signIn()
        let media = AMMediaPageModel(store: store)
        await media.resource.reload()
        XCTAssertNotNil(media.resource.value)
        await media.rescan()
        if case .failed(let message) = media.scan { XCTFail("imageProviders.detect failed: \(message)") }

        // An image server tested, saved, switched off and on, checked and removed.
        let preset = try XCTUnwrap(AMMediaPreset.find("localai"))
        let form = AMMediaForm.new(preset, taken: Set(media.resource.value?.textProviders.map(\.id) ?? []), name: "Probe images", baseURL: modelURL(address))
        XCTAssertTrue(form.errors(taken: [], editing: false, hasStoredKey: false).isEmpty)
        let tested = try await api.call("imageProviders.test", form.draft())
        XCTAssertTrue(AMProviderStatus(json: tested["status"]).ok)
        _ = try await api.call("imageProviders.save", form.draft())
        await media.resource.reload()
        var probe = try XCTUnwrap(media.resource.value?.providers.first { $0.id == "probe-images" })
        XCTAssertEqual(probe.preset.id, "localai")
        XCTAssertEqual(media.resource.value?.statuses["probe-images"]?.ok, true)
        await media.setEnabled(probe, false)
        XCTAssertEqual(media.resource.value?.providers.first { $0.id == "probe-images" }?.enabled, false)
        await media.setEnabled(probe, true)
        XCTAssertEqual(media.resource.value?.providers.first { $0.id == "probe-images" }?.enabled, true)
        await media.check("probe-images")

        // Making a test picture or sound fails with words, never a bare code.
        for method in ["imageProviders.tryImage", "imageProviders.trySound"] {
            do { _ = try await api.call(method, ["draft": .object(form.draft()), "modelId": "demo-model"]); XCTFail("the scripted server makes no pictures") }
            catch { XCTAssertFalse(AMFailure.from(error).localizedDescription.isEmpty); XCTAssertNotEqual(AMFailure.from(error).localizedDescription, "Internal error") }
        }

        // Model flags and defaults are settings under imageModels and models.defaults.
        _ = try await api.call("settings.set", ["layer": "global", "path": ["imageModels", "overrides", "probe-images/demo-model", "favorite"], "value": true])
        _ = try await api.call("imageModels.list")
        ok(await media.setDefault(.image, ref: "probe-images/demo-model"))
        XCTAssertEqual(media.defaultChoice(.image).ref, "probe-images/demo-model")
        ok(await media.setDefault(.image, ref: nil))
        var override = AMMediaOverrideForm()
        override.description = "Posters"; override.steps = "30"
        ok(await media.saveOverrides("probe-images/demo-model", form: override))
        XCTAssertEqual(media.overrides("probe-images/demo-model")["description"].string, "Posters")
        XCTAssertEqual(media.overrides("probe-images/demo-model")["tuning"]["steps"].int, 30)
        _ = try await api.call("settings.reset", ["layer": "global", "path": ["imageModels", "overrides", "probe-images/demo-model"]])

        // Limits are numbers under imageGeneration.
        let limit = AMLimitSpec.images[0]
        XCTAssertNotNil(limit.parse("5"))
        try await media.settings.set(["imageGeneration", "maxImagesPerTurn"], try XCTUnwrap(limit.parse("5")))
        let perTurn = try await api.call("settings.get")["effective"]["imageGeneration"]["maxImagesPerTurn"]
        XCTAssertEqual(perTurn, .number(5))
        try await media.settings.set(["imageGeneration", "maxImagesPerUserPerDay"], 40)
        try await media.settings.reset(["imageGeneration", "maxImagesPerUserPerDay"])
        try await media.settings.reset(["imageGeneration", "maxImagesPerTurn"])

        // A ComfyUI provider and a workflow, read on the server, mapped and saved.
        var comfy = AMMediaForm.new(try XCTUnwrap(AMMediaPreset.find("comfyui")), taken: [], name: "Probe comfy", baseURL: "http://127.0.0.1:9")
        comfy.parallelRequests = "2"
        _ = try await api.call("imageProviders.save", comfy.draft())
        await media.resource.reload()
        let comfyConfig = try XCTUnwrap(media.resource.value?.providers.first { $0.id == "probe-comfy" })
        XCTAssertTrue(comfyConfig.isComfy)
        XCTAssertEqual(comfyConfig.parallelRequests, 2)
        do { _ = try await api.call("imageProviders.parseWorkflow", ["text": "{nope", "providerId": "probe-comfy"]); XCTFail("not JSON") } catch { XCTAssertEqual(AMFailure.from(error).localizedDescription, "That isn't valid JSON.") }
        let graph = #"{"3":{"class_type":"KSampler","inputs":{"seed":1,"steps":20,"cfg":7,"sampler_name":"euler","scheduler":"normal","denoise":1,"model":["4",0],"positive":["6",0],"negative":["7",0],"latent_image":["5",0]}},"4":{"class_type":"CheckpointLoaderSimple","inputs":{"ckpt_name":"sd_xl_base_1.0.safetensors"}},"5":{"class_type":"EmptyLatentImage","inputs":{"width":1024,"height":1024,"batch_size":1}},"6":{"class_type":"CLIPTextEncode","inputs":{"text":"a cat","clip":["4",1]}},"7":{"class_type":"CLIPTextEncode","inputs":{"text":"blurry","clip":["4",1]}},"8":{"class_type":"VAEDecode","inputs":{"samples":["3",0],"vae":["4",2]}},"9":{"class_type":"SaveImage","inputs":{"filename_prefix":"a","images":["8",0]}}}"#
        let parsed = try await api.call("imageProviders.parseWorkflow", ["text": .string(graph), "providerId": "probe-comfy"])
        XCTAssertNotEqual(parsed["map"]["prompt"], .null, "the prompt input is found")
        XCTAssertFalse(AMWorkflow.summary(parsed).isEmpty)
        XCTAssertFalse(AMWorkflow.inputs(parsed["graph"]).isEmpty)
        try await media.saveWorkflows(comfyConfig, [AMWorkflow.setting(parsed, slot: "seed", to: nil)])
        XCTAssertEqual(media.resource.value?.providers.first { $0.id == "probe-comfy" }?.workflows.count, 1)
        XCTAssertEqual(media.resource.value?.providers.first { $0.id == "probe-comfy" }?.parallelRequests, 2, "saving workflows keeps the rest")
        do { _ = try await api.call("imageProviders.savedWorkflows", ["id": "probe-comfy"]) } catch { XCTAssertFalse(AMFailure.from(error).localizedDescription.isEmpty) }
        try await media.saveWorkflows(try XCTUnwrap(media.resource.value?.providers.first { $0.id == "probe-comfy" }), [])
        probe = try XCTUnwrap(media.resource.value?.providers.first { $0.id == "probe-images" })
        ok(await media.remove(probe))
        ok(await media.remove(try XCTUnwrap(media.resource.value?.providers.first { $0.id == "probe-comfy" })))
        XCTAssertEqual(media.resource.value?.providers.isEmpty, true)
        _ = try await api.call("imageModels.list")
        try await store.logout()
    }

    func testAnOrdinaryUserIsToldThePagesAreForAdmins() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let address = env["ATELIER_TEST_SERVER"], let user = env["ATELIER_TEST_MEMBER_USER"], let password = env["ATELIER_TEST_MEMBER_PASSWORD"] else {
            throw XCTSkip("Set an ordinary user to run the forbidden case")
        }
        let store = AppStore()
        store.address = address
        try await store.login(username: user, password: password)
        XCTAssertFalse(store.isAdmin)
        let providers = AMProvidersModel(store: store)
        await providers.resource.reload()
        guard case .failed(let message) = providers.resource.state else { return XCTFail("an ordinary user must not see providers") }
        XCTAssertEqual(message, AMFailure.forbidden.localizedDescription)
        let secrets = AMSecretsModel(store: store)
        await secrets.resource.reload()
        guard case .failed(let secretsMessage) = secrets.resource.state else { return XCTFail("nor secrets") }
        XCTAssertEqual(secretsMessage, AMFailure.forbidden.localizedDescription)
        let media = AMMediaPageModel(store: store)
        await media.resource.reload()
        guard case .failed = media.resource.state else { return XCTFail("nor media") }
        try await store.logout()
    }
}
