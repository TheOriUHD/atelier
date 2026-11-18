import Foundation

/// Where a Code session can work, organised as the web app's picker has it: first the place (this server, one of the person's
/// computers, the cloud, an SSH host), then a folder there. Plain data, so it can be tested without a view.
struct CodeTarget: Identifiable, Hashable, Sendable {
    enum Kind: Sendable { case server, computer, cloud, ssh }

    /// `server`, `device:<id>`, `cloud` or `ssh:<host>`.
    let id: String
    let kind: Kind
    let name: String
    /// Whether any folder there can be reached now. The server and the cloud are always up: they have nothing to be offline.
    let online: Bool
    /// The person's folders there, most recently used first (no scratch folders).
    let folders: [CodeWorkspace]

    static let serverID = "server"
    static let cloudID = "cloud"

    var symbol: String {
        switch kind {
        case .server: "externaldrive"
        case .computer: "laptopcomputer"
        case .cloud: "cloud"
        case .ssh: "server.rack"
        }
    }

    /// The first folder a session can start in there.
    var firstUsable: CodeWorkspace? { folders.first { $0.available } }

    /// Where a folder lives, as the web's `environmentOf`: a codespace is the cloud, a folder lent by a computer of the person's
    /// is that computer's (an SSH host reached through it too), an SSH host of the server's own is that host, and what is left
    /// is on the server itself.
    static func id(of workspace: CodeWorkspace) -> String {
        if workspace.kind == .codespace { return cloudID }
        if let device = workspace.deviceId, !device.isEmpty { return "device:\(device)" }
        if workspace.kind == .ssh, let host = workspace.host { return "ssh:\(host)" }
        return serverID
    }

    /// Every place to offer: the server first (it is where "No folder" starts), then the computers that have folders (the ones
    /// reachable now first), the cloud, and the SSH hosts the server reaches itself.
    static func targets(folders: [CodeWorkspace], devices: [JSON]) -> [CodeTarget] {
        let recent = CodeWorkspace.recent(folders.filter { !$0.scratch })
        let grouped = Dictionary(grouping: recent, by: { id(of: $0) })
        func make(_ id: String, _ kind: Kind, _ name: String, always: Bool = false) -> CodeTarget? {
            let list = grouped[id] ?? []
            guard always || !list.isEmpty else { return nil }
            return CodeTarget(id: id, kind: kind, name: name, online: always || list.contains { $0.available }, folders: list)
        }
        var computers: [CodeTarget] = []
        for id in recent.map({ Self.id(of: $0) }) where id.hasPrefix("device:") && !computers.contains(where: { $0.id == id }) {
            let device = String(id.dropFirst("device:".count))
            let found = devices.first { $0["id"].string == device }?["name"].string ?? ""
            if let target = make(id, .computer, found.isEmpty ? "Another computer" : found) { computers.append(target) }
        }
        // Reachable ones first; the order of use otherwise.
        computers = computers.filter(\.online) + computers.filter { !$0.online }
        var hosts: [CodeTarget] = []
        for id in recent.map({ Self.id(of: $0) }) where id.hasPrefix("ssh:") && !hosts.contains(where: { $0.id == id }) {
            if let target = make(id, .ssh, String(id.dropFirst("ssh:".count))) { hosts.append(target) }
        }
        return [make(serverID, .server, "This server", always: true)].compactMap { $0 } + computers + [make(cloudID, .cloud, "Cloud", always: true)].compactMap { $0 } + hosts
    }

    /// Where to start: the place the person used last, while it has a folder to work in (or is the server or the cloud);
    /// else the place of the most recent folder that can be reached.
    static func initial(_ targets: [CodeTarget], remembered: String?) -> CodeTarget? {
        if let remembered, let kept = targets.first(where: { $0.id == remembered }), kept.firstUsable != nil || kept.kind == .server { return kept }
        let latest = CodeWorkspace.recent(targets.flatMap(\.folders).filter(\.available)).first
        return latest.flatMap { folder in targets.first { $0.id == CodeTarget.id(of: folder) } } ?? targets.first
    }
}
