import SwiftUI
import UIKit

/// What shows when something is drawn short of its edge: the window, and the plain containers UIKit puts between it and the
/// SwiftUI content (the root hosting view, the split view controller's view). They are opaque black in dark mode unless painted,
/// and every page that ever moved, shrank or gave way showed that black as a bar. Painted the page's own colour they show nothing.
enum PaperVoid {
    /// The page's colour, following light and dark.
    static let paper = UIColor { traits in UIColor(Theme.background).resolvedColor(with: traits) }

    /// Paints the window and every opaque-black view near the top of it, down to where the pages' own views begin.
    @MainActor static func paint(_ window: UIWindow) {
        window.backgroundColor = paper
        paintContainers(window, depth: 0)
    }

    @MainActor private static func paintContainers(_ view: UIView, depth: Int) {
        guard depth < 20 else { return }
        if isOpaqueBlack(view) { view.backgroundColor = paper }
        for subview in view.subviews { paintContainers(subview, depth: depth + 1) }
    }

    @MainActor private static var hooked = false

    /// Every SwiftUI hosting view (one per page, one per column) is opaque black until painted, and they are made all the time as
    /// the person moves between pages: this paints each as it joins the window, so no page ever has a black frame under it. Sheets,
    /// alerts and popovers are left as they are (their look is the presentation's).
    @MainActor static func paintHostingViewsAsTheyArrive() {
        guard !hooked, let original = class_getInstanceMethod(UIView.self, #selector(UIView.didMoveToWindow)), let replacement = class_getInstanceMethod(UIView.self, #selector(UIView.atelierDidMoveToWindow)) else { return }
        hooked = true
        method_exchangeImplementations(original, replacement)
        // SwiftUI's own hosting views do not always pass `didMoveToWindow` on, but their controllers lay out every time one is
        // shown or resized: a controller that hosts SwiftUI paints its view then.
        if let layout = class_getInstanceMethod(UIViewController.self, #selector(UIViewController.viewDidLayoutSubviews)), let swapped = class_getInstanceMethod(UIViewController.self, #selector(UIViewController.atelierViewDidLayoutSubviews)) {
            method_exchangeImplementations(layout, swapped)
        }
    }

    /// Whether the view is filled with solid black (the system's dark background), as these containers are by default.
    @MainActor static func isOpaqueBlack(_ view: UIView) -> Bool {
        guard let color = view.backgroundColor?.resolvedColor(with: view.traitCollection) else { return false }
        var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
        guard color.getRed(&red, green: &green, blue: &blue, alpha: &alpha) else { return false }
        return alpha > 0.99 && red < 0.01 && green < 0.01 && blue < 0.01
    }
}

extension UIView {
    /// What `didMoveToWindow` does after the hook (the two are exchanged, so this calls the original).
    @objc fileprivate func atelierDidMoveToWindow() {
        atelierDidMoveToWindow()
        guard window != nil, NSStringFromClass(type(of: self)).contains("HostingView") else { return }
        MainActor.assumeIsolated {
            if PaperVoid.isOpaqueBlack(self), KeyboardProbe.presentation(of: self) == nil { backgroundColor = PaperVoid.paper }
        }
    }
}

extension UIViewController {
    @objc fileprivate func atelierViewDidLayoutSubviews() {
        atelierViewDidLayoutSubviews()
        guard isViewLoaded, view.window != nil, NSStringFromClass(type(of: self)).contains("HostingController") else { return }
        MainActor.assumeIsolated {
            if PaperVoid.isOpaqueBlack(view), KeyboardProbe.presentation(of: view) == nil { view.backgroundColor = PaperVoid.paper }
        }
    }
}
