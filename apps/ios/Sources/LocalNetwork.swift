import Foundation
import Observation
import Darwin

/// Which addresses are "your own network": the only places the app talks to without HTTPS, because a desktop that shares
/// itself on the network serves plain HTTP there (`http://192.168.1.20:7340`). Anything on the internet needs HTTPS.
enum LocalAddress {
    static func isPrivateIPv4(_ octets: [UInt8]) -> Bool {
        guard octets.count == 4 else { return false }
        return octets[0] == 10 || (octets[0] == 172 && (16...31).contains(octets[1])) || (octets[0] == 192 && octets[1] == 168)
    }

    /// A private or loopback IPv4 address, `localhost`, or a `.local` name.
    static func isPrivateHost(_ host: String) -> Bool {
        let name = host.lowercased()
        if name == "localhost" || name.hasSuffix(".local") { return true }
        let parts = name.split(separator: ".", omittingEmptySubsequences: false).map { UInt8($0) }
        guard parts.count == 4, !parts.contains(nil) else { return false }
        let octets = parts.compactMap { $0 }
        return octets[0] == 127 || isPrivateIPv4(octets)
    }

    /// Whether the app may talk to this server address: HTTPS anywhere, HTTP only on the person's own network.
    static func allows(_ url: URL) -> Bool {
        guard let host = url.host else { return false }
        return url.scheme == "https" || (url.scheme == "http" && isPrivateHost(host))
    }
}

/// An Atelier server that answered on this network.
struct FoundServer: Identifiable, Equatable {
    let host: String
    let name: String
    let version: String
    /// What the app connects to: the server's own public (HTTPS) address when it says one, else its address here.
    let url: URL
    /// The app is new enough for this server, and the other way round.
    let compatible: Bool
    var id: String { host }
    var secure: Bool { url.scheme == "https" }
}

/// "Found on your network": no Bonjour, the way the desktop app and the terminal app do it. Each private /24 this device is
/// on is asked for `/api/health` on port 7340, where a desktop sharing itself listens. The first look makes iOS ask for
/// access to the local network; without it nothing answers.
@MainActor @Observable final class NetworkDiscovery {
    enum State: Equatable { case idle, scanning, finished }
    private(set) var state: State = .idle
    private(set) var found: [FoundServer] = []

    func scan() async {
        guard state != .scanning else { return }
        state = .scanning
        found = []
        let prefixes = Self.subnets()
        let results = await Self.probeAll(prefixes: prefixes)
        guard !Task.isCancelled else { return }
        found = results.sorted { $0.host.localizedStandardCompare($1.host) == .orderedAscending }
        state = .finished
    }

    /// The first three octets of each private /24 on a Wi-Fi or Ethernet interface, at most two.
    nonisolated static func subnets() -> [String] {
        var list: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&list) == 0, let first = list else { return [] }
        defer { freeifaddrs(list) }
        var prefixes: [String] = []
        for pointer in sequence(first: first, next: { $0.pointee.ifa_next }) {
            let entry = pointer.pointee
            guard let address = entry.ifa_addr, address.pointee.sa_family == UInt8(AF_INET), String(cString: entry.ifa_name).hasPrefix("en") else { continue }
            var buffer = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            guard getnameinfo(address, socklen_t(address.pointee.sa_len), &buffer, socklen_t(buffer.count), nil, 0, NI_NUMERICHOST) == 0 else { continue }
            let octets = String(cString: buffer).split(separator: ".").compactMap { UInt8($0) }
            guard LocalAddress.isPrivateIPv4(octets) else { continue }
            let prefix = octets.prefix(3).map(String.init).joined(separator: ".")
            if !prefixes.contains(prefix) { prefixes.append(prefix) }
        }
        return Array(prefixes.prefix(2))
    }

    nonisolated static func probeAll(prefixes: [String]) async -> [FoundServer] {
        let addresses = prefixes.flatMap { prefix in (1...254).map { "\(prefix).\($0)" } }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 1.5
        configuration.timeoutIntervalForResource = 2
        configuration.waitsForConnectivity = false
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        var results: [FoundServer] = []
        await withTaskGroup(of: FoundServer?.self) { group in
            var iterator = addresses.makeIterator()
            func more() { if let next = iterator.next() { group.addTask { await probe(next, session: session) } } }
            for _ in 0..<40 { more() }
            while let result = await group.next() {
                if let result { results.append(result) }
                more()
            }
        }
        return results
    }

    nonisolated static func probe(_ ip: String, session: URLSession) async -> FoundServer? {
        guard let url = URL(string: "http://\(ip):7340/api/health"),
              let (data, response) = try? await session.data(from: url),
              (response as? HTTPURLResponse)?.statusCode == 200, data.count < 2048,
              let health = try? JSONDecoder().decode(JSON.self, from: data), health["app"].string == "atelier",
              let local = URL(string: "http://\(ip):7340") else { return nil }
        let own = health["url"].stringOrNil.flatMap(URL.init(string:))
        let secure = own.flatMap { $0.scheme == "https" && ($0.path.isEmpty || $0.path == "/") ? $0 : nil }
        let name = health["name"].string
        return FoundServer(host: ip, name: name.isEmpty ? ip : name, version: health["version"].string, url: secure ?? local, compatible: health["mobileProtocol"].int == 1)
    }
}
