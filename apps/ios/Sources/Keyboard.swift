import SwiftUI
import UIKit

private struct KeyboardHeightKey: EnvironmentKey { static let defaultValue: CGFloat = 0 }

extension EnvironmentValues {
    /// How much room the on-screen keyboard takes above the bottom safe area: zero when there is none.
    var keyboardHeight: CGFloat {
        get { self[KeyboardHeightKey.self] }
        set { self[KeyboardHeightKey.self] = newValue }
    }
}

/// Reports where the keyboard really is, read from UIKit's keyboard layout guide.
///
/// SwiftUI keeps its own copy of the keyboard's height, and that copy can go stale: after the keyboard is taken away by
/// the system (a screenshot, another app, a call) the page stayed pushed up with nothing below it, and when the keyboard
/// changed height the box could end up a little under it. The layout guide is what UIKit itself lays out against, so it is
/// always right; a screen that uses this ignores SwiftUI's keyboard inset and makes its own room from this height.
///
/// The measuring view lives on the window, not in the page: it must not be a size the page decides, or the page and the
/// measurement would feed each other.
///
/// The keyboard is one thing for the whole window, but it is not always the page's: on an iPad the list beside the page
/// has a search field of its own, and when that one has the keyboard the page must stay as it is. So a height is only
/// reported while the field that has the keyboard belongs to the page (`Anchor` is the page's own frame: put the probe
/// as the page's background).
///
/// "Belongs" is decided by presentation, not by where the field is drawn: the text field of an alert, a sheet or a popover
/// floats over the page, but its keyboard is that presentation's, and a page that took it for its own lifted its whole
/// content away from under it (the new-chat page when "New project…" asks for a name).
struct KeyboardProbe: UIViewRepresentable {
    @Binding var height: CGFloat

    func makeUIView(context: Context) -> Anchor {
        let anchor = Anchor()
        anchor.report = report
        return anchor
    }

    func updateUIView(_ anchor: Anchor, context: Context) { anchor.report = report }

    /// The alert, sheet or popover a view is in (the nearest controller up the chain that was presented), or nil for what is
    /// on the screen itself.
    static func presentation(of responder: UIResponder?) -> UIViewController? {
        var current = responder
        while let next = current {
            if let controller = next as? UIViewController, controller.presentingViewController != nil { return controller }
            current = next.next
        }
        return nil
    }

    private var report: (CGFloat, Animation?) -> Void {
        { new, animation in withAnimation(animation) { height = new } }
    }

    /// Takes the keyboard observers off when the probe goes.
    private final class Observers: @unchecked Sendable {
        var list: [NSObjectProtocol] = []
        deinit { list.forEach(NotificationCenter.default.removeObserver) }
    }

    /// Nothing to see in the page: it puts the measuring view on the window while it is there, and takes it off after.
    final class Anchor: UIView {
        var report: ((CGFloat, Animation?) -> Void)? { didSet { probe?.report = report } }
        private var probe: Probe?

        override init(frame: CGRect) {
            super.init(frame: .zero)
            isUserInteractionEnabled = false
            isHidden = true
        }

        required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

        override func didMoveToWindow() {
            super.didMoveToWindow()
            probe?.removeFromSuperview()
            probe = nil
            guard let window else { return }
            let probe = Probe(frame: window.bounds)
            probe.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            probe.report = report
            probe.page = { [weak self] in
                guard let self, self.window != nil else { return nil }
                return self.convert(self.bounds, to: nil)
            }
            probe.owner = { [weak self] in self }
            window.addSubview(probe)
            self.probe = probe
        }

        override func willMove(toWindow newWindow: UIWindow?) {
            super.willMove(toWindow: newWindow)
            if newWindow == nil { probe?.removeFromSuperview(); probe = nil }
        }
    }

    /// As big as the window and invisible. A marker inside it sits on the top edge of the keyboard layout guide.
    final class Probe: UIView {
        var report: ((CGFloat, Animation?) -> Void)?
        /// Where the page is, in window coordinates.
        var page: (() -> CGRect?)?
        /// A view of the page (the anchor): what a field has to share its presentation with to be the page's.
        var owner: (() -> UIView?)?
        private let marker = UIView()
        private var last: CGFloat = 0
        private var announcedUntil = Date.distantPast
        private let observers = Observers()

        override init(frame: CGRect) {
            super.init(frame: frame)
            isUserInteractionEnabled = false
            backgroundColor = .clear
            marker.isUserInteractionEnabled = false
            marker.backgroundColor = .clear
            marker.translatesAutoresizingMaskIntoConstraints = false
            addSubview(marker)
            // With no keyboard the guide's top is this view's bottom edge, so the height is zero.
            keyboardLayoutGuide.usesBottomSafeArea = false
            NSLayoutConstraint.activate([
                marker.leadingAnchor.constraint(equalTo: leadingAnchor),
                marker.trailingAnchor.constraint(equalTo: trailingAnchor),
                marker.heightAnchor.constraint(equalToConstant: 1),
                marker.topAnchor.constraint(equalTo: keyboardLayoutGuide.topAnchor),
            ])
            // The keyboard says when it is about to move and for how long: what follows in that time is animated.
            let center = NotificationCenter.default
            for name in [UIResponder.keyboardWillShowNotification, UIResponder.keyboardWillHideNotification, UIResponder.keyboardWillChangeFrameNotification] {
                observers.list.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] note in
                    let duration = (note.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double) ?? 0.25
                    MainActor.assumeIsolated { self?.announcedUntil = Date().addingTimeInterval(max(0.35, duration + 0.15)) }
                })
            }
            // The keyboard can stay where it is while it passes from one field to another (the list's search to the page's
            // box): who has it is looked at again whenever a field starts or stops being edited.
            for name in [UITextField.textDidBeginEditingNotification, UITextField.textDidEndEditingNotification, UITextView.textDidBeginEditingNotification, UITextView.textDidEndEditingNotification] {
                observers.list.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                    MainActor.assumeIsolated { self?.setNeedsLayout() }
                })
            }
        }

        private var settling = false
        private func settleSoon() {
            guard !settling else { return }
            settling = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) { [weak self] in
                guard let self else { return }
                self.settling = false
                self.setNeedsLayout()
                self.layoutIfNeeded()
            }
        }

        /// Whether the field that has the keyboard is in the page. With no field known, the keyboard is taken as the page's.
        private func servesPage() -> Bool {
            guard let page = page?(), !page.isEmpty, let field = UIResponder.atelierFirstResponder as? UIView, field.window != nil, field.window === window else { return true }
            // A field in an alert, a sheet or a popover is that presentation's, wherever it floats.
            if let owner = owner?(), KeyboardProbe.presentation(of: field) !== KeyboardProbe.presentation(of: owner) { return false }
            return page.intersects(field.convert(field.bounds, to: nil))
        }

        required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

        override func layoutSubviews() {
            super.layoutSubviews()
            // From the keyboard's top down to the bottom of the screen, less the strip the home indicator already takes:
            // that strip is a safe area the page keeps, so only the rest is room to make.
            let reach = bounds.height - marker.frame.minY
            var height = reach > 0 ? max(0, (reach - (window?.safeAreaInsets.bottom ?? 0)).rounded()) : 0
            if height > 0, !servesPage() { height = 0 }
            // Whatever the keyboard is doing, it is looked at once more a moment later: a page that missed the last step of a
            // keyboard that came and went quickly must not stay lifted for a keyboard that is no longer there.
            if height > 0 || last > 0 { settleSoon() }
            guard abs(height - last) >= 0.5 else { return }
            last = height
            // The keyboard's own motion is a spring of this shape; while it is moving the page follows it, and while a finger
            // drags it down (no announcement, no UIKit animation) the page follows without any.
            let moving = UIView.inheritedAnimationDuration > 0 || Date() < announcedUntil
            let animation: Animation? = moving ? .interpolatingSpring(mass: 3, stiffness: 1000, damping: 500, initialVelocity: 0) : nil
            DispatchQueue.main.async { [weak self] in self?.report?(height, animation) }
        }
    }
}

extension View {
    /// The page's paper under everything, including where the keyboard goes: the keyboard's rounded top corners and the
    /// space it leaves when it goes away show this, not the black of the window.
    func paperBehind() -> some View {
        background { Theme.background.ignoresSafeArea(.all) }
    }
}

extension UIResponder {
    @MainActor private static weak var foundFirstResponder: UIResponder?

    @objc @MainActor private func atelierReportFirstResponder() { UIResponder.foundFirstResponder = self }

    /// Whatever has the keyboard right now, if anything: asked of the responder chain, which hands it to whoever holds it.
    @MainActor static var atelierFirstResponder: UIResponder? {
        foundFirstResponder = nil
        UIApplication.shared.sendAction(#selector(atelierReportFirstResponder), to: nil, from: nil, for: nil)
        return foundFirstResponder
    }
}

/// A page of the detail column that makes room for the keyboard when it is its own, and not for one that belongs to the
/// list beside it (see `KeyboardProbe`).
private struct RoomForItsKeyboard: ViewModifier {
    @State private var keyboard: CGFloat = 0

    func body(content: Content) -> some View {
        content
            .padding(.bottom, keyboard)
            .ignoresSafeArea(.keyboard, edges: .bottom)
            .background { KeyboardProbe(height: $keyboard).allowsHitTesting(false).accessibilityHidden(true) }
            .background { Theme.background.ignoresSafeArea(.all) }
    }
}

extension View {
    func roomForItsKeyboard() -> some View { modifier(RoomForItsKeyboard()) }
}
