import AuthenticationServices
import UIKit

/// Opens a connector's sign-in page in the system's sign-in sheet (shares Safari's sign-ins, so a service you are already
/// signed in to asks for one tap). The server's own page says "Signed in" at the end; the app closes the sheet by itself as soon
/// as the server reports the connector signed in, and a person can close it earlier.
@MainActor final class CustomizeWebSignIn: NSObject {
    private var session: ASWebAuthenticationSession?
    private var anchor: CustomizeSignInAnchor?

    var isOpen: Bool { session != nil }

    /// `onEnd` runs once when the sheet closes, however it closed.
    func start(_ url: URL, onEnd: @escaping @Sendable () -> Void) {
        cancel()
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let windows = scenes.flatMap(\.windows)
        guard let window = windows.first(where: { $0.isKeyWindow }) ?? windows.first else { onEnd(); return }
        // The sign-in ends on the server's own page, never on a link back to the app, so no address is ever "the" callback.
        let session = ASWebAuthenticationSession(url: url, callback: .customScheme("atelier-signin-unused")) { _, _ in onEnd() }
        let anchor = CustomizeSignInAnchor(window)
        session.presentationContextProvider = anchor
        session.prefersEphemeralWebBrowserSession = false
        self.session = session
        self.anchor = anchor
        if !session.start() { cancel(); onEnd() }
    }

    func cancel() {
        session?.cancel()
        session = nil
        anchor = nil
    }
}

/// Tells the sign-in sheet which window to appear over.
@MainActor private final class CustomizeSignInAnchor: NSObject, ASWebAuthenticationPresentationContextProviding {
    private let window: UIWindow
    init(_ window: UIWindow) { self.window = window }

    nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        MainActor.assumeIsolated { window }
    }
}
