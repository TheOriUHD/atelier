import Foundation

/// Debug builds can be started straight into a state, for looking at screens and for tests:
///   --demo <screen>                 canned data, no server (see Preview.swift)
///   --open settings/<page>          opens Settings on that page (the page ids of `SettingsPageID`)
///   --open conversation/<sheet>     opens a conversation's sheet (the screens that own sheets read this)
///   --autologin <address> <user> <password>   signs in on launch (a throwaway server, see scripts/live-server.mjs)
///   --role admin|user               the role the demo pretends to have
enum Launch {
    #if DEBUG
    private static var arguments: [String] { ProcessInfo.processInfo.arguments }
    static func value(_ flag: String) -> String? {
        guard let index = arguments.firstIndex(of: flag), index + 1 < arguments.count else { return nil }
        return arguments[index + 1]
    }
    static var openRoute: String? { value("--open") }
    static var role: String { value("--role") ?? "admin" }
    static var autologin: (address: String, user: String, password: String)? {
        guard let index = arguments.firstIndex(of: "--autologin"), index + 3 < arguments.count else { return nil }
        return (arguments[index + 1], arguments[index + 2], arguments[index + 3])
    }
    #else
    static func value(_ flag: String) -> String? { nil }
    static var openRoute: String? { nil }
    static var role: String { "user" }
    static var autologin: (address: String, user: String, password: String)? { nil }
    #endif

    /// The part of `--open` after `prefix/`: `Launch.route("settings")` for `--open settings/providers` is "providers".
    static func route(_ prefix: String) -> String? {
        guard let open = openRoute, open.hasPrefix(prefix + "/") else { return nil }
        return String(open.dropFirst(prefix.count + 1))
    }
}
