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
struct KeyboardProbe: UIViewRepresentable {
    @Binding var height: CGFloat

    func makeUIView(context: Context) -> Anchor {
        let anchor = Anchor()
        anchor.report = report
        return anchor
    }

    func updateUIView(_ anchor: Anchor, context: Context) { anchor.report = report }

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
        }

        required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

        override func layoutSubviews() {
            super.layoutSubviews()
            // From the keyboard's top down to the bottom of the screen, less the strip the home indicator already takes:
            // that strip is a safe area the page keeps, so only the rest is room to make.
            let reach = bounds.height - marker.frame.minY
            let height = reach > 0 ? max(0, (reach - (window?.safeAreaInsets.bottom ?? 0)).rounded()) : 0
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
