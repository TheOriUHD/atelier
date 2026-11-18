import UIKit

/// What this phone tells the server about itself when it signs in by QR code, so the computer that showed the code can say
/// "Philipp's iPhone is logged in!" with "iPhone 17 Pro · Atelier 1.0" under it.
enum PairingDevice {
    /// Apple's hardware identifier (`iPhone18,1`) to the name on the box. A phone that is not listed says only what kind it is.
    static let models: [String: String] = [
        "iPhone12,1": "iPhone 11", "iPhone12,3": "iPhone 11 Pro", "iPhone12,5": "iPhone 11 Pro Max", "iPhone12,8": "iPhone SE (2nd generation)",
        "iPhone13,1": "iPhone 12 mini", "iPhone13,2": "iPhone 12", "iPhone13,3": "iPhone 12 Pro", "iPhone13,4": "iPhone 12 Pro Max",
        "iPhone14,4": "iPhone 13 mini", "iPhone14,5": "iPhone 13", "iPhone14,2": "iPhone 13 Pro", "iPhone14,3": "iPhone 13 Pro Max", "iPhone14,6": "iPhone SE (3rd generation)",
        "iPhone14,7": "iPhone 14", "iPhone14,8": "iPhone 14 Plus", "iPhone15,2": "iPhone 14 Pro", "iPhone15,3": "iPhone 14 Pro Max",
        "iPhone15,4": "iPhone 15", "iPhone15,5": "iPhone 15 Plus", "iPhone16,1": "iPhone 15 Pro", "iPhone16,2": "iPhone 15 Pro Max",
        "iPhone17,3": "iPhone 16", "iPhone17,4": "iPhone 16 Plus", "iPhone17,1": "iPhone 16 Pro", "iPhone17,2": "iPhone 16 Pro Max", "iPhone17,5": "iPhone 16e",
        "iPhone18,1": "iPhone 17 Pro", "iPhone18,2": "iPhone 17 Pro Max", "iPhone18,3": "iPhone 17", "iPhone18,4": "iPhone Air",
        "iPad16,1": "iPad mini (A17 Pro)", "iPad16,2": "iPad mini (A17 Pro)",
        "iPad15,7": "iPad (A16)", "iPad15,8": "iPad (A16)",
        "iPad14,8": "iPad Air 11-inch (M2)", "iPad14,9": "iPad Air 11-inch (M2)", "iPad14,10": "iPad Air 13-inch (M2)", "iPad14,11": "iPad Air 13-inch (M2)",
        "iPad15,3": "iPad Air 11-inch (M3)", "iPad15,4": "iPad Air 11-inch (M3)", "iPad15,5": "iPad Air 13-inch (M3)", "iPad15,6": "iPad Air 13-inch (M3)",
        "iPad16,8": "iPad Air 11-inch (M4)", "iPad16,9": "iPad Air 11-inch (M4)", "iPad16,10": "iPad Air 13-inch (M4)", "iPad16,11": "iPad Air 13-inch (M4)",
        "iPad16,3": "iPad Pro 11-inch (M4)", "iPad16,4": "iPad Pro 11-inch (M4)", "iPad16,5": "iPad Pro 13-inch (M4)", "iPad16,6": "iPad Pro 13-inch (M4)",
        "iPad17,1": "iPad Pro 11-inch (M5)", "iPad17,2": "iPad Pro 11-inch (M5)", "iPad17,3": "iPad Pro 13-inch (M5)", "iPad17,4": "iPad Pro 13-inch (M5)",
    ]

    /// The hardware identifier of this device (a simulator says which device it pretends to be).
    static var identifier: String {
        if let simulated = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] { return simulated }
        var system = utsname()
        uname(&system)
        return withUnsafeBytes(of: &system.machine) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) }
    }

    /// "iPhone 17 Pro", or just "iPhone" / "iPad" for a model this list does not know yet.
    static func modelName(identifier: String, idiom: UIUserInterfaceIdiom) -> String {
        models[identifier] ?? (idiom == .pad ? "iPad" : "iPhone")
    }

    static func appVersion(_ bundle: Bundle = .main) -> String {
        (bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? ""
    }

    /// `auth.terminalPoll`'s `device`. The name is the one the person gave the phone when iOS lets an app see it (it often says
    /// only "iPhone"; the computer then puts the person's first name in front).
    @MainActor static var json: JSON {
        .obj([
            "name": .string(UIDevice.current.name),
            "model": .string(modelName(identifier: identifier, idiom: UIDevice.current.userInterfaceIdiom)),
            "appVersion": .string(appVersion()),
        ])
    }
}
