import XCTest
@testable import Atelier

/// The logic behind the personal settings pages: failures in words, preference writes, parsers and formatters.
@MainActor final class PersonalTests: XCTestCase {
    private func json(_ text: String) -> JSON { (try? JSONDecoder().decode(JSON.self, from: Data(text.utf8))) ?? .null }

    // MARK: Failures

    func testFailuresReadInWords() {
        XCTAssertEqual(PersonalFailure.text("Unknown method nope.nothing"), "This server doesn't support this yet.")
        XCTAssertEqual(PersonalFailure.text("newthing: not a preference"), "This server doesn't support this setting yet.")
        XCTAssertEqual(PersonalFailure.text("Invalid params"), "Check what you entered and try again.")
        XCTAssertEqual(PersonalFailure.text("Not connected. Your draft is kept; reconnect before sending."), "Not connected to your server. Try again once it is back.")
        XCTAssertEqual(PersonalFailure.text("The current password is wrong."), "The current password is wrong.")
        XCTAssertTrue(PersonalFailure.isUnsupported(MobileError.message("Unknown method memory.list")))
        XCTAssertTrue(PersonalFailure.isForbidden(MobileError.message("Only admins can do this.")))
        XCTAssertFalse(PersonalFailure.isForbidden(MobileError.message("Something else")))
    }

    // MARK: Preferences

    func testPathsReadAndWrite() {
        let prefs = json(#"{"dictation":{"language":"auto"},"callMe":""}"#)
        XCTAssertEqual(prefs.personalValue(at: ["dictation", "language"]), "auto")
        XCTAssertEqual(prefs.personalValue(at: ["nothing", "here"]), .null)
        let changed = prefs.personalSetting("de", at: ["dictation", "language"])
        XCTAssertEqual(changed.personalValue(at: ["dictation", "language"]), "de")
        XCTAssertEqual(changed.personalValue(at: ["callMe"]), "", "other keys are left alone")
        XCTAssertEqual(JSON.object([:]).personalSetting(true, at: ["a", "b", "c"]).personalValue(at: ["a", "b", "c"]), true, "missing objects are made on the way")
    }

    func testAWriteShowsAtOnceAndComesBackWhenTheServerRefuses() async {
        var toasts: [String] = []
        let prefs = PersonalPrefs(call: { method, _ in
            if method == "prefs.get" { return self.json(#"{"dictation":{"language":"auto","holdToRecord":true}}"#) }
            throw MobileError.message("dictation.language: not a preference")
        }, notify: { toasts.append($0) })
        await prefs.load()
        XCTAssertTrue(prefs.isLoaded)
        let kept = await prefs.set(["dictation", "language"], "de")
        XCTAssertFalse(kept)
        XCTAssertEqual(prefs.string(["dictation", "language"]), "auto", "the old value is back")
        XCTAssertEqual(toasts, ["Couldn't save. This server doesn't support this setting yet."])
    }

    func testAWriteTakesTheServersAnswer() async {
        var sent: [(String, [String: JSON])] = []
        let prefs = PersonalPrefs(call: { method, params in
            sent.append((method, params))
            if method == "prefs.get" { return self.json(#"{"notifications":{"taskFinished":true}}"#) }
            return self.json(#"{"notifications":{"taskFinished":false},"other":1}"#)
        }, notify: { _ in })
        await prefs.load()
        let kept = await prefs.set(["notifications", "taskFinished"], false)
        XCTAssertTrue(kept)
        XCTAssertEqual(sent.last?.0, "prefs.set")
        XCTAssertEqual(sent.last?.1["path"], ["notifications", "taskFinished"])
        XCTAssertEqual(sent.last?.1["value"], false)
        XCTAssertEqual(prefs.value(["other"]), .null, "only the written path is taken from the answer, so a write in flight is never undone")
        XCTAssertFalse(prefs.bool(["notifications", "taskFinished"], default: true))
        XCTAssertTrue(prefs.bool(["notifications", "missing"], default: true), "a missing key reads as its default")
    }

    func testAControlsChangeShowsInTheSameFrameAndSurvivesTheAnswer() async {
        let prefs = PersonalPrefs(call: { method, params in
            if method == "prefs.get" { return self.json(#"{"notifications":{"taskFinished":true}}"#) }
            return JSON.object([:]).personalSetting(params["value"] ?? .null, at: params["path"]?.array.map(\.string) ?? [])
        }, notify: { _ in })
        await prefs.load()
        prefs.change(["notifications", "taskFinished"], false)
        XCTAssertFalse(prefs.bool(["notifications", "taskFinished"], default: true), "no waiting for the server: a switch must not snap back")
        let binding = prefs.boolBinding(["notifications", "taskFinished"], default: true)
        XCTAssertFalse(binding.wrappedValue)
        for _ in 0..<20 { await Task.yield() }
        XCTAssertFalse(prefs.bool(["notifications", "taskFinished"], default: true))
    }

    func testTwoWritesInFlightAtOnceKeepEachOther() async {
        var releases: [CheckedContinuation<Void, Never>] = []
        let prefs = PersonalPrefs(call: { method, params in
            if method == "prefs.get" { return self.json("{}") }
            await withCheckedContinuation { releases.append($0) }
            // The server answers with its whole copy: only this write is in it, as when the other one has not arrived yet.
            return JSON.object([:]).personalSetting(params["value"] ?? .null, at: params["path"]?.array.map(\.string) ?? [])
        }, notify: { _ in })
        await prefs.load()
        async let first = prefs.set(["a"], 1)
        async let second = prefs.set(["b"], 2)
        while releases.count < 2 { await Task.yield() }
        XCTAssertEqual(prefs.value(["a"]), 1, "each shows at once")
        XCTAssertEqual(prefs.value(["b"]), 2)
        for release in releases { release.resume() }
        _ = await (first, second)
        XCTAssertEqual(prefs.value(["a"]), 1, "an answer that doesn't know the other write doesn't undo it")
        XCTAssertEqual(prefs.value(["b"]), 2)
    }

    func testALoadThatFailsSaysSo() async {
        let prefs = PersonalPrefs(call: { _, _ in throw MobileError.message("Not connected. Your draft is kept; reconnect before sending.") }, notify: { _ in })
        await prefs.load()
        XCTAssertEqual(prefs.phase, .failed("Not connected to your server. Try again once it is back."))
    }

    func testRetentionPicks() {
        XCTAssertEqual(PersonalRetention.pick(for: .null), "forever")
        XCTAssertEqual(PersonalRetention.pick(for: 90), "90")
        XCTAssertEqual(PersonalRetention.value(for: "forever"), .null)
        XCTAssertEqual(PersonalRetention.value(for: "365"), 365)
        XCTAssertEqual(PersonalRetention.options(including: "45").last?.1, "45 days", "a period set some other way is still listed")
        XCTAssertEqual(PersonalRetention.options(including: "30").count, 4)
    }

    // MARK: Models and languages

    func testModelOptionsGroupByProviderAndSkipHiddenOnes() {
        let models = [
            json(#"{"ref":"anthropic/opus","providerId":"anthropic","displayName":"Opus 5.5","hidden":false}"#),
            json(#"{"ref":"anthropic/old","providerId":"anthropic","displayName":"Old","hidden":true}"#),
            json(#"{"ref":"u-abc/qwen","providerId":"u-abc","displayName":"qwen3","hidden":false,"personal":{"deviceId":"d1","deviceName":"MacBook"},"available":false}"#),
            json(#"{"ref":"anthropic/sonnet","providerId":"anthropic","displayName":"Sonnet 5.5","hidden":false}"#),
        ]
        let options = PersonalModelOption.options(from: models, providerNames: ["anthropic": "Anthropic"])
        XCTAssertEqual(options.map(\.name), ["Opus 5.5", "qwen3", "Sonnet 5.5"])
        XCTAssertEqual(options[1].provider, "MacBook", "a personal model is named for its computer")
        XCTAssertFalse(options[1].available)
        let groups = PersonalModelOption.grouped(options)
        XCTAssertEqual(groups.map(\.provider), ["Anthropic", "MacBook"])
        XCTAssertEqual(groups[0].models.count, 2)
    }

    func testLanguagesAreFoundInTheirOwnNameOrEnglish() {
        XCTAssertEqual(PersonalLanguage.matching("deutsch").map(\.code), ["de"])
        XCTAssertEqual(PersonalLanguage.matching("Jap").map(\.code), ["ja"])
        XCTAssertEqual(PersonalLanguage.matching("").count, PersonalLanguage.all.count)
        XCTAssertEqual(PersonalLanguage.label(for: "auto"), "Auto")
        XCTAssertEqual(PersonalLanguage.label(for: "fr"), "French")
        XCTAssertEqual(PersonalLanguage.all.count, 48)
    }

    // MARK: Shortcuts

    func testBindingsBecomeKeyCapsInTheMacsOrder() {
        XCTAssertEqual(PersonalShortcuts.keys(for: "Mod+Shift+N"), ["⇧", "⌘", "N"])
        XCTAssertEqual(PersonalShortcuts.keys(for: "Mod+,"), ["⌘", ","])
        XCTAssertEqual(PersonalShortcuts.keys(for: "Ctrl+Alt+Shift+Mod+K"), ["⌃", "⌥", "⇧", "⌘", "K"])
        XCTAssertEqual(PersonalShortcuts.keys(for: "F1"), ["F1"])
        XCTAssertEqual(PersonalShortcuts.keys(for: "Mod+Shift+Space"), ["⇧", "⌘", "Space"])
        XCTAssertEqual(PersonalShortcuts.keys(for: "Mod+ArrowUp"), ["⌘", "↑"])
    }

    func testAChangedDesktopShortcutShowsAsChangedAndANullOneAsOff() {
        let changes = json(#"{"search":"Mod+Shift+K","report-issue":null}"#)
        let entries = PersonalShortcuts.entries(PersonalShortcuts.desktopApp, changes: changes)
        XCTAssertEqual(entries.first { $0.id == "search" }?.keys, ["⇧", "⌘", "K"])
        XCTAssertNil(entries.first { $0.id == "report-issue" }?.keys, "turned off")
        XCTAssertEqual(entries.first { $0.id == "new-chat" }?.keys, ["⌘", "N"], "the default stays")
        XCTAssertNotNil(PersonalShortcuts.entries(PersonalShortcuts.desktopApp, changes: .null).first { $0.id == "report-issue" }?.keys)
        XCTAssertEqual(PersonalShortcuts.thisApp.map(\.title), ["New conversation", "Settings", "Send the message", "New line in the message"])
    }

    // MARK: Account

    func testSessionsAreNamedForTheirApp() {
        let safari = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15"
        let edge = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/142.0 Safari/537.36 Edg/142.0"
        XCTAssertEqual(PersonalClientName.name(kind: "web", userAgent: safari), "Safari on macOS")
        XCTAssertEqual(PersonalClientName.name(kind: "web", userAgent: edge), "Edge on Windows")
        XCTAssertEqual(PersonalClientName.name(kind: "desktop", userAgent: "Atelier/0.10.1 Electron/41 darwin"), "Atelier Desktop on macOS")
        XCTAssertEqual(PersonalClientName.name(kind: "cli", userAgent: "atelier-cli/0.6.0 linux"), "Atelier CLI on Linux")
        XCTAssertEqual(PersonalClientName.name(kind: "mobile", userAgent: "Atelier Mobile iOS"), "Atelier for iPhone and iPad")
        XCTAssertEqual(PersonalClientName.name(kind: "web", userAgent: ""), "Browser")
        XCTAssertEqual(PersonalClientName.platform("win32"), "Windows")
        XCTAssertEqual(PersonalClientName.platform("plan9"), "plan9")
        XCTAssertEqual(PersonalClientName.symbol(kind: "cli", userAgent: ""), "terminal")
    }

    func testNewPasswordProblems() {
        XCTAssertEqual(PersonalPassword.problem(current: "", next: "longenough", confirm: "longenough", needsCurrent: true), "Enter your current password.")
        XCTAssertNil(PersonalPassword.problem(current: "", next: "longenough", confirm: "longenough", needsCurrent: false), "an account without a password has no current one")
        XCTAssertEqual(PersonalPassword.problem(current: "x", next: "short", confirm: "short", needsCurrent: true), "Use at least 8 characters.")
        XCTAssertEqual(PersonalPassword.problem(current: "x", next: "longenough", confirm: "different", needsCurrent: true), "The two passwords don't match.")
        XCTAssertNil(PersonalPassword.problem(current: "x", next: "longenough", confirm: "longenough", needsCurrent: true))
        XCTAssertEqual(PersonalPassword.problem(current: "x", next: String(repeating: "a", count: 257), confirm: String(repeating: "a", count: 257), needsCurrent: true), "Use at most 256 characters.")
    }

    func testTerminalCodesAreReadTheWayTheServerReadsThem() {
        XCTAssertEqual(PersonalTerminalCode.normalize("k7qf-3mzd"), "K7QF3MZD")
        XCTAssertEqual(PersonalTerminalCode.normalize(" K7QF 3MZD "), "K7QF3MZD")
        XCTAssertEqual(PersonalTerminalCode.normalize("K7QF-3MZO"), "K7QF3MZ0", "O reads as 0")
        XCTAssertEqual(PersonalTerminalCode.normalize("K7QL-3MZI"), "K7Q13MZ1", "I and L read as 1")
        XCTAssertNil(PersonalTerminalCode.normalize("K7QF-3MZ"))
        XCTAssertNil(PersonalTerminalCode.normalize("K7QU-3MZD"), "U is not in the alphabet")
        XCTAssertEqual(PersonalTerminalCode.display("K7QF3MZD"), "K7QF-3MZD")
        let now = Date(timeIntervalSince1970: 1000)
        XCTAssertEqual(PersonalTerminalCode.ago(now, now: now), "just now")
        XCTAssertEqual(PersonalTerminalCode.ago(now.addingTimeInterval(-30), now: now), "30 seconds ago")
        XCTAssertEqual(PersonalTerminalCode.ago(now.addingTimeInterval(-60), now: now), "a minute ago")
        XCTAssertEqual(PersonalTerminalCode.ago(now.addingTimeInterval(-300), now: now), "5 minutes ago")
    }

    func testPersonalityPicksAndProblems() {
        let value = json(#"{"selected":"custom:t1","customModes":[{"id":"t1","name":"Patient tutor","instructions":"Be patient."}]}"#)
        XCTAssertEqual(PersonalPersonality.name(of: value), "Patient tutor")
        XCTAssertEqual(PersonalPersonality.name(of: json(#"{"selected":"technical","customModes":[]}"#)), "Technical")
        XCTAssertEqual(PersonalPersonality.name(of: json(#"{"selected":"custom:gone","customModes":[]}"#)), "Atelier", "a mode that is gone falls back")
        XCTAssertEqual(PersonalPersonality.name(of: .null), "Atelier")
        XCTAssertEqual(PersonalPersonality.value(selected: "relaxed", modes: []), json(#"{"selected":"relaxed","customModes":[]}"#))
        XCTAssertEqual(PersonalPersonality.problem(name: " ", instructions: "x"), "Name the mode.")
        XCTAssertEqual(PersonalPersonality.problem(name: "Tutor", instructions: ""), "Describe the style.")
        XCTAssertNil(PersonalPersonality.problem(name: "Tutor", instructions: "Be patient."))
        XCTAssertNotNil(PersonalPersonality.problem(name: "Tutor", instructions: String(repeating: "x", count: 4_001)))
    }

    func testSafeguardsAreOnlyMentionedWhenTheyApply() {
        let settings = json(#"{"enabled":true,"categories":{"sexual":true,"hate":false,"harassment":true,"selfHarm":false},"profile":"younger"}"#)
        XCTAssertEqual(PersonalAccountModel.safeguardsText(settings: settings, override: "inherit"), "Covers explicit sexual content, harassment of private people, rules for younger people.")
        XCTAssertNil(PersonalAccountModel.safeguardsText(settings: settings, override: "off"))
        XCTAssertNotNil(PersonalAccountModel.safeguardsText(settings: json(#"{"enabled":false,"categories":{"hate":true},"profile":"adult"}"#), override: "on"))
        XCTAssertNil(PersonalAccountModel.safeguardsText(settings: json(#"{"enabled":true,"categories":{},"profile":"adult"}"#), override: "inherit"), "on with nothing covered")
    }

    // MARK: Memory

    func testMemoryFactsLoseTheirBullets() {
        XCTAssertEqual(PersonalMemoryText.lines("- Lives in Hamburg\n* Speaks German\n  3. Works in tech\n\n• Likes tea"), ["Lives in Hamburg", "Speaks German", "Works in tech", "Likes tea"])
        XCTAssertEqual(PersonalMemoryText.lines(""), [])
    }

    func testWhatMemoryDidIsSaidInWords() {
        let created = json(#"{"op":"created","id":"1","title":"Beans","section":"topic"}"#)
        let updated = json(#"{"op":"updated","id":"2","title":"Preferences","section":"preferences"}"#)
        let forgot = json(#"{"op":"deleted","id":"3","title":"Old job","section":"topic"}"#)
        XCTAssertEqual(PersonalMemoryText.describe([]), "Nothing to change")
        XCTAssertEqual(PersonalMemoryText.describe([updated]), "Updated Preferences")
        XCTAssertEqual(PersonalMemoryText.describe([created, updated, forgot]), "Saved Beans and 2 more")
        XCTAssertEqual(PersonalMemoryText.describe([forgot]), "Forgot Old job")
        XCTAssertEqual(PersonalMemoryText.describeImport([created, json(#"{"op":"created","id":"4","title":"Career","section":"profile"}"#), updated]), "Added 2 entries, updated Preferences")
        XCTAssertEqual(PersonalMemoryText.describeImport([created, json(#"{"op":"updated","id":"1","title":"Beans","section":"topic"}"#)]), "Added 1 entry", "an entry is counted once")
        XCTAssertEqual(PersonalMemoryText.describeImport([]), "Nothing in it could be added to memory")
        XCTAssertEqual(PersonalMemoryText.fixedSummary(section: "preferences", name: "Ada"), "How Ada wants Atelier to respond")
        XCTAssertEqual(PersonalMemoryText.fixedSummary(section: "profile", name: "Ada"), "Who Ada is")
    }

    func testALongExportIsCutAtItsHeadingsAndEachPartSaysWhereItCameFrom() {
        let text = "```\n## Career\n[2025-01-01] - Developer\n[2025-02-01] - Team lead\n\n## Interests\n[unknown] - Baking\n```"
        let parts = PersonalMemoryText.splitExport(text)
        XCTAssertEqual(parts.count, 1, "small sections share a part")
        XCTAssertTrue(parts[0].contains("## Career") && parts[0].contains("## Interests"))
        XCTAssertFalse(parts[0].contains("```"), "code fences go")
        let line = String(repeating: "x", count: 50)
        let big = "## Career\n" + (0..<40).map { _ in line }.joined(separator: "\n")
        let split = PersonalMemoryText.splitExport(big, max: 500)
        XCTAssertGreaterThan(split.count, 3)
        XCTAssertTrue(split.allSatisfy { $0.hasPrefix("## Career") }, "the heading is repeated in each part")
        XCTAssertTrue(split.allSatisfy { $0.count <= 500 })
        XCTAssertEqual(PersonalMemoryText.splitExport("   \n"), [])
    }

    func testTheImportPromptIsTheDesktops() {
        XCTAssertTrue(PersonalMemoryText.importPrompt.hasPrefix("I'm moving to another assistant"))
        XCTAssertTrue(PersonalMemoryText.importPrompt.contains("[YYYY-MM-DD] - Entry"))
    }

    func testMemoryInstructionsAndImportsGoToTheServerAsTheDesktopSendsThem() async throws {
        var sent: [(String, [String: JSON])] = []
        let model = PersonalMemoryModel(call: { method, params in
            sent.append((method, params))
            switch method {
            case "memory.list": return self.json(#"{"entries":[]}"#)
            case "settings.get": return self.json(#"{"effective":{"memory":{"manualEditing":true}}}"#)
            case "memory.instruct", "memory.import": return self.json(#"{"changes":[{"op":"created","id":"1","title":"Beans","section":"topic"}]}"#)
            default: return self.json(#"{"ok":true}"#)
            }
        })
        await model.load()
        XCTAssertTrue(model.manualEditing)
        let changes = try await model.instruct("Call me Sam", entryID: nil, section: "preferences", model: "demo/demo-model")
        XCTAssertEqual(changes.count, 1)
        let instruct = sent.first { $0.0 == "memory.instruct" }?.1
        XCTAssertEqual(instruct?["text"], "Call me Sam")
        XCTAssertEqual(instruct?["section"], "preferences")
        XCTAssertEqual(instruct?["model"], "demo/demo-model")
        XCTAssertNil(instruct?["entryId"])
        _ = try await model.instruct("He's five now", entryID: "e1", section: nil, model: nil)
        let second = sent.last { $0.0 == "memory.instruct" }?.1
        XCTAssertEqual(second?["entryId"], "e1")
        XCTAssertNil(second?["model"], "without a pick the server chooses")
        var steps: [String] = []
        let imported = try await model.importExport("## A\none\n\n## B\ntwo", model: nil) { part, total in steps.append("\(part)/\(total)") }
        XCTAssertEqual(imported.count, 1)
        XCTAssertEqual(steps, ["1/1"])
    }

    func testAnImportThatStopsSaysWhatWasAddedBeforeTheError() async {
        var calls = 0
        let model = PersonalMemoryModel(call: { method, _ in
            if method == "memory.import" {
                calls += 1
                if calls == 2 { throw MobileError.message("No model is available to update memory.") }
                return self.json(#"{"changes":[{"op":"created","id":"1","title":"A","section":"topic"}]}"#)
            }
            return self.json(#"{"entries":[]}"#)
        })
        let line = String(repeating: "x", count: 100)
        let big = "## One\n" + (0..<80).map { _ in line }.joined(separator: "\n")
        do {
            _ = try await model.importExport(big, model: nil) { _, _ in }
            XCTFail("the second part fails")
        } catch {
            XCTAssertEqual(error.localizedDescription, "No model is available to update memory. Before that: added 1 entry.")
        }
    }

    // MARK: Usage

    private func row(_ day: String, _ provider: String = "anthropic", _ model: String = "opus", mode: String = "chat", requests: Int = 1, input: Int = 100, output: Int = 20, cacheRead: Int = 0,
                     cost: Double? = 0.5, unpriced: Int = 0, extra: String = "") -> PersonalUsageRow {
        PersonalUsageRow(json(#"{"day":"\#(day)","providerId":"\#(provider)","modelId":"\#(model)","mode":"\#(mode)","requests":\#(requests),"input":\#(input),"output":\#(output),"cacheRead":\#(cacheRead),"cacheWrite":0,"reasoning":0,"costUsd":\#(cost.map { String($0) } ?? "null"),"unpriced":\#(unpriced),"tokensPerSecond":null,"timed":0\#(extra)}"#))
    }

    func testUsageTotalsKeepTokensAndMediaApart() {
        let rows = [row("2026-11-15", cacheRead: 30), row("2026-11-16", "ollama", "qwen3", mode: "code", cost: nil, unpriced: 1),
                    row("2026-11-16", "comfy", "flux", input: 0, output: 0, cost: nil, extra: #","images":4"#)]
        let t = PersonalUsage.totals(rows)
        XCTAssertEqual(t.requests, 2, "a picture is not a request to a text model")
        XCTAssertEqual(t.tokens, 100 + 30 + 20 + 100 + 20)
        XCTAssertEqual(t.images, 4)
        XCTAssertEqual(t.unpriced, 1)
        XCTAssertEqual(t.cost, 0.5, accuracy: 0.0001)
        XCTAssertEqual(PersonalUsage.totals([]), PersonalUsage.Totals())
    }

    func testTokensByDayFillsQuietDaysAndFoldsCoworkIntoChat() {
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = TimeZone(identifier: "UTC") ?? .current
        let now = calendar.date(from: DateComponents(year: 2026, month: 11, day: 17, hour: 12)) ?? .now
        let rows = [row("2026-11-17", mode: "work"), row("2026-11-17", mode: "chat"), row("2026-11-16", mode: "code"), row("2026-10-01", mode: "chat")]
        let days = PersonalUsage.tokensByDay(rows, days: 3, now: now, calendar: calendar)
        XCTAssertEqual(days.map(\.day), ["2026-11-15", "2026-11-16", "2026-11-17"], "oldest first")
        XCTAssertEqual(days[0].tokens[.chat], 0)
        XCTAssertEqual(days[1].tokens[.code], 120)
        XCTAssertEqual(days[2].tokens[.chat], 240, "Cowork counts as Chat")
        let shares = PersonalUsage.modeShares(rows)
        XCTAssertEqual(shares.first?.mode, .chat)
        XCTAssertEqual(shares.reduce(0) { $0 + $1.share }, 1, accuracy: 0.0001)
        XCTAssertTrue(PersonalUsage.modeShares([]).isEmpty)
    }

    func testModelsAndProvidersAreRankedByTokens() {
        let rows = [row("2026-11-15", "anthropic", "opus", input: 1000), row("2026-11-16", "anthropic", "sonnet", input: 5000), row("2026-11-16", "ollama", "qwen3", input: 100, cost: nil, unpriced: 2),
                    row("2026-11-17", "anthropic", "sonnet", input: 1000)]
        let models = PersonalUsage.byModel(rows)
        XCTAssertEqual(models.map(\.modelID), ["sonnet", "opus", "qwen3"])
        XCTAssertEqual(models[0].requests, 2)
        XCTAssertNil(models[2].cost, "no price: no cost, not zero")
        XCTAssertEqual(models[2].unpriced, 2)
        let providers = PersonalUsage.byProvider(rows)
        XCTAssertEqual(providers.map(\.providerID), ["anthropic", "ollama"])
        XCTAssertEqual(providers[0].cost ?? 0, 1.5, accuracy: 0.0001)
    }

    func testTheSpeedOfAModelIsAveragedOverTheRequestsThatReportedOne() {
        let fast = PersonalUsageRow(json(#"{"day":"d","providerId":"p","modelId":"m","mode":"chat","requests":3,"input":10,"output":1,"cacheRead":0,"cacheWrite":0,"costUsd":null,"unpriced":0,"tokensPerSecond":100,"timed":3}"#))
        let slow = PersonalUsageRow(json(#"{"day":"d2","providerId":"p","modelId":"m","mode":"chat","requests":1,"input":10,"output":1,"cacheRead":0,"cacheWrite":0,"costUsd":null,"unpriced":0,"tokensPerSecond":20,"timed":1}"#))
        XCTAssertEqual(PersonalUsage.byModel([fast, slow]).first?.tokensPerSecond ?? 0, 80, accuracy: 0.001)
    }

    func testImagesVideosAndSoundsAreCountedByTheirModel() {
        let rows = [row("d", "comfy", "flux", cost: nil, extra: #","images":3"#), row("d2", "comfy", "flux", cost: nil, extra: #","images":2"#),
                    row("d", "comfy", "wan", cost: 0.8, extra: #","videos":2,"videoSeconds":12,"estimatedUsd":0.8"#),
                    row("d", "eleven", "tts", cost: 0.1, extra: #","audios":3,"audioSeconds":95,"audioChars":1800"#)]
        XCTAssertEqual(PersonalUsage.byMedia(rows, .image).map(\.count), [5])
        XCTAssertNil(PersonalUsage.byMedia(rows, .image).first?.cost)
        XCTAssertEqual(PersonalUsage.byMedia(rows, .video).first?.seconds, 12)
        XCTAssertEqual(PersonalUsage.byMedia(rows, .video).first?.estimated, 0.8)
        XCTAssertEqual(PersonalUsage.byMedia(rows, .audio).first?.chars, 1800)
        XCTAssertTrue(PersonalUsage.byModel(rows).isEmpty, "none of them is a text model")
    }

    func testNumbersReadLikeTheDesktops() {
        XCTAssertEqual(PersonalUsage.tokens(980), "980")
        XCTAssertEqual(PersonalUsage.tokens(12_400), "12.4K")
        XCTAssertEqual(PersonalUsage.tokens(12_000), "12K")
        XCTAssertEqual(PersonalUsage.tokens(3_100_000), "3.1M")
        XCTAssertEqual(PersonalUsage.tokens(2_000_000_000), "2B")
        XCTAssertEqual(PersonalUsage.usd(0.42), "$0.42")
        XCTAssertEqual(PersonalUsage.usd(1280), "$1,280.00")
        XCTAssertEqual(PersonalUsage.usd(0.001), "<$0.01")
        XCTAssertEqual(PersonalUsage.usd(0), "$0.00")
        XCTAssertEqual(PersonalUsage.seconds(45), "45 s")
        XCTAssertEqual(PersonalUsage.seconds(125), "2 min 5 s")
        XCTAssertEqual(PersonalUsage.seconds(4200), "1 h 10 min")
        XCTAssertEqual(PersonalUsage.seconds(3600), "1 h")
        XCTAssertEqual(PersonalUsage.hour(0), "12 AM")
        XCTAssertEqual(PersonalUsage.hour(15), "3 PM")
        XCTAssertEqual(PersonalUsage.hour(12), "12 PM")
    }

    func testTheStatementSaysWhatWasUsed() {
        XCTAssertEqual(PersonalUsage.statement(PersonalUsage.Totals(), days: 30), "No usage in the last 30 days.")
        var t = PersonalUsage.Totals()
        t.requests = 12; t.tokens = 48_200; t.priced = 12; t.cost = 0.42
        XCTAssertEqual(PersonalUsage.statement(t, days: 30), "12 requests, 48.2K tokens, and $0.42 in the last 30 days.")
        t.estimated = 0.1; t.images = 1
        XCTAssertEqual(PersonalUsage.statement(t, days: 7), "12 requests, 48.2K tokens, 1 image, and about $0.42 in the last 7 days.")
        var one = PersonalUsage.Totals(); one.requests = 1; one.tokens = 10
        XCTAssertEqual(PersonalUsage.statement(one, days: 90), "1 request and 10 tokens in the last 90 days.")
    }

    func testLimitsReadLikeTheDesktops() {
        let soon = Date.now.timeIntervalSince1970 + 3600
        func limit(_ key: String, _ used: Double, _ max: Double, reached: Bool = false, near: Bool = false, resets: Double? = nil) -> PersonalUsage.Limit {
            PersonalUsage.Limit(json(#"{"key":"\#(key)","used":\#(used),"max":\#(max),"resetsAt":\#(resets.map { String(Int($0 * 1000)) } ?? "null"),"reached":\#(reached),"near":\#(near)}"#))
        }
        XCTAssertEqual(limit("tokensPerDay", 420_000, 1_000_000).amounts, "420K of 1M tokens")
        XCTAssertEqual(limit("costUsdPerDay", 2.4, 5).amounts, "$2.40 of $5.00")
        XCTAssertEqual(limit("requestsPerHour", 12, 30).amounts, "12 of 30 requests")
        XCTAssertEqual(limit("requestsPerHour", 1, 1).amounts, "1 of 1 request")
        XCTAssertEqual(limit("tokensPerDay", 500, 1000).percent, 50)
        XCTAssertEqual(limit("tokensPerDay", 2000, 1000).fraction, 1, "a bar never passes full")
        XCTAssertEqual(limit("requestsPerHour", 5, 30).label, "Requests per hour")
        XCTAssertEqual(PersonalUsage.limitNote(limit("requestsPerHour", 5, 30)), "Counts the last 60 minutes.")
        XCTAssertEqual(PersonalUsage.limitNote(limit("tokensPer30Days", 5, 30)), "Counts today and the 29 days before it.")
        XCTAssertTrue(PersonalUsage.limitNote(limit("tokensPerDay", 1000, 1000, reached: true, near: true)).hasPrefix("Limit reached. It lifts when your running requests finish."))
        XCTAssertTrue(PersonalUsage.limitNote(limit("tokensPerDay", 900, 1000, near: true, resets: soon)).hasPrefix("90% used. Resets at "))
        XCTAssertTrue(PersonalUsage.limitNote(limit("costUsdPerDay", 1, 5, resets: soon)).hasSuffix("(00:00 UTC)."))
    }

    func testTheHeatmapHasOneCellPerDayUpToToday() {
        var calendar = Calendar(identifier: .gregorian); calendar.firstWeekday = 2
        let now = calendar.date(from: DateComponents(year: 2026, month: 11, day: 17, hour: 12)) ?? .now // a Tuesday
        let cells = PersonalUsage.heatmap([json(#"{"day":"2026-11-17","sessions":1,"messages":7}"#), json(#"{"day":"2026-11-16","sessions":1,"messages":3}"#)], weeks: 26, now: now)
        XCTAssertEqual(cells.count, 25 * 7 + 2, "this week has Monday and Tuesday so far")
        XCTAssertEqual(cells.last?.weekday, 1)
        XCTAssertEqual(cells.last?.messages, 7)
        XCTAssertEqual(cells[cells.count - 2].messages, 3)
        XCTAssertEqual(cells.first?.week, 0)
        XCTAssertEqual(Set(cells.map(\.id)).count, cells.count)
    }

    func testPricesAreTypedAsPlainDecimalsAndKeepWhatThePageDoesNotEdit() {
        for good in ["3", "0.25", ".5", "3.", " 15 "] { XCTAssertTrue(PersonalPricing.valid(good, required: true), good) }
        for bad in ["-1", "1e3", "abc", "", "1,5", "$3"] { XCTAssertFalse(PersonalPricing.valid(bad, required: true), bad) }
        XCTAssertTrue(PersonalPricing.valid("", required: false), "the cache prices may be empty")
        XCTAssertEqual(PersonalPricing.problem(model: "", input: "1", output: "2", cacheRead: "", cacheWrite: ""), "Choose a model.")
        XCTAssertEqual(PersonalPricing.problem(model: "a/b", input: "", output: "2", cacheRead: "", cacheWrite: ""), PersonalPricing.message)
        XCTAssertEqual(PersonalPricing.problem(model: "a/b", input: "1", output: "2", cacheRead: "x", cacheWrite: ""), PersonalPricing.message)
        XCTAssertNil(PersonalPricing.problem(model: "a/b", input: "1", output: "2", cacheRead: "0.1", cacheWrite: ""))
        let stored = json(#"{"input":3,"output":15,"cacheWrite":3.75,"longContext":{"above":200000,"input":6,"output":22}}"#)
        let updated = PersonalPricing.json(input: "4", output: "16", cacheRead: "0.4", cacheWrite: "", keeping: stored)
        XCTAssertEqual(updated["input"], 4)
        XCTAssertEqual(updated["cacheRead"], 0.4)
        XCTAssertEqual(updated["cacheWrite"], .null, "emptied: counted as input again")
        XCTAssertEqual(updated["longContext"]["above"], 200000, "what the page doesn't edit is kept")
        let entries = PersonalPricing.entries(json(#"{"b/x":{"input":1,"output":2},"a/y":{"input":3,"output":4,"cacheRead":0.5},"c/z":{"input":"bad"}}"#))
        XCTAssertEqual(entries.map(\.ref), ["a/y", "b/x"], "in order, and a broken one is left out")
        XCTAssertEqual(entries.first?.price.cacheRead, 0.5)
        XCTAssertEqual(PersonalPricing.text(3), "3")
        XCTAssertEqual(PersonalPricing.text(0.25), "0.25")
        XCTAssertEqual(PersonalPricing.text(nil), "")
        XCTAssertEqual(PersonalPricing.display(nil), "as input")
        XCTAssertEqual(PersonalPricing.display(0.25), "$0.25")
    }

    // MARK: Your models

    func testHealthOfAServerOnSomeonesComputer() {
        XCTAssertEqual(PersonalHealth.of(json(#"{"enabled":false,"online":true}"#)), .off)
        XCTAssertEqual(PersonalHealth.of(json(#"{"enabled":true,"online":false}"#)), .notConnected)
        XCTAssertEqual(PersonalHealth.of(json(#"{"enabled":true,"online":true}"#)), .notChecked)
        XCTAssertEqual(PersonalHealth.of(json(#"{"enabled":true,"online":true,"status":{"ok":true}}"#)), .connected)
        XCTAssertEqual(PersonalHealth.of(json(#"{"enabled":true,"online":true,"status":{"ok":false}}"#)), .unreachable)
        XCTAssertEqual(PersonalHealth.connected.label, "Connected")
    }

    func testAServersRowAndDraft() {
        let provider = json(#"{"id":"u-abc1234567","type":"ollama","name":"Ollama","baseUrl":"http://localhost:11434","enabled":true,"deviceId":"d1","deviceName":"MacBook","online":true,"hasKey":false,"parallelRequests":2,"status":{"ok":true,"modelCount":6},"createdAt":1}"#)
        XCTAssertEqual(PersonalProviderText.meta(provider, kind: .text), "On MacBook · localhost:11434 · 6 models")
        XCTAssertEqual(PersonalProviderText.typeLabel(provider, kind: .text), "Ollama")
        XCTAssertEqual(PersonalProviderText.typeLabel(json(#"{"type":"comfyui","preset":"forge"}"#), kind: .image), "Forge")
        let draft = PersonalProviderText.draft(from: provider, kind: .text, changes: ["enabled": false, "parallelRequests": .null, "name": "Home"])
        XCTAssertEqual(draft["id"], "u-abc1234567")
        XCTAssertEqual(draft["name"], "Home")
        XCTAssertEqual(draft["enabled"], false)
        XCTAssertNil(draft["parallelRequests"], "automatic is no value")
        XCTAssertNil(draft["deviceId"], "only what the server takes back")
        XCTAssertNil(draft["status"])
        let offline = json(#"{"type":"chatgpt-chat","baseUrl":"https://chatgpt.com","enabled":true,"deviceName":"Studio","online":false}"#)
        XCTAssertEqual(PersonalProviderText.meta(offline, kind: .text), "On Studio · Not connected")
        let image = PersonalProviderText.draft(from: json(#"{"id":"u-img","type":"comfyui","preset":"comfyui","name":"C","baseUrl":"http://x","freeAfterRun":true,"deviceId":"d"}"#), kind: .image)
        XCTAssertEqual(image["freeAfterRun"], true)
        XCTAssertEqual(image["preset"], "comfyui")
    }

    // MARK: Help and reports

    func testReportTextHasTheDesktopsBar() {
        XCTAssertEqual(PersonalReportText.problem(.title, ""), "Give it a title.")
        XCTAssertEqual(PersonalReportText.problem(.description, "  "), "Describe it in a sentence or two.")
        XCTAssertEqual(PersonalReportText.problem(.title, "Chat broken"), nil)
        XCTAssertEqual(PersonalReportText.problem(.title, "Hi"), "Make the title a few words long.")
        XCTAssertEqual(PersonalReportText.problem(.title, "Chat broken AAAAAAAAAA"), "Leave out the repeated characters.")
        XCTAssertEqual(PersonalReportText.problem(.description, "It crashes"), "Say a little more: what happened, and what you expected.")
        XCTAssertNil(PersonalReportText.problem(.description, "The chat stops after I attach a PDF and nothing comes back."))
        XCTAssertEqual(PersonalReportText.problem(.description, "alpha alpha alpha alpha alpha alpha beta gamma"), "Say it in your own words rather than one word repeated.")
        XCTAssertEqual(PersonalReportText.problem(.title, String(repeating: "word ", count: 40)), "That's too long: at most 140 characters.")
        XCTAssertNil(PersonalReportText.problem(.title, "チャットが止まる"), "a title in a script without spaces is fine")
        XCTAssertEqual(PersonalReportText.problem(.description, "?????? !!!!!! ......"), "Say a little more: what happened, and what you expected.")
    }

    func testAnAttachedChatSaysHowMuchOfItGoes() {
        XCTAssertEqual(PersonalReportText.coverage(json(#"{"coverage":{"total":42,"included":42,"shortened":0}}"#)), "All 42 messages.")
        XCTAssertEqual(PersonalReportText.coverage(json(#"{"coverage":{"total":1,"included":1,"shortened":0}}"#)), "All 1 message.")
        XCTAssertEqual(PersonalReportText.coverage(json(#"{"coverage":{"total":100,"included":30,"shortened":2}}"#)), "30 of its 100 messages: how it started and the newest ones, some shortened to fit.")
        XCTAssertEqual(PersonalReportText.coverage(json(#"{"coverage":{"total":0,"included":0,"shortened":0}}"#)), "It has no messages yet.")
    }

    func testAReportGoesToTheServerAsTheContractWantsIt() async throws {
        let store = AppStore()
        store.info = json(#"{"version":"0.10.1","reports":true}"#)
        var submitted: [String: JSON] = [:]
        store.rpc.stub = { method, params in
            if method == "reports.prepare" { return self.json(#"{"diagnostics":{"collectedAt":1,"notes":{"a":"b"}},"chat":null}"#) }
            if method == "reports.submit" { submitted = params; return self.json(#"{"id":"I-7F3K2Q","receivedAt":1}"#) }
            return nil
        }
        let model = PersonalReportModel(store: store, kind: .issue)
        model.title = "Chat stops after attaching a PDF"
        model.description = "I attach a PDF and the answer never comes back at all."
        model.contact = " me@example.com "
        XCTAssertNil(model.unavailable)
        await model.prepare()
        XCTAssertNotNil(model.diagnosticsToSend, "an issue always carries diagnostics")
        XCTAssertNotNil(model.diagnosticsToSend?["client"]["os"]["name"].stringOrNil, "with this phone's half")
        await model.send(theme: "dark")
        XCTAssertEqual(model.receipt?.id, "I-7F3K2Q")
        XCTAssertEqual(submitted["kind"], "issue")
        XCTAssertEqual(submitted["contact"], "me@example.com")
        XCTAssertEqual(submitted["app"]?["surface"], "web")
        XCTAssertEqual(submitted["app"]?["mode"], "web")
        XCTAssertEqual(submitted["app"]?["theme"], "dark")
        XCTAssertEqual(submitted["app"]?["serverVersion"], "0.10.1")
        XCTAssertEqual(submitted["chat"], .null)
        XCTAssertEqual(submitted["screenshots"], [])
        XCTAssertEqual(model.title, "", "the draft is gone once it is sent")
    }

    func testReportsThatAnAdminTurnedOffAreNotSent() {
        let store = AppStore()
        store.info = json(#"{"version":"0.10.1","reports":false}"#)
        XCTAssertEqual(PersonalReportModel(store: store, kind: .issue).unavailable, "An admin turned off reports on this server.")
        store.info = json(#"{"version":"0.1.0"}"#)
        XCTAssertEqual(PersonalReportModel(store: store, kind: .feature).unavailable, "This server is too old to send reports. Ask its admin to update it.")
    }

    func testDiagnosticsNameNeitherTheServerNorThePerson() {
        let store = AppStore()
        store.address = "https://secret.example.com"
        store.userName = "Ada Lovelace"
        store.info = json(#"{"version":"0.10.1","surface":"web","imageGeneration":true,"reports":true}"#)
        let text = PersonalDiagnostics.text(store: store, now: Date(timeIntervalSince1970: 0))
        XCTAssertTrue(text.contains("Server: 0.10.1 (web)"))
        XCTAssertTrue(text.contains("image generation, reports"))
        XCTAssertFalse(text.contains("secret.example.com"))
        XCTAssertFalse(text.contains("Ada"))
    }

    func testPicturesAreMadeSmallEnoughToSend() throws {
        let format = UIGraphicsImageRendererFormat(); format.scale = 1
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 3000, height: 2000), format: format)
        let image = renderer.image { context in
            UIColor.systemTeal.setFill(); context.fill(CGRect(x: 0, y: 0, width: 3000, height: 2000))
            UIColor.white.setFill(); context.fill(CGRect(x: 100, y: 100, width: 800, height: 600))
        }
        let png = try XCTUnwrap(image.pngData())
        let picture = try XCTUnwrap(PersonalImages.jpeg(from: png, maxSide: 1024, maxBytes: 500_000))
        XCTAssertLessThanOrEqual(max(picture.width, picture.height), 1024)
        XCTAssertLessThanOrEqual(picture.data.count, 500_000)
        XCTAssertNotNil(UIImage(data: picture.data))
        XCTAssertNil(PersonalImages.jpeg(from: Data("not a picture".utf8), maxSide: 1024, maxBytes: 500_000))
    }

    // MARK: A finished list never shows raw JSON

    func testDemoAnswersMatchWhatTheScreensRead() throws {
        let prefs = try XCTUnwrap(try PersonalDemo.respond("prefs.get", [:]))
        XCTAssertEqual(prefs["dictation"]["language"], "de")
        let changed = try XCTUnwrap(try PersonalDemo.respond("prefs.set", ["path": ["dictation", "language"], "value": "fr"]))
        XCTAssertEqual(changed["dictation"]["language"], "fr")
        XCTAssertNil(try PersonalDemo.respond("sessions.list", [:]), "a method it doesn't know goes on to the next area")
    }
}

/// The same models and calls the screens use, against a throwaway server (scripts/live-server.mjs, scripts/personal/hold-desktop.mjs for the desktop it lends, scripts/personal/fake-collector.mjs for reports):
///   TEST_RUNNER_ATELIER_TEST_SERVER=https://127.0.0.1:17421 TEST_RUNNER_ATELIER_TEST_USER=demo TEST_RUNNER_ATELIER_TEST_PASSWORD=… xcodebuild test -only-testing:AtelierTests/PersonalIntegrationTests
@MainActor final class PersonalIntegrationTests: XCTestCase {
    func testThePersonalPagesTalkToARealServer() async throws {
        let environment = ProcessInfo.processInfo.environment
        guard let address = environment["ATELIER_TEST_SERVER"], let username = environment["ATELIER_TEST_USER"], let password = environment["ATELIER_TEST_PASSWORD"] else {
            throw XCTSkip("Set the throwaway server's address and an account to run the personal integration test")
        }
        let store = AppStore()
        store.address = address
        try await store.login(username: username, password: password)
        XCTAssertTrue(store.signedIn)
        var toasts: [String] = []
        let call = store.personalCall

        // General: preferences, each on its own path.
        let prefs = PersonalPrefs(call: call, notify: { toasts.append($0) })
        await prefs.load()
        XCTAssertTrue(prefs.isLoaded)
        let languageKept = await prefs.set(["dictation", "language"], "de")
        let holdKept = await prefs.set(["dictation", "holdToRecord"], false)
        let retentionKept = await prefs.set(["privacy", "historyRetentionDays"], 90)
        XCTAssertTrue(languageKept && holdKept && retentionKept)
        await prefs.load()
        XCTAssertEqual(prefs.string(["dictation", "language"]), "de")
        XCTAssertEqual(PersonalRetention.pick(for: prefs.value(["privacy", "historyRetentionDays"])), "90")
        let neverKept = await prefs.set(["somethingNew", "x"], 1)
        XCTAssertFalse(neverKept, "an older server's refusal")
        XCTAssertEqual(prefs.value(["somethingNew", "x"]), .null, "and the old value is back")
        XCTAssertEqual(toasts.last, "Couldn't save. This server doesn't support this setting yet.")
        let reset = await prefs.reset(["dictation", "language"])
        XCTAssertTrue(reset)
        XCTAssertEqual(prefs.string(["dictation", "language"]), "auto")
        _ = await prefs.set(["dictation", "holdToRecord"], true)
        _ = await prefs.reset(["privacy", "historyRetentionDays"])

        // Account.
        let account = PersonalAccountModel(call: call)
        await account.reloadAll()
        XCTAssertEqual(account.account.value?["username"].string, username)
        XCTAssertTrue(account.sessions.value?.contains { $0["current"].bool && $0["clientKind"].string == "mobile" } ?? false, "this device is marked")
        XCTAssertNotNil(account.devices.value)
        XCTAssertNotNil(account.passkeys.value)
        XCTAssertNotNil(account.identities.value)
        XCTAssertNotNil(account.safeguards.value)
        let original = account.account.value?["name"].string ?? ""
        try await account.update(name: "\(original) Test")
        XCTAssertEqual(account.account.value?["name"].string, "\(original) Test")
        try await account.update(name: original)
        let picture = try XCTUnwrap(PersonalImages.jpeg(from: UIGraphicsImageRenderer(size: CGSize(width: 64, height: 64)).pngData { $0.fill(CGRect(x: 0, y: 0, width: 64, height: 64)) }, maxSide: 1024, maxBytes: 5_000_000))
        try await account.uploadAvatar(picture)
        let sha = try XCTUnwrap(account.account.value?["avatar"].stringOrNil)
        let downloaded = try await PersonalBlob.load(store: store, sha: sha)
        XCTAssertEqual(downloaded, picture.data, "the photo comes back as it went")
        try await account.update(avatar: .null)
        XCTAssertNil(account.account.value?["avatar"].stringOrNil)
        let asked = try await store.rpc.call("auth.terminalStart", ["deviceName": "Probe terminal", "platform": "linux"])
        let request = try await store.rpc.call("auth.terminalRequest", ["code": asked["code"]])
        XCTAssertEqual(request["deviceName"].string, "Probe terminal")
        _ = try await store.rpc.call("auth.terminalDecide", ["code": request["code"], "approve": false])

        // Memory.
        let memory = PersonalMemoryModel(call: call)
        await memory.load()
        XCTAssertNotNil(memory.entries.value)
        // Editing by hand is the administrator's to allow (`settings.memory.manualEditing`).
        _ = try await store.rpc.call("settings.set", ["layer": "global", "path": ["memory", "manualEditing"], "value": true])
        await memory.load()
        XCTAssertTrue(memory.manualEditing)
        try await memory.update(id: nil, section: "preferences", title: nil, summary: nil, details: "- Keep lists short")
        let preferences = try XCTUnwrap(memory.entry(id: "preferences"))
        XCTAssertEqual(PersonalMemoryText.lines(preferences["details"].string), ["Keep lists short"])
        try await memory.delete(id: preferences["id"].string)
        _ = try await store.rpc.call("settings.set", ["layer": "global", "path": ["memory", "manualEditing"], "value": false])

        // Usage.
        let usage = PersonalUsageModel(call: call)
        await usage.loadUsage()
        XCTAssertEqual(usage.phase, .loaded)
        await usage.loadStats()
        XCTAssertNotNil(usage.stats)
        await usage.loadLimits()
        XCTAssertNotNil(usage.limits)
        await usage.loadNames(models: store.models, admin: store.isAdmin)
        usage.days = 7; usage.everyone = true
        await usage.loadUsage()
        XCTAssertEqual(usage.phase, .loaded)

        // Your models: what a stand-in desktop app lent (Tests/personal-live.mjs).
        let providers = PersonalProvidersModel(call: call, imageOffered: true)
        await providers.reload()
        let text = try XCTUnwrap(providers.providers.value)
        let first = try XCTUnwrap(text.first, "the stand-in desktop added a model server")
        XCTAssertEqual(PersonalHealth.of(first), .connected)
        try await providers.save(first, kind: .text, changes: ["enabled": false])
        XCTAssertEqual(PersonalHealth.of(try XCTUnwrap(providers.find(first["id"].string, kind: .text))), .off)
        try await providers.save(first, kind: .text, changes: ["enabled": true, "name": "Home Ollama", "parallelRequests": 2])
        XCTAssertEqual(providers.find(first["id"].string, kind: .text)?["name"].string, "Home Ollama")
        try await providers.check(first["id"].string, kind: .text)
        XCTAssertEqual(providers.find(first["id"].string, kind: .text)?["status"]["ok"].boolOrNil, true)
        let image = try XCTUnwrap(providers.images.value?.first)
        try await providers.save(image, kind: .image, changes: ["name": "Studio ComfyUI"])
        try await providers.check(image["id"].string, kind: .image)
        try await providers.remove(first["id"].string, kind: .text)
        try await providers.remove(image["id"].string, kind: .image)
        XCTAssertEqual(providers.providers.value?.count, 0)

        // Privacy: the export downloads as a zip.
        let made = try await store.rpc.call("privacy.export")
        let file = try await PersonalBlob.download(store: store, sha: made["sha256"].string, fileName: made["name"].string)
        XCTAssertEqual(try Data(contentsOf: file).prefix(2), Data("PK".utf8))
        try? FileManager.default.removeItem(at: file.deletingLastPathComponent())

        // Help: a report, through the stand-in collector.
        store.info = try await store.rpc.call("app.info")
        let report = PersonalReportModel(store: store, kind: .issue)
        report.title = "Chat stops after attaching a PDF"
        report.description = "I attach a PDF and the answer never comes back at all."
        if let problem = report.addPictures([picture.data]) { XCTFail(problem) }
        await report.prepare()
        XCTAssertNotNil(report.diagnosticsToSend)
        await report.send(theme: "light")
        XCTAssertNotNil(report.receipt, report.failure ?? "no receipt")
        XCTAssertTrue(report.receipt?.id.hasPrefix("I-") ?? false)

        try await store.logout()
    }
}
