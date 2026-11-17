import XCTest
@testable import Atelier

// Connectors, Skills and Plugins: what the forms write, how the server's answers read, and the view-models against the
// stateful demo server. `CustomizeLiveTests` (bottom) runs the same flows against a real throwaway server when asked to.

final class CustomizeLogicTests: XCTestCase {
    // MARK: Names and secrets

    func testSecretIDsAreSafeAndShort() {
        XCTAssertEqual(CustomizeSecrets.id("mcp", "GitHub", "Authorization"), "mcp-github-authorization")
        XCTAssertEqual(CustomizeSecrets.id("mcp", "my server!", "X-Api_Key"), "mcp-my-server-x-api-key")
        XCTAssertEqual(CustomizeSecrets.id("mcp", String(repeating: "a", count: 100)).count, 64)
        XCTAssertEqual(CustomizeSecrets.id("---", "a", "---"), "a")
    }

    func testCredentialLookingNamesAreKeptAsSecrets() {
        XCTAssertTrue(CustomizePair(name: "Authorization").wantsSecret)
        XCTAssertTrue(CustomizePair(name: "X-Api-Key").wantsSecret)
        XCTAssertTrue(CustomizePair(name: "GITHUB_TOKEN").wantsSecret)
        XCTAssertFalse(CustomizePair(name: "X-Team").wantsSecret)
        XCTAssertTrue(CustomizePair(name: "X-Team", secret: true).wantsSecret)
        XCTAssertFalse(CustomizePair(name: "Authorization", secret: false).wantsSecret)
    }

    func testOnlyLiteralValuesGoToTheSecretStore() {
        XCTAssertTrue(CustomizePair(name: "Authorization", value: "Bearer abc").storesSecret)
        XCTAssertFalse(CustomizePair(name: "Authorization", value: "Bearer ${secret:mcp-x}").storesSecret)
        XCTAssertFalse(CustomizePair(name: "Authorization", value: "  ").storesSecret)
        XCTAssertFalse(CustomizePair(name: "X-Team", value: "design").storesSecret)
    }

    func testToolNamesAreBuiltLikeClaudeCodeBuildsThem() {
        XCTAssertEqual(CustomizeNames.toolName(server: "github", tool: "create_issue"), "mcp__github__create_issue")
        XCTAssertEqual(CustomizeNames.toolName(server: "my.server", tool: "dotted.name"), "mcp__my_server__dotted_name")
        XCTAssertEqual(CustomizeNames.toolName(server: "s", tool: String(repeating: "x", count: 100)).count, 64)
    }

    func testConnectorNameValidationExplainsItself() {
        XCTAssertEqual(CustomizeConnectorForm.nameError("", taken: []), "Give it a name.")
        XCTAssertEqual(CustomizeConnectorForm.nameError("my server", taken: []), "Use up to 64 letters, digits, - and _.")
        XCTAssertEqual(CustomizeConnectorForm.nameError(String(repeating: "a", count: 65), taken: []), "Use up to 64 letters, digits, - and _.")
        XCTAssertEqual(CustomizeConnectorForm.nameError("github", taken: ["github"]), "There is a connector with this name already.")
        XCTAssertEqual(CustomizeConnectorForm.nameError("github", taken: ["github"], personal: true), "You have a connector called github already.")
        XCTAssertNil(CustomizeConnectorForm.nameError(" my_service-2 ", taken: ["github"]))
    }

    func testFormErrorsForEachTransport() {
        var form = CustomizeConnectorForm(name: "wiki", type: .http, url: "wiki.example.com")
        XCTAssertEqual(form.errors(taken: [])[.url], "Enter the server's URL, like https://example.com/mcp.")
        form.url = "https://wiki.example.com/mcp"
        XCTAssertTrue(form.errors(taken: []).isEmpty)
        form.url = "${secret:mcp-wiki-url}"
        XCTAssertNil(form.errors(taken: [])[.url])
        form.type = .stdio
        XCTAssertEqual(form.errors(taken: [])[.command], "Enter the command that starts the server.")
        form.command = "npx"
        XCTAssertTrue(form.errors(taken: []).isEmpty)
    }

    func testPairsAreChecked() {
        var form = CustomizeConnectorForm(name: "wiki", type: .http, url: "https://wiki.example.com/mcp")
        form.pairs = [CustomizePair(name: "", value: "abc")]
        XCTAssertEqual(form.errors(taken: [])[.pairs], "Every value needs a name.")
        form.pairs = [CustomizePair(name: "Bad Name", value: "x")]
        XCTAssertNotNil(form.errors(taken: [])[.pairs])
        form.pairs = [CustomizePair(name: "X-Team", value: "a"), CustomizePair(name: "X-Team", value: "b")]
        XCTAssertEqual(form.errors(taken: [])[.pairs], "Two entries have the same name.")
        form.pairs = [CustomizePair(name: "", value: ""), CustomizePair(name: "X-Team", value: "a")]
        XCTAssertNil(form.errors(taken: [])[.pairs])
        form.type = .stdio
        form.command = "npx"
        form.pairs = [CustomizePair(name: "1TOKEN", value: "x")]
        XCTAssertNotNil(form.errors(taken: [])[.pairs])
        form.pairs = [CustomizePair(name: "NOTION_TOKEN", value: "x")]
        XCTAssertNil(form.errors(taken: [])[.pairs])
    }

    // MARK: What forms write

    func testAdminEntryMovesCredentialsToSecretsAndKeepsTheScheme() {
        let form = CustomizeConnectorForm(name: "wiki", type: .http, url: " https://wiki.example.com/mcp ", pairs: [
            CustomizePair(name: "Authorization", value: "Bearer abc123"), CustomizePair(name: "X-Team", value: "design"),
            CustomizePair(name: "X-Api-Key", value: "${secret:existing}"),
        ], oauth: false)
        let built = form.adminEntry()
        XCTAssertEqual(built.secrets, [CustomizeNewSecret(id: "mcp-wiki-authorization", label: "Authorization for wiki", kind: "token", value: "abc123")])
        XCTAssertEqual(built.entry["type"].string, "http")
        XCTAssertEqual(built.entry["url"].string, "https://wiki.example.com/mcp")
        XCTAssertEqual(built.entry["headers"]["Authorization"].string, "Bearer ${secret:mcp-wiki-authorization}")
        XCTAssertEqual(built.entry["headers"]["X-Team"].string, "design")
        XCTAssertEqual(built.entry["headers"]["X-Api-Key"].string, "${secret:existing}")
        XCTAssertEqual(built.entry["auth"], .null)
    }

    func testAdminEntryForAProgramAndForOAuth() {
        let program = CustomizeConnectorForm(name: "notes", type: .stdio, command: " npx ", args: "-y\n  @scope/mcp-server \n\n", pairs: [CustomizePair(name: "API_KEY", value: "k-1")])
        let built = program.adminEntry()
        XCTAssertEqual(built.entry["command"].string, "npx")
        XCTAssertEqual(built.entry["args"].array.map(\.string), ["-y", "@scope/mcp-server"])
        XCTAssertEqual(built.entry["env"]["API_KEY"].string, "${secret:mcp-notes-api-key}")
        XCTAssertEqual(built.secrets.first?.kind, "api_key")
        let sso = CustomizeConnectorForm(name: "sso", type: .sse, url: "https://sso.example.com/mcp", oauth: true).adminEntry()
        XCTAssertEqual(sso.entry["auth"].string, "oauth")
        XCTAssertTrue(sso.secrets.isEmpty)
    }

    func testEditingKeepsEnabledToolsAndPreset() {
        let existing = CustomizeConnector.admin(name: "gh", config: ["type": "http", "url": "https://x.example.com/mcp", "enabled": false, "disabledTools": ["delete_branch"], "preset": "github", "headers": ["X-Team": "a"]])
        let form = CustomizeConnectorForm.from(existing)
        XCTAssertEqual(form.pairs.map(\.name), ["X-Team"])
        let built = form.adminEntry(keeping: existing)
        XCTAssertEqual(built.entry["enabled"], .bool(false))
        XCTAssertEqual(built.entry["disabledTools"].array.map(\.string), ["delete_branch"])
        XCTAssertEqual(built.entry["preset"].string, "github")
    }

    func testPersonalInputKeepsSavedValuesAndNeverSendsThemBack() {
        let existing = CustomizeConnector.personal(view: ["connector": ["id": "ab12", "name": "mine", "type": "http", "url": "https://m.example.com/mcp", "args": [], "envKeys": [], "headerKeys": ["X-Api-Key"], "enabled": true, "disabledTools": ["x"]], "clash": false])
        var form = CustomizeConnectorForm.from(existing)
        XCTAssertEqual(form.pairs.count, 1)
        XCTAssertTrue(form.pairs[0].saved)
        XCTAssertEqual(form.pairs[0].value, "")
        var input = form.personalInput(existing: existing)
        XCTAssertEqual(input["id"]?.string, "ab12")
        XCTAssertEqual(input["headers"]?["X-Api-Key"], .null)
        XCTAssertEqual(input["disabledTools"]?.array.map(\.string), ["x"])
        form.pairs[0].value = "new-value"
        input = form.personalInput(existing: existing)
        XCTAssertEqual(input["headers"]?["X-Api-Key"].string, "new-value")
        form.pairs.append(CustomizePair(name: "X-Other", value: "v"))
        XCTAssertEqual(form.personalInput(existing: nil)["id"], nil)
    }

    func testPersonalSaveInputKeepsEverythingNotChanged() {
        let connector = CustomizeConnector.personal(view: ["connector": ["id": "ab12", "name": "mine", "type": "stdio", "command": "npx", "args": ["-y", "x"], "envKeys": ["TOKEN"], "headerKeys": [], "enabled": true, "disabledTools": [], "auth": .null], "clash": false])
        let input = connector.saveInput(enabled: false, disabledTools: ["t"])
        XCTAssertEqual(input["enabled"], .bool(false))
        XCTAssertEqual(input["disabledTools"]?.array.map(\.string), ["t"])
        XCTAssertEqual(input["env"]?["TOKEN"], .null)
        XCTAssertEqual(input["command"]?.string, "npx")
        XCTAssertNil(input["url"])
        XCTAssertNil(input["auth"])
    }

    func testPresetEntriesMatchTheDesktops() throws {
        let github = try XCTUnwrap(CustomizePreset.named("github"))
        let built = CustomizePresetEntry.token(github, name: "github", token: "  ghp_abc \n", fields: [:])
        XCTAssertEqual(built.entry["url"].string, "https://api.githubcopilot.com/mcp/")
        XCTAssertEqual(built.entry["headers"]["Authorization"].string, "Bearer ${secret:mcp-github}")
        XCTAssertEqual(built.entry["preset"].string, "github")
        XCTAssertEqual(built.secrets, [CustomizeNewSecret(id: "mcp-github", label: "Personal access token for github", kind: "token", value: "ghp_abc")])
        let home = try XCTUnwrap(CustomizePreset.named("home-assistant"))
        XCTAssertEqual(CustomizePresetEntry.token(home, name: "ha", token: "t", fields: ["url": " http://homeassistant.local:8123// "]).entry["url"].string, "http://homeassistant.local:8123/api/mcp")
        let brave = try XCTUnwrap(CustomizePreset.named("brave-search"))
        let program = CustomizePresetEntry.token(brave, name: "brave", token: "k", fields: [:])
        XCTAssertEqual(program.entry["command"].string, "npx")
        XCTAssertEqual(program.entry["env"]["BRAVE_API_KEY"].string, "${secret:mcp-brave}")
        XCTAssertEqual(program.secrets.first?.kind, "api_key")
        let sso = CustomizePresetEntry.signIn(try XCTUnwrap(CustomizePreset.named("linear")))
        XCTAssertEqual(sso["auth"].string, "oauth")
        XCTAssertEqual(sso["url"].string, "https://mcp.linear.app/mcp")
        XCTAssertEqual(CustomizePreset.all.map(\.id), ["cloudflare", "github", "notion", "linear", "brave-search", "home-assistant"])
    }

    func testPresetFormErrors() throws {
        let home = try XCTUnwrap(CustomizePreset.named("home-assistant"))
        XCTAssertEqual(CustomizePresetEntry.errors(home, token: "", fields: [:], oauth: false).token, "Paste your long-lived access token.")
        XCTAssertEqual(CustomizePresetEntry.errors(home, token: "t", fields: [:], oauth: false).fields["url"], "Enter the Home Assistant address.")
        let cloudflare = try XCTUnwrap(CustomizePreset.named("cloudflare"))
        XCTAssertEqual(CustomizePresetEntry.errors(cloudflare, token: " ", fields: [:], oauth: false).token, "Paste your API token.")
        XCTAssertEqual(CustomizeText.inSentence("Personal access token"), "personal access token")
        XCTAssertNotNil(CustomizePresetEntry.errors(home, token: "t", fields: ["url": "homeassistant.local"], oauth: false).fields["url"])
        let ok = CustomizePresetEntry.errors(home, token: "t", fields: ["url": "http://homeassistant.local:8123"], oauth: false)
        XCTAssertNil(ok.token); XCTAssertTrue(ok.fields.isEmpty)
        XCTAssertNil(CustomizePresetEntry.errors(home, token: "", fields: [:], oauth: true).token)
        XCTAssertEqual(CustomizePresetEntry.freeName("github", taken: ["github", "github-2"]), "github-3")
    }

    func testImportMovesFlaggedCredentials() {
        let entry = CustomizeImportEntry(["name": "sentry", "config": ["type": "http", "url": "https://mcp.sentry.dev/mcp", "headers": ["Authorization": "Bearer sntrys_live", "X-Team": "a"], "env": [:], "args": []], "secrets": [["headers", "Authorization"]], "source": ".mcp.json"])
        let built = entry.adminEntry()
        XCTAssertEqual(built.secrets.map(\.value), ["sntrys_live"])
        XCTAssertEqual(built.entry["headers"]["Authorization"].string, "Bearer ${secret:mcp-sentry-authorization}")
        XCTAssertEqual(built.entry["headers"]["X-Team"].string, "a")
        let personal = entry.personalInput()
        XCTAssertEqual(personal["headers"]?["Authorization"].string, "Bearer sntrys_live")
        XCTAssertEqual(personal["env"], .object([:]))
        let program = CustomizeImportEntry(["name": "fs", "config": ["type": "stdio", "command": "npx", "args": ["-y", "x"], "env": ["TOKEN": "${TOKEN}"]], "secrets": [], "source": "~/.claude.json"])
        XCTAssertEqual(program.personalInput()["command"]?.string, "npx")
        XCTAssertEqual(program.config.target, "npx -y x")
    }

    // MARK: Status

    func testStatusPresentation() {
        func connector(enabled: Bool = true, clash: Bool = false) -> CustomizeConnector {
            var c = CustomizeConnector.admin(name: "x", config: ["type": "http", "url": "https://x.example.com/mcp", "enabled": .bool(enabled)]); c.clash = clash; return c
        }
        func status(_ json: JSON) -> CustomizeStatus { CustomizeStatus(json.setting("name", "x").setting("type", "http")) }
        XCTAssertEqual(CustomizeStatusPresentation.of(connector(), nil).label, "Connecting…")
        XCTAssertTrue(CustomizeStatusPresentation.of(connector(), nil).busy)
        XCTAssertEqual(CustomizeStatusPresentation.of(connector(enabled: false), nil).label, "Off")
        XCTAssertEqual(CustomizeStatusPresentation.of(connector(clash: true), nil).label, "Not used")
        XCTAssertEqual(CustomizeStatusPresentation.of(connector(), status(["state": "ready", "tools": []])).label, "Ready")
        XCTAssertEqual(CustomizeStatusPresentation.of(connector(), status(["state": "ready", "device": "MacBook", "tools": []])).label, "Ready on MacBook")
        XCTAssertEqual(CustomizeStatusPresentation.of(connector(), status(["state": "error", "signIn": "needed", "tools": []])).label, "Not signed in")
        let waiting = CustomizeStatusPresentation.of(connector(), status(["state": "error", "signIn": "waiting", "tools": []]))
        XCTAssertEqual(waiting.label, "Waiting for sign-in"); XCTAssertTrue(waiting.busy)
        XCTAssertEqual(CustomizeStatusPresentation.of(connector(), status(["state": "error", "error": "boom", "tools": []])), .init(label: "Error", tone: .bad, busy: false))
    }

    func testToolSummaryCountsTheOnesThatAreOn() {
        var c = CustomizeConnector.admin(name: "x", config: ["type": "http", "url": "https://x.example.com/mcp", "disabledTools": ["b"]])
        let status = CustomizeStatus(["name": "x", "type": "http", "state": "ready", "tools": [["name": "a"], ["name": "b"], ["name": "c"]]])
        XCTAssertEqual(CustomizeStatusPresentation.toolSummary(c, status), "2 of 3 tools")
        c.disabledTools = []
        XCTAssertEqual(CustomizeStatusPresentation.toolSummary(c, status), "3 tools")
        XCTAssertEqual(CustomizeStatusPresentation.toolSummary(c, CustomizeStatus(["name": "x", "type": "http", "state": "ready", "tools": [["name": "a"]]])), "1 tool")
        XCTAssertNil(CustomizeStatusPresentation.toolSummary(c, CustomizeStatus(["name": "x", "type": "http", "state": "error", "tools": []])))
        XCTAssertNil(CustomizeStatusPresentation.toolSummary(c, nil))
        c.clash = true
        XCTAssertNil(CustomizeStatusPresentation.toolSummary(c, status))
    }

    func testStatusParsingToleratesWhatTheServerOmits() {
        let status = CustomizeStatus(["name": "x", "type": "stdio", "state": "ready", "protocolEra": "legacy", "tools": [["name": "t", "description": "d", "readOnly": true, "enabled": false]]])
        XCTAssertEqual(status.protocolText, "MCP 2025 or earlier")
        XCTAssertEqual(status.tools.first, CustomizeTool(name: "t", description: "d", readOnly: true, enabled: false))
        XCTAssertEqual(CustomizeStatus(["name": "y"]).state, .connecting)
        XCTAssertFalse(CustomizeStatus(["name": "y"]).personal)
        XCTAssertEqual(CustomizeStatus(["name": "y", "protocolEra": "modern"]).protocolText, "MCP 2026-07-28")
    }

    // MARK: Permission rules

    func testPermissionRulesFollowTheDesktop() {
        let rule = "mcp__github__create_issue"
        var rules = CustomizePermissions()
        XCTAssertEqual(rules.policy(for: rule), .ask)
        rules = rules.setting(rule, to: .allow)
        XCTAssertEqual(rules.allow, [rule]); XCTAssertEqual(rules.policy(for: rule), .allow)
        rules = rules.setting(rule, to: .deny)
        XCTAssertEqual(rules.allow, []); XCTAssertEqual(rules.deny, [rule]); XCTAssertEqual(rules.policy(for: rule), .deny)
        rules = rules.setting(rule, to: .ask)
        XCTAssertEqual(rules, CustomizePermissions())
        XCTAssertEqual(CustomizePermissions(allow: ["x"], deny: ["x"]).policy(for: "x"), .deny)
    }

    func testForgettingARemovedServersRules() {
        let rules = CustomizePermissions(allow: ["mcp__github", "mcp__github__x", "mcp__github2__x", "Bash(ls)"], ask: ["mcp__github__y"], deny: ["mcp__other__z"])
        let next = rules.forgetting(server: "github")
        XCTAssertEqual(next.allow, ["mcp__github2__x", "Bash(ls)"])
        XCTAssertEqual(next.ask, [])
        XCTAssertEqual(next.deny, ["mcp__other__z"])
        XCTAssertEqual(next.changes(from: rules), [.allow, .ask])
    }

    // MARK: Words

    func testConnectorErrorsAreTranslated() {
        XCTAssertTrue(CustomizeErrors.connector("Version negotiation failed: the server requires authorization (HTTP 401)").hasPrefix("The server didn't accept the sign-in or token."))
        XCTAssertTrue(CustomizeErrors.connector("This server runs a program on this machine (stdio), which only the desktop app does. Use its HTTP endpoint instead.").contains("only the Atelier desktop app"))
        XCTAssertTrue(CustomizeErrors.connector("Missing the secret \"mcp-github\".").contains("mcp-github"))
        XCTAssertTrue(CustomizeErrors.connector("Version negotiation probe failed: fetch failed").hasPrefix("Couldn't reach"))
        XCTAssertEqual(CustomizeErrors.connector("Can't reach 127.0.0.1:27182: nothing answers there (connection refused)."), "Can't reach 127.0.0.1:27182: nothing answers there (connection refused).")
    }

    func testPersonalConnectorFailuresSayWhatToDo() {
        let program = "It runs a program on your computer: allow it in Customize › Connectors in the Atelier desktop app there."
        XCTAssertTrue(CustomizeErrors.connector(program).contains("Open the Atelier desktop app on that computer"))
        XCTAssertEqual(CustomizeErrors.connectorSummary(program), "Not allowed on a computer yet")
        XCTAssertEqual(CustomizeErrors.connector("Offline on MacBook Pro: it runs there."), "MacBook Pro is offline. It starts again when that computer is back.")
        XCTAssertEqual(CustomizeErrors.connectorSummary("Offline on MacBook Pro: it runs there."), "Its computer is offline")
        let local = "127.0.0.1:62197 is on your computer or its network, which the server can't reach: allow it in Customize › Connectors in the Atelier desktop app there."
        XCTAssertTrue(CustomizeErrors.connector(local).hasPrefix("127.0.0.1:62197 is on your computer or its network"))
        XCTAssertEqual(CustomizeErrors.connectorSummary(local), "Reached only through your computer")
        XCTAssertEqual(CustomizeErrors.connector("It changed since you allowed it on MacBook: allow it in Customize › Connectors in the Atelier desktop app there again."), "It changed since you allowed it on MacBook. Allow it again in Customize › Connectors in the Atelier desktop app on that computer.")
    }

    func testRowSummariesAreShort() {
        XCTAssertEqual(CustomizeErrors.connectorSummary("Version negotiation failed: the server requires authorization (HTTP 401)"), "The token wasn't accepted")
        XCTAssertEqual(CustomizeErrors.connectorSummary("Can't reach homeassistant.local:8123: that name doesn't resolve."), "Can't reach homeassistant.local:8123")
        XCTAssertEqual(CustomizeErrors.connectorSummary("This server runs a program on this machine (stdio), which only the desktop app does. Use its HTTP endpoint instead."), "Needs the desktop app")
        XCTAssertEqual(CustomizeErrors.connectorSummary("Missing the secret \"mcp-x\"."), "A stored key is missing")
        XCTAssertTrue(CustomizeErrors.connectorSummary(String(repeating: "word ", count: 40)).count <= 58)
        XCTAssertEqual(CustomizeText.breakable("a-b_c"), "a-\u{200B}b_\u{200B}c")
    }

    func testServerRefusalsAreTranslated() {
        XCTAssertEqual(CustomizeErrors.describe("Unknown method plugins.list"), "This server doesn't support this yet.")
        XCTAssertEqual(CustomizeErrors.describe("Only admins can do this."), "Only admins can change this.")
        XCTAssertTrue(CustomizeErrors.describe("Connection interrupted. An action may have reached the server; refresh before retrying.").hasPrefix("The connection to your server dropped"))
        XCTAssertTrue(CustomizeErrors.isUnsupported(MobileError.message("Unknown method skills.list")))
        XCTAssertTrue(CustomizeErrors.isUnsupported(CustomizeErrors.translated(MobileError.message("Unknown method skills.list"))))
        XCTAssertFalse(CustomizeErrors.isUnsupported(MobileError.message("Nope")))
        XCTAssertEqual(CustomizeErrors.message(for: CancellationError()), "")
    }

    func testExistingSkillIsReadFromTheRefusal() {
        XCTAssertEqual(CustomizeErrors.existingSkill(in: "A skill named “pdf” is already installed from somewhere else. Install again with replace to overwrite it."), "pdf")
        XCTAssertNil(CustomizeErrors.existingSkill(in: "owner/repo wasn't found (or is private)."))
    }

    func testSignInPagesOpenOnlyOverHTTPSOrTheMachineItself() {
        XCTAssertNotNil(CustomizeSignIn.safeURL("https://example.com/authorize?x=1"))
        XCTAssertNotNil(CustomizeSignIn.safeURL("http://127.0.0.1:17430/authorize"))
        XCTAssertNotNil(CustomizeSignIn.safeURL("http://localhost:3000/authorize"))
        XCTAssertNil(CustomizeSignIn.safeURL("http://example.com/authorize"))
        XCTAssertNil(CustomizeSignIn.safeURL("javascript:alert(1)"))
        XCTAssertNil(CustomizeSignIn.safeURL("atelier://x"))
        XCTAssertNil(CustomizeSignIn.safeURL(""))
    }

    func testTextHelpers() {
        XCTAssertEqual(CustomizeText.plural(1, "tool"), "1 tool"); XCTAssertEqual(CustomizeText.plural(0, "tool"), "0 tools")
        XCTAssertTrue(CustomizeText.matches("pdf form", in: ["Fill PDF forms", "x"]))
        XCTAssertTrue(CustomizeText.matches("", in: ["x"]))
        XCTAssertFalse(CustomizeText.matches("excel", in: ["pdf", "word"]))
        XCTAssertTrue(CustomizeText.matches("cafe", in: ["Café"]))
        XCTAssertEqual(CustomizeText.logLine("09:49:12 Version negotiation failed").time, "09:49:12")
        XCTAssertEqual(CustomizeText.logLine("09:49:12 Version negotiation failed").text, "Version negotiation failed")
        XCTAssertNil(CustomizeText.logLine("no time here").time)
        XCTAssertNotNil(CustomizeText.date(iso: "2026-11-17T10:24:26.123Z"))
        XCTAssertNotNil(CustomizeText.date(iso: "2026-11-17T10:24:26Z"))
        XCTAssertNil(CustomizeText.date(iso: "yesterday"))
    }

    // MARK: Skills and plugins

    func testSkillsFollowPrecedence() {
        let skills = ["b": "plugin", "a": "global", "c": "project", "d": "global"].map { CustomizeSkill(["name": .string($0.key), "scope": .string($0.value), "description": "", "manualOnly": false, "warnings": [], "installed": .null]) }
        XCTAssertEqual(skills.sorted(by: CustomizeSkill.precedes).map(\.name), ["c", "a", "d", "b"])
    }

    func testSkillAndPluginParsing() {
        let skill = CustomizeSkill(["name": "pdf", "description": "d", "scope": "global", "manualOnly": true, "warnings": ["w"], "installed": ["source": "anthropics/skills", "sha": "e4bb5d960d87", "installedAt": "2026-11-12T08:30:00.000Z"], "device": "MacBook"])
        XCTAssertEqual(skill.shortSha, "e4bb5d9"); XCTAssertTrue(skill.manualOnly); XCTAssertEqual(skill.device, "MacBook")
        XCTAssertNil(CustomizeSkill(["name": "x", "installed": .null]).installed)
        let plugin = CustomizePlugin(["id": "a@m", "name": "a", "description": "d", "version": "1.0", "source": "atelier", "enabled": true, "skills": ["s1", "s2"], "commands": ["c"], "agents": []])
        XCTAssertEqual(plugin.contents, "2 skills · 1 command"); XCTAssertTrue(plugin.canUninstall); XCTAssertFalse(plugin.own); XCTAssertFalse(plugin.isEmpty)
        let theirs = CustomizePlugin(["id": "b@m", "name": "b", "source": "claude-code", "enabled": false, "skills": [], "commands": [], "agents": [], "device": "MacBook"])
        XCTAssertFalse(theirs.canUninstall); XCTAssertTrue(theirs.own); XCTAssertTrue(theirs.isEmpty); XCTAssertEqual(theirs.contents, "")
    }

    func testMarketplaceInputAndKnownRepos() {
        for good in ["owner/repo", "https://github.com/anthropics/claude-plugins-official", "github.com/a/b", "a-b/c.d"] { XCTAssertTrue(CustomizeMarketplace.looksValid(good), good) }
        for bad in ["", "owner", "owner/", "/repo", "a b/c", "???", "ab"] { XCTAssertFalse(CustomizeMarketplace.looksValid(bad), bad) }
        XCTAssertTrue(CustomizeMarketplace.looksValid("owner/repo@main/skills/pdf"))
        let settings: JSON = ["effective": ["extraKnownMarketplaces": ["a": ["source": ["source": "github", "repo": "x/y"]], "b": ["source": ["source": "github", "repo": "x/y"]], "c": ["source": ["source": "git", "url": "u"]]]]]
        XCTAssertEqual(CustomizeMarketplace.known(from: settings), ["x/y"])
        let plugin = CustomizeMarketPlugin(["name": "p", "description": "", "version": ""])
        XCTAssertTrue(CustomizeMarketplace.isInstalled(plugin, marketplace: "m", in: [CustomizePlugin(["id": "p@m", "name": "p"])]))
        XCTAssertFalse(CustomizeMarketplace.isInstalled(plugin, marketplace: "m", in: [CustomizePlugin(["id": "p@other", "name": "p"])]))
    }
}

// MARK: - View-models against the demo server

@MainActor final class CustomizeModelTests: XCTestCase {
    private func store(admin: Bool = true) -> AppStore {
        CustomizeDemoServer.shared.reset()
        let store = AppStore()
        store.authStatus = .obj(["user": .obj(["role": .string(admin ? "admin" : "user")])])
        store.info = .obj(["surface": "web"])
        store.rpc.stub = { method, params in try CustomizeDemo.respond(method, params) }
        return store
    }

    func testAdminConnectorsLoadSortedWithTheirStatus() async throws {
        let model = CustomizeConnectorsModel(store: store(), scope: .admin)
        await model.load()
        XCTAssertEqual(model.phase, .ready)
        XCTAssertEqual(model.connectors.map(\.name).first, "cloudflare")
        let github = try XCTUnwrap(model.connectors.first { $0.name == "github" })
        XCTAssertEqual(model.status(for: github)?.state, .ready)
        XCTAssertEqual(model.policy(github, tool: "search_code"), .allow)
        XCTAssertEqual(model.policy(github, tool: "create_pull_request"), .deny)
        XCTAssertEqual(model.policy(github, tool: "create_issue"), .ask)
        XCTAssertTrue(model.needsWatching)
    }

    func testSwitchingAConnectorOffSticks() async throws {
        let model = CustomizeConnectorsModel(store: store(), scope: .admin)
        await model.load()
        let github = try XCTUnwrap(model.connector("github"))
        await model.setEnabled(github, false)
        XCTAssertEqual(model.connector("github")?.enabled, false)
        XCTAssertEqual(model.presentation(try XCTUnwrap(model.connector("github"))).label, "Off")
        await model.load()
        XCTAssertEqual(model.connector("github")?.enabled, false)
    }

    func testToolSwitchesAndPoliciesAreWrittenToTheSettings() async throws {
        let model = CustomizeConnectorsModel(store: store(), scope: .admin)
        await model.load()
        let github = try XCTUnwrap(model.connector("github"))
        await model.setTool(github, tool: "get_commit", enabled: false)
        await model.setPolicy(github, tool: "create_issue", .allow)
        await model.setPolicy(github, tool: "search_code", .ask)
        await model.load()
        let reloaded = try XCTUnwrap(model.connector("github"))
        XCTAssertTrue(reloaded.disabledTools.contains("get_commit"))
        XCTAssertEqual(model.policy(reloaded, tool: "create_issue"), .allow)
        XCTAssertEqual(model.policy(reloaded, tool: "search_code"), .ask)
        await model.setTool(reloaded, tool: "get_commit", enabled: true)
        await model.load()
        XCTAssertFalse(try XCTUnwrap(model.connector("github")).disabledTools.contains("get_commit"))
    }

    func testAddingACustomConnectorStoresTheSecretThenTheEntry() async throws {
        let model = CustomizeConnectorsModel(store: store(), scope: .admin)
        await model.load()
        let form = CustomizeConnectorForm(name: "billing", type: .http, url: "https://billing.example.com/mcp", pairs: [CustomizePair(name: "Authorization", value: "Bearer sk-live-1")])
        let id = try await model.save(form, existing: nil)
        XCTAssertEqual(id, "billing")
        let added = try XCTUnwrap(model.connector("billing"))
        XCTAssertEqual(added.headers["Authorization"], "Bearer ${secret:mcp-billing-authorization}")
        XCTAssertFalse(String(describing: added).contains("sk-live-1"))
        XCTAssertEqual(model.takenNames().contains("billing"), true)
    }

    func testAddingAPresetAndRemovingItDropsItsRules() async throws {
        let model = CustomizeConnectorsModel(store: store(), scope: .admin)
        await model.load()
        let preset = try XCTUnwrap(CustomizePreset.named("linear"))
        _ = try await model.addPreset(preset, name: "linear-2", token: "lin_api_abc", fields: [:], signIn: false)
        XCTAssertEqual(model.connector("linear-2")?.preset, "linear")
        let github = try XCTUnwrap(model.connector("github"))
        let ok1 = await model.remove(github)
        XCTAssertTrue(ok1)
        XCTAssertNil(model.connector("github"))
        await model.load()
        XCTAssertNil(model.connector("github"))
        XCTAssertEqual(model.permissions.allow, [])
        XCTAssertEqual(model.permissions.deny, [])
    }

    func testTestingReplacesTheStatus() async throws {
        let model = CustomizeConnectorsModel(store: store(), scope: .admin)
        await model.load()
        let slow = try XCTUnwrap(model.connector("internal-docs-and-knowledge-base-search-production"))
        XCTAssertEqual(model.status(for: slow)?.state, .connecting)
        let result = await model.test(slow)
        XCTAssertEqual(result?.state, .ready)
        XCTAssertEqual(model.status(for: slow)?.state, .ready)
    }

    func testSignInStartsWaitingAndCanBeCancelled() async throws {
        let model = CustomizeConnectorsModel(store: store(), scope: .admin)
        await model.load()
        let cloudflare = try XCTUnwrap(model.connector("cloudflare"))
        XCTAssertEqual(model.status(for: cloudflare)?.signIn, .needed)
        // Without a window the sign-in sheet cannot open in a unit test, but the server side starts and is shown as waiting.
        await model.signIn(cloudflare)
        XCTAssertEqual(model.status(for: cloudflare)?.signIn, .waiting)
        await model.cancelSignIn(cloudflare)
        XCTAssertEqual(model.status(for: cloudflare)?.signIn, .needed)
        await model.signOut(cloudflare)
        XCTAssertEqual(model.status(for: cloudflare)?.signIn, .needed)
    }

    func testLogsComeBackAsLines() async throws {
        let model = CustomizeConnectorsModel(store: store(), scope: .admin)
        await model.load()
        let lines = try await model.logs(try XCTUnwrap(model.connector("home-assistant")))
        XCTAssertTrue(lines.contains { $0.contains("doesn't resolve") })
    }

    func testImportEntriesAreWrittenWithTheirSecrets() async throws {
        let model = CustomizeConnectorsModel(store: store(), scope: .admin)
        await model.load()
        let entries = try await model.importable()
        XCTAssertEqual(entries.map(\.name), ["filesystem", "sentry", "github"])
        let chosen = entries.filter { !model.takenNames().contains($0.name) }
        XCTAssertEqual(chosen.map(\.name), ["filesystem", "sentry"])
        try await model.runImport(chosen)
        XCTAssertEqual(model.connector("sentry")?.headers["Authorization"], "Bearer ${secret:mcp-sentry-authorization}")
        XCTAssertEqual(model.connector("filesystem")?.type, .stdio)
    }

    func testPersonalConnectorsKeepTheirValuesOnTheServer() async throws {
        let model = CustomizeConnectorsModel(store: store(admin: false), scope: .personal)
        await model.load()
        XCTAssertEqual(model.connectors.map(\.name), ["my-notes", "home-server", "my-sso", "wiki"])
        XCTAssertEqual(model.connector("p4")?.clash, true)
        XCTAssertEqual(model.sharedStatuses.map(\.name).contains("github"), true)
        XCTAssertEqual(model.presentation(try XCTUnwrap(model.connector("p4"))).label, "Not used")
        let notes = try XCTUnwrap(model.connector("p1"))
        XCTAssertEqual(notes.headerKeys, ["X-Api-Key"])
        await model.setEnabled(notes, false)
        await model.setTool(notes, tool: "search", enabled: false)
        await model.load()
        XCTAssertEqual(model.connector("p1")?.enabled, false)
        XCTAssertEqual(model.connector("p1")?.disabledTools, ["search"])
        XCTAssertEqual(model.connector("p1")?.headerKeys, ["X-Api-Key"])
        let form = CustomizeConnectorForm(name: "mine", type: .http, url: "https://mine.example.com/mcp", pairs: [CustomizePair(name: "X-Token", value: "t-1", secret: true)])
        let id = try await model.save(form, existing: nil)
        XCTAssertEqual(model.connector(id)?.headerKeys, ["X-Token"])
        let ok2 = await model.remove(try XCTUnwrap(model.connector(id)))
        XCTAssertTrue(ok2)
        XCTAssertNil(model.connector(id))
        do { _ = try await model.save(CustomizeConnectorForm(name: "github", type: .http, url: "https://x.example.com/mcp"), existing: nil); XCTFail("An admin's name is taken") }
        catch { XCTAssertTrue(error.localizedDescription.contains("admin's connector")) }
    }

    func testSkillsInstallReplaceAndUninstall() async throws {
        let store = store()
        let model = CustomizeSkillsModel(store: store)
        await model.load()
        XCTAssertEqual(model.phase, .ready)
        XCTAssertEqual(model.skills.map(\.scope).first, .project)
        XCTAssertEqual(model.commands.map(\.name), ["agent-sdk-dev:new-sdk-app", "review"])
        XCTAssertEqual(model.folders.map(\.name), ["atelier", "home-lab"])
        await model.install("anthropics/skills/skills/xlsx", replace: false)
        XCTAssertNotNil(model.skill("xlsx"))
        XCTAssertNil(model.installError)
        await model.install("anthropics/skills/skills/xlsx", replace: false)
        XCTAssertEqual(model.replacing?.name, "xlsx")
        XCTAssertNil(model.installError)
        await model.install("anthropics/skills/skills/xlsx", replace: true)
        XCTAssertNotNil(model.skill("xlsx"))
        await model.install("nobody/nope", replace: false)
        XCTAssertEqual(model.installError, "nobody/nope wasn't found (or is private).")
        let installed = try XCTUnwrap(model.skill("xlsx"))
        let ok3 = await model.uninstall(installed)
        XCTAssertTrue(ok3)
        XCTAssertNil(model.skill("xlsx"))
        let ok4 = await model.uninstall(try XCTUnwrap(model.skill("brand-voice")))
        XCTAssertFalse(ok4)
        XCTAssertNotNil(store.error)
    }

    func testPluginsSwitchBrowseInstallAndUninstall() async throws {
        let store = store()
        let model = CustomizePluginsModel(store: store)
        await model.load()
        XCTAssertEqual(model.plugins.count, 4)
        XCTAssertEqual(model.known, ["anthropics/claude-plugins-official"])
        let legacy = try XCTUnwrap(model.plugin("legacy-tools@my-marketplace"))
        await model.setEnabled(legacy, true)
        XCTAssertEqual(model.plugin("legacy-tools@my-marketplace")?.enabled, true)
        let theirs = try XCTUnwrap(model.plugin("superpowers@claude-plugins-official"))
        XCTAssertTrue(theirs.own)
        await model.setEnabled(theirs, false)
        await model.load()
        XCTAssertEqual(model.plugin(theirs.id)?.enabled, false)
        let listing = try await model.browse("anthropics/claude-plugins-official")
        XCTAssertEqual(listing.name, "claude-plugins-official")
        XCTAssertEqual(listing.plugins.filter { $0.unsupported != nil }.count, 2)
        let target = try XCTUnwrap(listing.plugins.first { $0.name == "commit-commands" })
        let ok5 = await model.install(target, from: "anthropics/claude-plugins-official")
        XCTAssertTrue(ok5)
        XCTAssertTrue(CustomizeMarketplace.isInstalled(target, marketplace: listing.name, in: model.plugins))
        let ok6 = await model.uninstall(try XCTUnwrap(model.plugin("commit-commands@claude-plugins-official")))
        XCTAssertTrue(ok6)
        let ok7 = await model.uninstall(theirs)
        XCTAssertFalse(ok7)
        do { _ = try await model.browse("nobody/nope"); XCTFail("An unknown marketplace must fail") }
        catch { XCTAssertEqual(error.localizedDescription, "nobody/nope wasn't found (or is private).") }
    }

    func testOrdinaryUsersCanOnlySwitchTheirOwnPlugins() async throws {
        let model = CustomizePluginsModel(store: store(admin: false))
        await model.load()
        XCTAssertFalse(model.canSwitch(try XCTUnwrap(model.plugin("agent-sdk-dev@claude-plugins-official"))))
        XCTAssertTrue(model.canSwitch(try XCTUnwrap(model.plugin("superpowers@claude-plugins-official"))))
        XCTAssertEqual(model.known, [])
    }
}

// MARK: - Against a real server

/// Runs the screens' calls against a throwaway Atelier server (see `scripts/live-server.mjs`), with the exact parameters the app sends.
/// `TEST_RUNNER_ATELIER_CUSTOMIZE_SERVER`, `_USER`, `_PASSWORD`, and the addresses of three mock MCP servers
/// (`packages/core/src/mcp/__fixtures__/http-server.ts`: `_MOCK_OPEN`, `_MOCK_TOKEN` with token `secret123`, `_MOCK_OAUTH`).
@MainActor final class CustomizeLiveTests: XCTestCase {
    private func env(_ name: String) throws -> String {
        guard let value = ProcessInfo.processInfo.environment["ATELIER_CUSTOMIZE_" + name] else { throw XCTSkip("Set ATELIER_CUSTOMIZE_* to run against a throwaway server") }
        return value
    }

    private func signedIn(_ user: String, _ password: String) async throws -> AppStore {
        let store = AppStore()
        store.address = try env("SERVER")
        try await store.login(username: user, password: password)
        return store
    }

    private func waitFor(_ what: String, timeout: Double = 20, _ condition: @MainActor () async -> Bool) async {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline { if await condition() { return }; try? await Task.sleep(for: .milliseconds(400)) }
        XCTFail("Timed out waiting for \(what)")
    }

    func testAdminConnectorsEndToEnd() async throws {
        let store = try await signedIn(try env("USER"), try env("PASSWORD"))
        let model = CustomizeConnectorsModel(store: store, scope: .admin)
        await model.load()
        XCTAssertEqual(model.phase, .ready)
        // A token connector: the token is stored first, then the entry that refers to it.
        let wiki = CustomizeConnectorForm(name: "live-wiki", type: .http, url: try env("MOCK_TOKEN"), pairs: [CustomizePair(name: "Authorization", value: "Bearer secret123")])
        _ = try await model.save(wiki, existing: nil)
        _ = try await model.save(CustomizeConnectorForm(name: "live-open", type: .http, url: try env("MOCK_OPEN")), existing: nil)
        _ = try await model.save(CustomizeConnectorForm(name: "live-sso", type: .http, url: try env("MOCK_OAUTH"), oauth: true), existing: nil)
        _ = try await model.save(CustomizeConnectorForm(name: "live-broken", type: .http, url: "http://127.0.0.1:9/mcp"), existing: nil)
        let open = try XCTUnwrap(model.connector("live-open"))
        let token = try XCTUnwrap(model.connector("live-wiki"))
        XCTAssertEqual(token.headers["Authorization"], "Bearer ${secret:mcp-live-wiki-authorization}")
        await waitFor("both mock servers to be ready") {
            await model.refreshStatuses()
            return model.status(for: open)?.state == .ready && model.status(for: token)?.state == .ready
        }
        XCTAssertEqual(model.status(for: open)?.tools.first?.name, "echo")
        // Tools and permissions.
        await model.setTool(open, tool: "echo", enabled: false)
        await model.setPolicy(open, tool: "picture", .allow)
        await model.setPolicy(open, tool: "fail", .deny)
        await model.load()
        let reloaded = try XCTUnwrap(model.connector("live-open"))
        XCTAssertEqual(reloaded.disabledTools, ["echo"])
        XCTAssertEqual(model.policy(reloaded, tool: "picture"), .allow)
        XCTAssertEqual(model.policy(reloaded, tool: "fail"), .deny)
        // Test, logs and a failure.
        let tested = await model.test(reloaded)
        XCTAssertEqual(tested?.state, .ready)
        let broken = try XCTUnwrap(model.connector("live-broken"))
        let failed = await model.test(broken)
        XCTAssertEqual(failed?.state, .error)
        XCTAssertTrue(CustomizeErrors.connector(failed?.error ?? "").hasPrefix("Couldn't reach") || (failed?.error ?? "").hasPrefix("Can't reach"))
        let logs = try await model.logs(broken)
        XCTAssertFalse(logs.isEmpty)
        // OAuth: the sign-in page comes from the server and shows as waiting; cancelling and signing out answer.
        let sso = try XCTUnwrap(model.connector("live-sso"))
        // Adding an OAuth connector starts its sign-in at once (as on the desktop); cancelling puts it back to "not signed in".
        await waitFor("the sign-in to start") { await model.refreshStatuses(); return model.status(for: sso)?.signIn != nil }
        await model.cancelSignIn(sso)
        XCTAssertEqual(model.status(for: sso)?.signIn, .needed)
        await model.signIn(sso)
        XCTAssertNil(model.signInIssue["live-sso"])
        XCTAssertEqual(model.status(for: sso)?.signIn, .waiting)
        await model.cancelSignIn(sso)
        XCTAssertEqual(model.status(for: sso)?.signIn, .needed)
        await model.signOut(sso)
        // Switching off and removing: the permission rules go with it.
        await model.setEnabled(reloaded, false)
        XCTAssertEqual(model.status(for: reloaded)?.state, .disabled)
        for name in ["live-wiki", "live-open", "live-sso", "live-broken"] {
            let removed = await model.remove(try XCTUnwrap(model.connector(name)))
            XCTAssertTrue(removed)
        }
        XCTAssertTrue(model.permissions.allow.filter { $0.hasPrefix("mcp__live") }.isEmpty)
        XCTAssertTrue(model.permissions.deny.filter { $0.hasPrefix("mcp__live") }.isEmpty)
        // Importing is only for a desktop's own backend: a server says so.
        do { _ = try await model.importable(); XCTFail("A server cannot import from Claude Code") }
        catch { XCTAssertEqual(error.localizedDescription, "Importing from Claude Code works in the desktop app, where its settings live.") }
    }

    func testPersonalConnectorsEndToEnd() async throws {
        let store = try await signedIn(try env("USER"), try env("PASSWORD"))
        let model = CustomizeConnectorsModel(store: store, scope: .personal)
        await model.load()
        XCTAssertEqual(model.phase, .ready)
        let form = CustomizeConnectorForm(name: "live-mine", type: .http, url: try env("MOCK_OPEN"), pairs: [CustomizePair(name: "X-Api-Key", value: "abc", secret: true)])
        let id = try await model.save(form, existing: nil)
        let saved = try XCTUnwrap(model.connector(id))
        XCTAssertEqual(saved.headerKeys, ["X-Api-Key"])
        // Its address is on this computer, which the server cannot reach: it says so, and how to fix it.
        let tested = await model.test(saved)
        XCTAssertEqual(tested?.state, .error)
        XCTAssertTrue(tested?.error?.contains("Atelier desktop app") == true)
        let savedLogs = try await model.logs(saved)
        XCTAssertFalse(savedLogs.isEmpty)
        // Saving again keeps the value (null); switching off and a tool switch go through the same call.
        await model.setEnabled(saved, false)
        await model.setTool(saved, tool: "echo", enabled: false)
        await model.load()
        XCTAssertEqual(model.connector(id)?.enabled, false)
        XCTAssertEqual(model.connector(id)?.disabledTools, ["echo"])
        XCTAssertEqual(model.connector(id)?.headerKeys, ["X-Api-Key"])
        // An admin's name is refused.
        do { _ = try await model.save(CustomizeConnectorForm(name: "live-mine", type: .http, url: try env("MOCK_OPEN")), existing: nil); XCTFail("The name is taken") }
        catch { XCTAssertTrue(error.localizedDescription.contains("already") || error.localizedDescription.contains("called")) }
        // An OAuth connector of one's own starts a sign-in with its own procedure.
        let sso = try await model.save(CustomizeConnectorForm(name: "live-mine-sso", type: .http, url: try env("MOCK_OAUTH"), oauth: true), existing: nil)
        let ssoConnector = try XCTUnwrap(model.connector(sso))
        await model.refreshStatuses()
        // Its address is on this computer, which the server cannot sign in to: the failure is kept for the page to show.
        await model.signIn(ssoConnector)
        XCTAssertTrue(model.signInIssue[sso]?.hasPrefix("Signing in failed") == true)
        XCTAssertTrue(CustomizeErrors.connector(model.signInIssue[sso] ?? "").hasPrefix("Couldn't reach the server"))
        for connector in model.connectors where connector.name.hasPrefix("live-mine") {
            let removed = await model.remove(connector)
            XCTAssertTrue(removed)
        }
        do { _ = try await model.importable(); XCTFail("A phone is not a computer with Claude Code") }
        catch { XCTAssertEqual(error.localizedDescription, "Import from Claude Code in the desktop app on the computer that has it.") }
    }

    func testSkillsAndPluginsEndToEnd() async throws {
        let store = try await signedIn(try env("USER"), try env("PASSWORD"))
        let skills = CustomizeSkillsModel(store: store)
        await skills.load()
        XCTAssertEqual(skills.phase, .ready)
        await skills.install("anthropics/skills/skills/pdf", replace: false)
        XCTAssertNil(skills.installError)
        let pdf = try XCTUnwrap(skills.skill("pdf"))
        XCTAssertEqual(pdf.installed?.source, "anthropics/skills")
        XCTAssertFalse(skills.commands.contains { $0.name == "pdf" })
        await skills.install("nobody-xyz/nope", replace: false)
        XCTAssertEqual(skills.installError, "nobody-xyz/nope wasn't found (or is private).")
        let ok9 = await skills.uninstall(pdf)
        XCTAssertTrue(ok9)
        XCTAssertNil(skills.skill("pdf"))

        let plugins = CustomizePluginsModel(store: store)
        await plugins.load()
        XCTAssertEqual(plugins.phase, .ready)
        let listing = try await plugins.browse("anthropics/claude-plugins-official")
        XCTAssertGreaterThan(listing.plugins.count, 10)
        XCTAssertTrue(listing.plugins.contains { $0.unsupported != nil })
        let target = try XCTUnwrap(listing.plugins.first { $0.name == "agent-sdk-dev" && $0.unsupported == nil })
        let ok10 = await plugins.install(target, from: "anthropics/claude-plugins-official")
        XCTAssertTrue(ok10)
        let id = "agent-sdk-dev@claude-plugins-official"
        let installed = try XCTUnwrap(plugins.plugin(id))
        XCTAssertFalse(installed.commands.isEmpty)
        XCTAssertTrue(plugins.known.contains("anthropics/claude-plugins-official"))
        await plugins.setEnabled(installed, false)
        await plugins.load()
        XCTAssertEqual(plugins.plugin(id)?.enabled, false)
        let ok11 = await plugins.uninstall(try XCTUnwrap(plugins.plugin(id)))
        XCTAssertTrue(ok11)
        XCTAssertNil(plugins.plugin(id))
        do { _ = try await plugins.browse("nobody-xyz/nope"); XCTFail("Unknown marketplace") }
        catch { XCTAssertEqual(error.localizedDescription, "nobody-xyz/nope wasn't found (or is private).") }
    }
}
