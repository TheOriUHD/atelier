import Foundation
import UIKit
import CryptoKit

/// Ties the models on this phone to the server the person is signed in to: the phone is registered as a device, lends its
/// models over the device link, and the server lists them as the person's own models on this phone only. The conversation
/// itself stays on the server; the phone only does the thinking, when it is asked to.
@MainActor @Observable final class OnDeviceHub {
    static let shared = OnDeviceHub()

    enum Status: Equatable {
        case idle
        case needsNewerServer
        case needsRealServer
        case connecting
        case ready
        case failed(String)
    }

    private(set) var status: Status = .idle
    private var link: DeviceLink?
    private var linkedAddress: String?
    /// Whether the server has been told, on this connection, which device it is (it forgets when the connection drops).
    private var registered = false
    private var working = false
    private var again = false

    /// What the hub is doing, for trying it on a device (`--e2e-send` builds print it).
    private func trace(_ text: String) {
        #if DEBUG || E2E
        NSLog("HUB %@", text)
        print("HUB \(text)")
        #endif
    }

    /// This device's own id and the id its models' provider has on the server. The id is kept in the Keychain, which
    /// survives deleting and installing the app again, and the provider's id comes from it: the same phone is the same
    /// device to the server, and no model list is left behind from an earlier install.
    private var identity: DeviceLink.Identity {
        let device = Self.stableDeviceID()
        let digest = SHA256.hash(data: Data(device.utf8))
        let alphabet = Array("abcdefghijklmnopqrstuvwxyz0123456789")
        let provider = "u-" + String(digest.prefix(10).map { alphabet[Int($0) % alphabet.count] })
        return DeviceLink.Identity(deviceID: device, name: UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone", providerID: provider)
    }

    private static func stableDeviceID() -> String {
        let base: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "app.atelier.mobile.device", kSecAttrAccount as String: "id"]
        var query = base
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var found: CFTypeRef?
        if SecItemCopyMatching(query as CFDictionary, &found) == errSecSuccess, let data = found as? Data, let id = String(data: data, encoding: .utf8), UUID(uuidString: id) != nil { return id }
        let id = UUID().uuidString.lowercased()
        var add = base
        add[kSecValueData as String] = Data(id.utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(add as CFDictionary, nil)
        return id
    }

    var providerID: String { identity.providerID }

    /// Makes what the server knows match what the phone holds: the link up when there are models to lend, the provider
    /// saved, its models refreshed. Safe to call whenever anything may have changed.
    func sync(_ store: AppStore) async {
        if working { again = true; return }
        working = true
        defer { working = false }
        repeat {
            again = false
            await syncOnce(store)
        } while again
    }

    private func syncOnce(_ store: AppStore) async {
        trace("sync: signedIn \(store.signedIn), connected \(store.connected), info \(store.info != .null), registered \(registered)")
        guard store.signedIn, store.connected else { registered = false; status = .idle; stopLink(); return }
        // What the server offers arrives just after the connection: until then there is nothing to decide.
        if store.info == .null, let fresh = try? await store.rpc.call("app.info") { store.info = fresh }
        guard store.info != .null else { status = .connecting; return }
        guard store.offers("deviceOnlyModels") else {
            status = store.authStatus["local"].bool ? .needsRealServer : .needsNewerServer
            stopLink()
            return
        }
        let installed = LocalModelStore.shared.installed
        let identity = self.identity
        // The server's idea of this connection is new each time it connects: say which device this is.
        if !registered {
            do {
                _ = try await store.rpc.call("devices.register", ["id": .string(identity.deviceID), "name": .string(identity.name), "platform": .string("ios")])
                registered = true
                trace("registered as a device")
            } catch { trace("register failed: \(error)"); status = .failed(error.localizedDescription); return }
        }
        if installed.isEmpty {
            // Nothing to lend: the provider goes from the server's lists, and the link closes.
            stopLink()
            _ = try? await store.rpc.call("personalProviders.remove", ["id": .string(identity.providerID)])
            status = .idle
            return
        }
        status = .connecting
        if link == nil || linkedAddress != store.address {
            stopLink()
            let fresh = DeviceLink(address: store.address, identity: identity)
            fresh.onChange = { [weak self] in Task { @MainActor in self?.linkChanged(store) } }
            link = fresh
            linkedAddress = store.address
            fresh.start()
        }
        // The server must have heard the link's hello before it takes the provider.
        var saved = false
        for attempt in 0..<50 {
            if link?.connected == true {
                do {
                    _ = try await store.rpc.call("personalProviders.save", [
                        "id": .string(identity.providerID), "type": .string("openai-compatible"), "name": .string("Models on \(identity.name)"),
                        "baseUrl": .string(DeviceLink.lentBaseURL), "enabled": .bool(true), "parallelRequests": .number(1),
                    ])
                    saved = true
                    trace("provider saved")
                    break
                } catch {
                    trace("save attempt \(attempt) failed: \(error)")
                    if attempt == 49 { status = .failed(error.localizedDescription); return }
                }
            }
            try? await Task.sleep(for: .milliseconds(500))
        }
        guard saved else { status = .failed("The server did not accept this \(identity.name) as a device."); return }
        _ = try? await store.rpc.call("personalProviders.refresh", ["id": .string(identity.providerID)])
        // A model this small does not call tools: the server is told, so it asks only for words.
        for spec in installed {
            _ = try? await store.rpc.call("prefs.set", ["path": .array([.string("personalModels"), .string("\(identity.providerID)/\(spec.id)"), .string("toolCalling")]), "value": .string("none")])
        }
        status = .ready
    }

    private func linkChanged(_ store: AppStore) {
        // The link coming back after a break: the server needs the provider checked again.
        trace("link is \(link?.connected == true ? "up" : "down"), status \(status)")
        if link?.connected == true, status != .ready { Task { await sync(store) } }
    }

    func stopLink() {
        link?.stop()
        link = nil
        linkedAddress = nil
    }

    var linkConnected: Bool { link?.connected == true }

    /// The app came back to the front: the link may have dropped while it was away.
    func foreground(_ store: AppStore) async {
        await sync(store)
    }
}
