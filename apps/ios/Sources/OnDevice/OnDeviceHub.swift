import Foundation
import UIKit

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

    private static let defaults = UserDefaults.standard

    /// This device's own id and the id its models' provider has on the server: made once, kept.
    private var identity: DeviceLink.Identity {
        let device = Self.defaults.string(forKey: "onDeviceID") ?? UUID().uuidString.lowercased()
        Self.defaults.set(device, forKey: "onDeviceID")
        var provider = Self.defaults.string(forKey: "onDeviceProvider")
        if provider == nil {
            let alphabet = Array("abcdefghijklmnopqrstuvwxyz0123456789")
            provider = "u-" + String((0..<10).map { _ in alphabet.randomElement()! })
            Self.defaults.set(provider, forKey: "onDeviceProvider")
        }
        return DeviceLink.Identity(deviceID: device, name: UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone", providerID: provider!)
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
        guard store.signedIn, store.connected else { registered = false; status = .idle; stopLink(); return }
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
            } catch { status = .failed(error.localizedDescription); return }
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
        for attempt in 0..<12 {
            if link?.connected == true {
                do {
                    _ = try await store.rpc.call("personalProviders.save", [
                        "id": .string(identity.providerID), "type": .string("openai-compatible"), "name": .string("Models on \(identity.name)"),
                        "baseUrl": .string(DeviceLink.lentBaseURL), "enabled": .bool(true), "parallelRequests": .number(1),
                    ])
                    saved = true
                    break
                } catch {
                    if attempt == 11 { status = .failed(error.localizedDescription); return }
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
        if link?.connected == true, status == .ready || status == .connecting { Task { await sync(store) } }
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
