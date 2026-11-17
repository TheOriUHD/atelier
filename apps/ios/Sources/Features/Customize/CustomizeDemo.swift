import Foundation

#if DEBUG
/// Canned answers for the Connectors, Skills and Plugins screens, in the real shapes, so the real views run without a server
/// (`--demo settings --open settings/connectors`). It keeps state, so a switch that is flipped stays flipped.
///
/// `--state` picks what is on the server: nothing (`empty`), a lot with long names (`long`), or a failure for every call
/// (`error`, `offline`, `forbidden`, `unsupported`, `loading`). `--customize <route>` opens a page on launch (see `CustomizeLaunch`).
enum CustomizeDemo {
    static func respond(_ method: String, _ params: [String: JSON]) throws -> JSON? {
        let handled = method.hasPrefix("mcp.") || method.hasPrefix("connectors.") || method.hasPrefix("skills.") || method.hasPrefix("plugins.")
            || ["settings.get", "settings.set", "settings.reset", "secrets.set", "slash.list", "workspaces.list", "prefs.set"].contains(method)
        guard handled else { return nil }
        switch CustomizeLaunch.state {
        case "loading": throw CancellationError()
        case "error": throw MobileError.message("Your server answered with an error. Try again in a moment.")
        case "offline": throw MobileError.message("Not connected. Your draft is kept; reconnect before sending.")
        case "forbidden": throw MobileError.message("Only admins can do this.")
        case "unsupported": throw MobileError.message("Unknown method \(method)")
        default: break
        }
        return try CustomizeDemoServer.shared.handle(method, params)
    }
}

/// The server behind the demo: the admin's connectors with their status, the person's own, skills, plugins and a marketplace.
final class CustomizeDemoServer: @unchecked Sendable {
    static let shared = CustomizeDemoServer()
    private let lock = NSLock()
    private var servers: [String: JSON] = [:]
    private var states: [String: (state: String, error: String?, signIn: String?)] = [:]
    private var personal: [JSON] = []
    private var personalStates: [String: (state: String, error: String?, signIn: String?)] = [:]
    private var permissions: [String: [String]] = ["allow": [], "ask": [], "deny": []]
    private var skills: [JSON] = []
    private var plugins: [JSON] = []
    private var marketplaces: [String: JSON] = [:]
    private var nextID = 1
    let state = CustomizeLaunch.state

    private init() { seed() }

    /// Back to the starting data (tests, and a fresh launch).
    func reset() {
        lock.lock(); defer { lock.unlock() }
        servers = [:]; states = [:]; personal = []; personalStates = [:]; permissions = ["allow": [], "ask": [], "deny": []]
        skills = []; plugins = []; marketplaces = [:]; nextID = 1
        seed()
    }

    func handle(_ method: String, _ params: [String: JSON]) throws -> JSON? {
        lock.lock(); defer { lock.unlock() }
        let name = params["name"]?.string ?? ""
        let id = params["id"]?.string ?? ""
        switch method {
        case "settings.get":
            return ["effective": ["mcpServers": .object(servers), "permissions": permissionsJSON, "extraKnownMarketplaces": ["claude-plugins-official": ["source": ["source": "github", "repo": "anthropics/claude-plugins-official"]]]], "origins": [:], "projectRoot": .null, "errors": []]
        case "settings.set": apply(params["path"]?.array.map(\.string) ?? [], params["value"] ?? .null); return ["ok": true]
        case "settings.reset": apply(params["path"]?.array.map(\.string) ?? [], nil); return ["ok": true]
        case "secrets.set": return ["id": params["id"] ?? "x", "label": params["label"] ?? "", "kind": "token", "masked": "••••", "usedBy": [], "createdAt": 0, "rotatedAt": .null, "lastUsedAt": .null]
        case "mcp.status": return .array(statuses())
        case "mcp.test":
            if let status = statuses().first(where: { $0["name"].string == name && !$0["personal"].bool }) {
                if states[name]?.state == "connecting" { states[name] = ("ready", nil, nil) }
                return statuses().first { $0["name"].string == name && !$0["personal"].bool } ?? status
            }
            throw MobileError.message("There is no connector named \(name).")
        case "mcp.logs": return ["lines": .array(logLines(for: name))]
        case "mcp.signIn", "connectors.signIn":
            let target = method == "mcp.signIn" ? name : (personal.first { $0["id"].string == id }?["name"].string ?? "")
            if method == "mcp.signIn" { states[target] = ("error", nil, "waiting") } else { personalStates[target] = ("error", nil, "waiting") }
            return ["url": "https://example.com/authorize?response_type=code&client_id=demo&state=demo"]
        case "mcp.cancelSignIn": states[name] = ("error", nil, "needed"); return ["ok": true]
        case "mcp.signOut": states[name] = ("error", nil, "needed"); return ["ok": true]
        case "mcp.import": return .array(importEntries)
        case "connectors.import": throw MobileError.message("Import from Claude Code in the desktop app on the computer that has it.")
        case "connectors.list": return .array(personal.map { ["connector": $0, "clash": .bool($0["name"].string == "wiki")] })
        case "connectors.save": return try savePersonal(params)
        case "connectors.remove": personal.removeAll { $0["id"].string == id }; return ["ok": true]
        case "connectors.test":
            let target = personal.first { $0["id"].string == id }?["name"].string ?? ""
            if personalStates[target]?.state == "connecting" { personalStates[target] = ("ready", nil, nil) }
            return statuses().first { $0["name"].string == target && $0["personal"].bool } ?? .null
        case "connectors.logs": return ["lines": ["09:41:02 Connecting to the server.", "09:41:03 Ready, 3 tools."]]
        case "skills.list": return .array(skills)
        case "slash.list": return .array(skills.map { ["name": $0["name"], "description": $0["description"], "kind": "skill"] } + commands)
        case "workspaces.list":
            return [["id": "w1", "kind": "local", "name": "atelier", "root": "/Users/demo/atelier", "host": .null, "deviceId": "d1", "available": true, "scratch": false, "lastUsedAt": 0],
                    ["id": "w2", "kind": "ssh", "name": "home-lab", "root": "/srv/lab", "host": "lab", "deviceId": .null, "available": true, "scratch": false, "lastUsedAt": 0]]
        case "skills.install": return try installSkill(params)
        case "skills.uninstall":
            guard skills.contains(where: { $0["name"].string == name && $0["installed"] != .null }) else { throw MobileError.message("“\(name)” wasn't installed by Atelier.") }
            skills.removeAll { $0["name"].string == name }; return ["ok": true]
        case "plugins.list": return .array(plugins)
        case "plugins.setEnabled": setPlugin(id) { $0.setting("enabled", params["enabled"] ?? false) }; return ["ok": true]
        case "prefs.set": setPlugin(params["path"]?.array.last?.string ?? "") { $0.setting("enabled", params["value"] ?? false) }; return ["ok": true]
        case "plugins.uninstall":
            guard plugins.contains(where: { $0["id"].string == id && $0["source"].string == "atelier" }) else { throw MobileError.message("“\(id)” wasn't installed by Atelier.") }
            plugins.removeAll { $0["id"].string == id }; return ["ok": true]
        case "plugins.browse":
            let repo = params["repo"]?.string ?? ""
            guard let listing = marketplaces[repo] else { throw MobileError.message("\(repo) wasn't found (or is private).") }
            return listing
        case "plugins.install":
            let plugin = params["plugin"]?.string ?? ""
            plugins.append(["id": .string("\(plugin)@claude-plugins-official"), "name": .string(plugin), "description": "Installed from the marketplace.", "version": "1.0.0", "source": "atelier", "enabled": true, "skills": [.string("\(plugin):guide")], "commands": [], "agents": []])
            return ["id": .string("\(plugin)@claude-plugins-official")]
        default: return nil
        }
    }

    // MARK: Writes

    private func apply(_ path: [String], _ value: JSON?) {
        if path.count >= 2, path[0] == "mcpServers" {
            let server = path[1]
            if path.count == 2 {
                if let value { servers[server] = value; if states[server] == nil { states[server] = (value["auth"].string == "oauth" ? ("error", nil, "needed") : ("ready", nil, nil)) } }
                else { servers[server] = nil; states[server] = nil }
            } else if let current = servers[server] { servers[server] = current.setting(path[2], value ?? .null) }
        } else if path.count == 2, path[0] == "permissions", let list = value?.array.map(\.string) { permissions[path[1]] = list }
    }

    private func savePersonal(_ params: [String: JSON]) throws -> JSON {
        let name = params["name"]?.string ?? ""
        if servers[name] != nil { throw MobileError.message("An admin's connector is called \(name): choose another name.") }
        let id = params["id"]?.string ?? { defer { nextID += 1 }; return "p\(nextID)" }()
        func keys(_ key: String) -> JSON { .array((params[key] ?? .null).entries.map { JSON.string($0.0) }) }
        var connector: [String: JSON] = ["id": .string(id), "name": .string(name), "type": params["type"] ?? "http", "args": params["args"] ?? [], "envKeys": keys("env"), "headerKeys": keys("headers"), "enabled": params["enabled"] ?? true, "disabledTools": params["disabledTools"] ?? []]
        if let url = params["url"] { connector["url"] = url }
        if let command = params["command"] { connector["command"] = command }
        if let auth = params["auth"] { connector["auth"] = auth }
        if let i = personal.firstIndex(where: { $0["id"].string == id }) { personal[i] = .object(connector) } else {
            personal.append(.object(connector)); personalStates[name] = (connector["auth"] != nil ? ("error", nil, "needed") : ("ready", nil, nil))
        }
        return .object(connector)
    }

    private func installSkill(_ params: [String: JSON]) throws -> JSON {
        let source = params["source"]?.string ?? ""
        guard source.contains("/") else { throw MobileError.message("Use owner/repo, owner/repo@ref/path, or a github.com URL.") }
        if source.hasSuffix("/nope") { throw MobileError.message("\(source) wasn't found (or is private).") }
        let name = String(source.split(separator: "/").last ?? "skill").split(separator: "@").first.map(String.init) ?? "skill"
        if skills.contains(where: { $0["name"].string == name }) && !(params["replace"]?.bool ?? false) {
            throw MobileError.message("A skill named “\(name)” is already installed from somewhere else. Install again with replace to overwrite it.")
        }
        skills.removeAll { $0["name"].string == name }
        skills.append(["name": .string(name), "description": .string("Installed from \(source)."), "scope": "global", "manualOnly": false, "warnings": [], "installed": ["source": .string(source), "sha": "5d2c9e1a7b3f4c60", "installedAt": "2026-11-17T09:12:00.000Z"]])
        return ["installed": [.string(name)]]
    }

    private func setPlugin(_ id: String, _ change: (JSON) -> JSON) {
        if let i = plugins.firstIndex(where: { $0["id"].string == id }) { plugins[i] = change(plugins[i]) }
    }

    // MARK: Reads

    private var permissionsJSON: JSON { ["defaultMode": "auto", "allow": .array((permissions["allow"] ?? []).map { JSON.string($0) }), "ask": .array((permissions["ask"] ?? []).map { JSON.string($0) }), "deny": .array((permissions["deny"] ?? []).map { JSON.string($0) })] }

    private func statuses() -> [JSON] {
        var result: [JSON] = []
        for (name, config) in servers.sorted(by: { $0.key < $1.key }) {
            let enabled = config["enabled"] != .bool(false)
            let s = states[name] ?? ("ready", nil, nil)
            result.append(status(name: name, type: config["type"].string, state: enabled ? s.state : "disabled", error: s.error, signIn: enabled ? s.signIn : nil, tools: enabled && s.state == "ready" ? tools(for: name, disabled: config["disabledTools"].array.map(\.string)) : [], personal: false, device: nil))
        }
        for connector in personal {
            let name = connector["name"].string
            let s = personalStates[name] ?? ("ready", nil, nil)
            let enabled = connector["enabled"] != .bool(false)
            result.append(status(name: name, type: connector["type"].string, state: enabled ? s.state : "disabled", error: s.error, signIn: enabled ? s.signIn : nil, tools: enabled && s.state == "ready" ? tools(for: name, disabled: connector["disabledTools"].array.map(\.string)) : [], personal: true, device: s.state == "ready" && connector["type"].string == "stdio" ? "MacBook Pro" : nil))
        }
        return result
    }

    private func status(name: String, type: String, state: String, error: String?, signIn: String?, tools: [JSON], personal: Bool, device: String?) -> JSON {
        var json: [String: JSON] = ["name": .string(name), "type": .string(type), "state": .string(state), "tools": .array(tools)]
        if let error { json["error"] = .string(error) }
        if let signIn { json["signIn"] = .string(signIn) }
        if state == "ready" { json["protocolEra"] = "modern" }
        if personal { json["personal"] = true }
        if let device { json["device"] = .string(device) }
        return .object(json)
    }

    private func tools(for name: String, disabled: [String]) -> [JSON] {
        let base: [(String, String, Bool)]
        switch name {
        case "github": base = [("search_code", "Search code across repositories you can read.", true), ("get_file_contents", "Read a file or a folder from a repository.", true), ("list_issues", "List and filter issues in a repository.", true), ("create_issue", "Open a new issue in a repository.", false), ("add_issue_comment", "Comment on an issue or a pull request.", false), ("list_pull_requests", "List pull requests, newest first.", true), ("create_pull_request", "Open a pull request from a branch.", false), ("merge_pull_request", "Merge a pull request. Cannot be undone.", false), ("get_commit", "Read one commit with its diff.", true), ("list_workflow_runs", "List the latest GitHub Actions runs.", true), ("run_workflow", "Start a GitHub Actions workflow.", false), ("delete_branch", "Delete a branch from a repository.", false)]
        case "kitchen-sink": base = (1...60).map { ("tool_\(String(format: "%02d", $0))_\($0 % 7 == 0 ? "with_an_extremely_long_name_that_keeps_going_and_going_without_stopping" : "do_something")", $0 % 5 == 0 ? "This is a very long description that goes on for a while to check that the layout holds when a server writes a whole paragraph about what the tool does, when to use it, what it returns and what it must never be used for, so that nothing is cut off in the wrong place." : "Does something useful number \($0).", $0 % 3 == 0) }
        default: base = [("search", "Search the knowledge base.", true), ("read_page", "Read one page by its title.", true), ("update_page", "Change the text of a page.", false)]
        }
        return base.map { ["name": .string($0.0), "description": .string($0.1), "readOnly": .bool($0.2), "enabled": .bool(!disabled.contains($0.0))] }
    }

    private func logLines(for name: String) -> [JSON] {
        switch states[name]?.state {
        case "error": return ["09:41:02 Version negotiation probe failed: fetch failed", "09:41:03 Retrying in 2 s.", "09:41:06 Version negotiation probe failed: fetch failed", "09:41:11 Retrying in 4 s.", "09:41:19 Can't reach homeassistant.local:8123: that name doesn't resolve."]
        default: return ["09:38:20 Connecting to https://api.githubcopilot.com/mcp/", "09:38:21 Connected (MCP 2026-07-28).", "09:38:21 12 tools.", "09:52:07 The tool did not finish within 60 seconds and was cancelled."]
        }
    }

    private var commands: [JSON] {
        [["name": "agent-sdk-dev:new-sdk-app", "description": "Create and set up a new Agent SDK application", "kind": "command", "argumentHint": "[name]"], ["name": "review", "description": "Review the staged changes", "kind": "command", "argumentHint": "[focus]"]]
    }

    private var importEntries: [JSON] {
        [["name": "filesystem", "config": ["type": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/demo/notes"], "env": [:], "headers": [:], "enabled": true, "disabledTools": []], "secrets": [], "source": "~/.claude.json"],
         ["name": "sentry", "config": ["type": "http", "url": "https://mcp.sentry.dev/mcp", "args": [], "env": [:], "headers": ["Authorization": "Bearer sntrys_live_abcdef"], "enabled": true, "disabledTools": []], "secrets": [["headers", "Authorization"]], "source": ".mcp.json in atelier"],
         ["name": "github", "config": ["type": "http", "url": "https://api.githubcopilot.com/mcp/", "args": [], "env": [:], "headers": [:], "enabled": true, "disabledTools": []], "secrets": [], "source": "~/.claude.json"]]
    }

    // MARK: Seed

    private func seed() {
        let long = state == "long"
        if state == "empty" { seedMarketplace(); return }
        servers = [
            "github": ["type": "http", "url": "https://api.githubcopilot.com/mcp/", "headers": ["Authorization": "Bearer ${secret:mcp-github}"], "enabled": true, "disabledTools": ["delete_branch", "merge_pull_request"], "preset": "github", "args": [], "env": [:]],
            "cloudflare": ["type": "http", "url": "https://mcp.cloudflare.com/mcp", "headers": [:], "enabled": true, "disabledTools": [], "preset": "cloudflare", "auth": "oauth", "args": [], "env": [:]],
            "linear": ["type": "http", "url": "https://mcp.linear.app/mcp", "headers": [:], "enabled": true, "disabledTools": [], "preset": "linear", "auth": "oauth", "args": [], "env": [:]],
            "home-assistant": ["type": "http", "url": "http://homeassistant.local:8123/api/mcp", "headers": ["Authorization": "Bearer ${secret:mcp-home-assistant}"], "enabled": true, "disabledTools": [], "preset": "home-assistant", "args": [], "env": [:]],
            "team-wiki": ["type": "http", "url": "https://wiki.example.com/mcp", "headers": ["X-Team": "design"], "enabled": true, "disabledTools": [], "args": [], "env": [:]],
            "reports": ["type": "http", "url": "https://reports.example.com/mcp", "headers": [:], "enabled": true, "disabledTools": [], "args": [], "env": [:]],
            "notes-search": ["type": "http", "url": "https://notes.example.com/mcp", "headers": [:], "enabled": false, "disabledTools": [], "args": [], "env": [:]],
            "internal-docs-and-knowledge-base-search-production": ["type": "http", "url": "https://internal-docs.corp.example.com/knowledge-base/search/production/mcp?region=eu-central-1&team=platform", "headers": [:], "enabled": true, "disabledTools": [], "args": [], "env": [:]],
            "local-files": ["type": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/demo/notes"], "env": [:], "headers": [:], "enabled": true, "disabledTools": []],
        ]
        states = [
            "github": ("ready", nil, nil), "cloudflare": ("error", nil, "needed"), "linear": ("error", nil, "waiting"),
            "home-assistant": ("error", "Can't reach homeassistant.local:8123: that name doesn't resolve.", nil),
            "team-wiki": ("ready", nil, nil),
            "reports": ("error", "Version negotiation failed: the server requires authorization (HTTP 401)", nil),
            "notes-search": ("ready", nil, nil),
            "internal-docs-and-knowledge-base-search-production": ("connecting", nil, nil),
            "local-files": ("error", "This server runs a program on this machine (stdio), which only the desktop app does. Use its HTTP endpoint instead.", nil),
        ]
        permissions = ["allow": ["mcp__github__search_code", "mcp__github__get_file_contents"], "ask": [], "deny": ["mcp__github__create_pull_request"]]
        if long {
            servers["kitchen-sink"] = ["type": "http", "url": "https://kitchen.example.com/mcp", "headers": [:], "enabled": true, "disabledTools": [], "args": [], "env": [:]]
            states["kitchen-sink"] = ("ready", nil, nil)
            for n in 1...30 {
                let name = String(format: "service-%02d", n)
                servers[name] = ["type": .string(n % 4 == 0 ? "sse" : "http"), "url": .string("https://service-\(n).example.com/mcp"), "headers": [:], "enabled": .bool(n % 9 != 0), "disabledTools": [], "args": [], "env": [:]]
                states[name] = n % 7 == 0 ? ("error", "Can't reach service-\(n).example.com: it took too long to answer.", nil) : ("ready", nil, nil)
            }
        }
        personal = [
            ["id": "p1", "name": "my-notes", "type": "http", "url": "https://notes.mine.example.com/mcp", "args": [], "envKeys": [], "headerKeys": ["X-Api-Key"], "enabled": true, "disabledTools": []],
            ["id": "p2", "name": "home-server", "type": "stdio", "command": "npx", "args": ["-y", "@scope/home-mcp"], "envKeys": ["HOME_TOKEN"], "headerKeys": [], "enabled": true, "disabledTools": []],
            ["id": "p3", "name": "my-sso", "type": "http", "url": "https://sso.mine.example.com/mcp", "args": [], "envKeys": [], "headerKeys": [], "enabled": true, "disabledTools": [], "auth": "oauth"],
            ["id": "p4", "name": "wiki", "type": "http", "url": "https://wiki.mine.example.com/mcp", "args": [], "envKeys": [], "headerKeys": [], "enabled": true, "disabledTools": []],
        ]
        personalStates = [
            "my-notes": ("ready", nil, nil),
            "home-server": ("error", "It runs a program on your computer: allow it in Customize › Connectors in the Atelier desktop app there.", nil),
            "my-sso": ("error", nil, "needed"), "wiki": ("ready", nil, nil),
        ]
        skills = [
            ["name": "pdf", "description": "Use this skill whenever the user wants to do anything with PDF files: reading or extracting text and tables, merging, splitting, rotating, watermarks, forms, encryption and OCR on scanned pages.", "scope": "global", "manualOnly": false, "warnings": [], "installed": ["source": "anthropics/skills", "sha": "e4bb5d960d87126ff3b3a8af1a104b7db67560ba", "installedAt": "2026-11-12T08:30:00.000Z"]],
            ["name": "docx", "description": "Create, read and edit Word documents, with tables of contents, headings and tracked changes.", "scope": "global", "manualOnly": false, "warnings": [], "installed": ["source": "anthropics/skills", "sha": "e4bb5d960d87126ff3b3a8af1a104b7db67560ba", "installedAt": "2026-11-12T08:30:00.000Z"]],
            ["name": "release-notes", "description": "Draft release notes from the commits since the last tag. Use when asked for a changelog or release notes.", "scope": "project", "manualOnly": false, "warnings": ["The frontmatter isn’t valid YAML; only its name and description were read."], "installed": .null],
            ["name": "brand-voice", "description": "House style for everything we write: plain, short, sentence case, no jargon.", "scope": "global", "manualOnly": true, "warnings": [], "installed": .null],
            ["name": "agent-sdk-dev:sdk-guide", "description": "How to start an Agent SDK project.", "scope": "plugin", "manualOnly": false, "warnings": [], "installed": .null],
            ["name": "frontend-design:design-review", "description": "Review a UI for hierarchy, spacing and contrast.", "scope": "plugin", "manualOnly": false, "warnings": [], "installed": .null],
            ["name": "wake-up", "description": "Morning routine from the MacBook.", "scope": "global", "manualOnly": false, "warnings": [], "installed": .null, "device": "MacBook Pro"],
        ]
        if long {
            for n in 1...30 { skills.append(["name": .string("team-skill-\(n)-with-a-long-name-for-layout"), "description": "A long description that explains in detail what this skill does and when a conversation should load it, so a row must wrap onto more lines than it has room for without breaking the layout.", "scope": .string(n % 3 == 0 ? "project" : "global"), "manualOnly": .bool(n % 4 == 0), "warnings": [], "installed": .null]) }
        }
        plugins = [
            ["id": "agent-sdk-dev@claude-plugins-official", "name": "agent-sdk-dev", "description": "Claude Agent SDK Development Plugin", "version": "1.0.1", "source": "atelier", "enabled": true, "skills": ["agent-sdk-dev:sdk-guide"], "commands": ["agent-sdk-dev:new-sdk-app"], "agents": ["agent-sdk-dev:agent-sdk-verifier-py", "agent-sdk-dev:agent-sdk-verifier-ts"]],
            ["id": "frontend-design@claude-plugins-official", "name": "frontend-design", "description": "Frontend design skills for polished interfaces.", "version": "2.3.0", "source": "atelier", "enabled": true, "skills": ["frontend-design:design-review"], "commands": [], "agents": []],
            ["id": "legacy-tools@my-marketplace", "name": "legacy-tools", "description": "Old helper commands.", "version": "0.4.1", "source": "atelier", "enabled": false, "skills": [], "commands": ["legacy-tools:cleanup"], "agents": []],
            ["id": "superpowers@claude-plugins-official", "name": "superpowers", "description": "Planning and debugging workflows installed with Claude Code on the MacBook.", "version": "5.0.7", "source": "claude-code", "enabled": true, "skills": ["superpowers:planning", "superpowers:debugging"], "commands": [], "agents": [], "device": "MacBook Pro"],
        ]
        seedMarketplace()
    }

    private func seedMarketplace() {
        var list: [JSON] = [
            ["name": "agent-sdk-dev", "description": "Development kit for working with the Claude Agent SDK", "version": "1.0.1"],
            ["name": "frontend-design", "description": "Frontend design skills for polished interfaces.", "version": "2.3.0"],
            ["name": "commit-commands", "description": "Commands for git commit workflows including commit, push, and PR creation", "version": "1.2.0"],
            ["name": "security-guidance", "description": "Reminders about security when files are edited.", "version": ""],
            ["name": "42crunch-api-security-testing", "description": "Automate API security directly with 42Crunch: audit OpenAPI specs, detect vulnerabilities aligned with OWASP API Security risks, and apply fixes.", "version": "", "unsupported": "Plugins from “git-subdir” sources can't be installed yet."],
            ["name": "agentforce-adlc", "description": "Agentforce Agent Development Life Cycle: author, discover, scaffold, deploy, test, and optimize .agent files", "version": "", "unsupported": "Plugins from “url” sources can't be installed yet."],
        ]
        if state == "long" { for n in 1...60 { list.append(["name": .string("community-plugin-\(n)"), "description": "A community plugin with a longer description that says what it adds and who it is for.", "version": .string("0.\(n).0")]) } }
        marketplaces["anthropics/claude-plugins-official"] = ["name": "claude-plugins-official", "plugins": .array(list)]
        marketplaces["acme/empty-market"] = ["name": "empty-market", "plugins": []]
    }
}
#endif
