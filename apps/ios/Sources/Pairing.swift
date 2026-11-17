import Foundation

/// What a QR code on the person's computer holds (Settings › Account › Sign in your phone):
/// `atelier://pair?token=…&server=https://…&server=http://192.168.1.20:7340`. The token is a sign-in the person approved there,
/// good once and for five minutes; the addresses are where to find the server, best first.
struct PairingLink: Equatable {
    let token: String
    let addresses: [String]

    static func parse(_ text: String) -> PairingLink? {
        guard let components = URLComponents(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
              components.scheme == "atelier", components.host == "pair" else { return nil }
        let items = components.queryItems ?? []
        let token = items.first { $0.name == "token" }?.value ?? ""
        let addresses = items.filter { $0.name == "server" }.compactMap(\.value).filter { $0.hasPrefix("https://") || $0.hasPrefix("http://") }
        guard token.count >= 16, !addresses.isEmpty else { return nil }
        return PairingLink(token: token, addresses: addresses)
    }
}
