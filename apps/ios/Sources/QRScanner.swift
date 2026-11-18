import SwiftUI
import AVFoundation

/// The camera, looking for QR codes: the first one it reads is handed on once.
struct QRScanner: UIViewControllerRepresentable {
    let controls: ScannerControls
    let onCode: (String) -> Void
    let onUnavailable: (String) -> Void

    func makeUIViewController(context: Context) -> ScannerController {
        let controller = ScannerController()
        controller.controls = controls
        controller.onCode = onCode
        controller.onUnavailable = onUnavailable
        return controller
    }

    func updateUIViewController(_ controller: ScannerController, context: Context) {}

    final class ScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
        var onCode: (String) -> Void = { _ in }
        var onUnavailable: (String) -> Void = { _ in }
        var controls = ScannerControls()
        private let capture = CaptureSession()
        private var preview: AVCaptureVideoPreviewLayer?
        private var delivered = false
        /// The back cameras this phone has, by id, and the one in use.
        private var cameras: [String: AVCaptureDevice] = [:]
        private var current: AVCaptureDevice?

        override func viewDidLoad() {
            super.viewDidLoad()
            view.backgroundColor = .black
            PairingHaptics.shared.prepare()
            let found = ScannerLens.back()
            cameras = Dictionary(uniqueKeysWithValues: found.map { ($0.lens.id, $0.device) })
            // The main camera first: it is the one that reads a code held at arm's length.
            let start = found.first { $0.lens.kind == .wide } ?? found.first
            guard let device = start?.device ?? AVCaptureDevice.default(for: .video), let input = try? AVCaptureDeviceInput(device: device) else {
                onUnavailable("This device has no camera to scan with.")
                return
            }
            current = device
            // A phone with one back camera has nothing to choose, so it is shown nothing.
            controls.lenses = found.count > 1 ? found.map(\.lens) : []
            controls.selected = start?.lens.id
            controls.torchAvailable = device.hasTorch && device.isTorchAvailable
            controls.choose = { [weak self] lens in self?.select(lens) }
            controls.toggleTorch = { [weak self] in self?.setTorch(on: !(self?.controls.torchOn ?? false)) }
            let session = capture.session
            guard session.canAddInput(input) else { onUnavailable("The camera could not start."); return }
            session.addInput(input)
            let output = AVCaptureMetadataOutput()
            guard session.canAddOutput(output) else { onUnavailable("The camera could not start."); return }
            session.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: .main)
            output.metadataObjectTypes = [.qr]
            let layer = AVCaptureVideoPreviewLayer(session: session)
            layer.videoGravity = .resizeAspectFill
            view.layer.addSublayer(layer)
            preview = layer
        }

        override func viewDidLayoutSubviews() {
            super.viewDidLayoutSubviews()
            preview?.frame = view.bounds
        }

        override func viewWillAppear(_ animated: Bool) {
            super.viewWillAppear(animated)
            capture.start()
        }

        override func viewDidDisappear(_ animated: Bool) {
            super.viewDidDisappear(animated)
            setTorch(on: false)
            capture.stop()
        }

        /// Switches to another back camera while the scanner keeps running; the flashlight stays as the person left it.
        private func select(_ lens: ScannerLens) {
            guard let device = cameras[lens.id], device !== current else { return }
            UISelectionFeedbackGenerator().selectionChanged()
            let wasOn = controls.torchOn
            setTorch(on: false)
            current = device
            controls.selected = lens.id
            capture.use(device)
            controls.torchAvailable = device.hasTorch && device.isTorchAvailable
            if wasOn { setTorch(on: true) }
        }

        /// The flashlight, on only when the person turns it on (never by itself).
        private func setTorch(on: Bool) {
            guard let device = current else { return }
            if on, !(device.hasTorch && device.isTorchAvailable) { controls.torchOn = false; return }
            guard device.hasTorch, (try? device.lockForConfiguration()) != nil else { controls.torchOn = false; return }
            device.torchMode = on ? .on : .off
            device.unlockForConfiguration()
            if on != controls.torchOn { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
            controls.torchOn = on
        }

        nonisolated func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection) {
            let text = (objects.first as? AVMetadataMachineReadableCodeObject)?.stringValue
            MainActor.assumeIsolated {
                guard !delivered, let text else { return }
                delivered = true
                setTorch(on: false)
                PairingHaptics.shared.scanned()
                onCode(text)
            }
        }
    }
}

/// The capture session lives on its own queue: starting and stopping it blocks.
private final class CaptureSession: @unchecked Sendable {
    let session = AVCaptureSession()
    private let queue = DispatchQueue(label: "app.atelier.qr-scanner")
    /// Puts another camera in the place of the one in use.
    func use(_ device: AVCaptureDevice) {
        nonisolated(unsafe) let device = device
        queue.async { [session] in
            guard let input = try? AVCaptureDeviceInput(device: device) else { return }
            session.beginConfiguration()
            for old in session.inputs { session.removeInput(old) }
            if session.canAddInput(input) { session.addInput(input) }
            session.commitConfiguration()
        }
    }
    func start() { queue.async { [session] in if !session.isRunning { session.startRunning() } } }
    func stop() { queue.async { [session] in if session.isRunning { session.stopRunning() } } }
}

/// Asks the camera for a QR code from the person's computer (Settings › Account, the QR icon next to Profile).
struct QRScanSheet: View {
    let onLink: (PairingLink) -> Void
    @Environment(\.dismiss) private var dismiss
    /// Why the camera can't be used, and what to tell about a code that was read but isn't Atelier's.
    @State private var unavailableReason: String?
    @State private var hint: String?
    @State private var attempt = 0
    @State private var controls = ScannerControls()
    @State private var denied = AVCaptureDevice.authorizationStatus(for: .video) == .denied || AVCaptureDevice.authorizationStatus(for: .video) == .restricted
    @State private var allowed = AVCaptureDevice.authorizationStatus(for: .video) == .authorized

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if allowed, unavailableReason == nil {
                QRScanner(controls: controls, onCode: handle, onUnavailable: { unavailableReason = $0 }).id(attempt).ignoresSafeArea()
                frame
            } else {
                unavailable
            }
        }
        .overlay(alignment: .topLeading) {
            Button { dismiss() } label: { Image(systemName: "xmark").font(.system(size: 16, weight: .semibold)).foregroundStyle(.white).frame(width: 44, height: 44).glassEffect(.regular.interactive(), in: .circle) }
                .padding(16).accessibilityLabel("Close")
        }
        .overlay(alignment: .topTrailing) {
            if allowed, unavailableReason == nil, controls.torchAvailable {
                Button { controls.toggleTorch() } label: {
                    Image(systemName: controls.torchOn ? "flashlight.on.fill" : "flashlight.off.fill").font(.system(size: 18, weight: .semibold)).foregroundStyle(controls.torchOn ? .yellow : .white)
                        .frame(width: 44, height: 44).glassEffect(.regular.interactive(), in: .circle)
                }
                .padding(16).accessibilityLabel("Flashlight").accessibilityValue(controls.torchOn ? "On" : "Off")
                .transition(.opacity)
            }
        }
        .overlay(alignment: .bottom) {
            if allowed, unavailableReason == nil, controls.lenses.count > 1 { lensPicker.padding(.bottom, 36).transition(.opacity.combined(with: .move(edge: .bottom))) }
        }
        .animation(.smooth(duration: 0.25), value: controls.torchAvailable)
        .animation(.smooth(duration: 0.25), value: controls.lenses.count)
        .task { if !allowed, !denied { allowed = await AVCaptureDevice.requestAccess(for: .video); denied = !allowed } }
        .preferredColorScheme(.dark)
    }

    /// The back cameras to choose from, as the Camera app names them (0.5×, 1×, 2×…): only on a phone that has more than one.
    private var lensPicker: some View {
        HStack(spacing: 6) {
            ForEach(controls.lenses) { lens in
                let chosen = controls.selected == lens.id
                Button { controls.choose(lens) } label: {
                    Text(lens.label).font(.system(size: 14, weight: .semibold)).monospacedDigit()
                        .foregroundStyle(chosen ? .black : .white).frame(minWidth: 44, minHeight: 36)
                        .background(chosen ? AnyShapeStyle(.white) : AnyShapeStyle(.clear), in: Capsule())
                }
                .accessibilityLabel("\(lens.label) camera").accessibilityAddTraits(chosen ? .isSelected : [])
            }
        }
        .padding(5).glassEffect(.regular, in: .capsule)
        .animation(.smooth(duration: 0.2), value: controls.selected)
    }

    private var frame: some View {
        VStack(spacing: 22) {
            Spacer()
            RoundedRectangle(cornerRadius: 28, style: .continuous).stroke(.white.opacity(0.9), lineWidth: 3).frame(width: 240, height: 240)
            Text(hint ?? "Point the camera at the QR code on your computer.\nIt is in Settings, Account: the QR icon next to Profile.")
                .font(.subheadline).foregroundStyle(.white).multilineTextAlignment(.center).padding(.horizontal, 32)
            Spacer()
        }
    }

    private var unavailable: some View {
        VStack(spacing: 14) {
            Image(systemName: "camera").font(.system(size: 34)).foregroundStyle(.white.opacity(0.8))
            Text(unavailableReason ?? (denied ? "Atelier needs the camera to scan the code." : "Looking for the camera…")).font(.body).foregroundStyle(.white).multilineTextAlignment(.center)
            if denied { Button("Open Settings") { if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) } }.buttonStyle(.glassProminent) }
            if unavailableReason != nil || denied {
                Button("Paste a link instead") { if let text = UIPasteboard.general.string { handle(text) } }.foregroundStyle(.white.opacity(0.85))
            }
        }.padding(32)
    }

    private func handle(_ text: String) {
        guard let link = PairingLink.parse(text) else {
            hint = "That isn't a code from Atelier. On your computer, open Settings, Account and click the QR icon next to Profile."
            attempt += 1
            return
        }
        dismiss()
        onLink(link)
    }
}

/// One of the phone's back cameras, as the person picks it: the Camera app's own names for them.
struct ScannerLens: Identifiable, Equatable {
    enum Kind: Int { case ultraWide, wide, telephoto }
    let id: String
    let kind: Kind
    let label: String

    /// What the zoom of a telephone lens is called, from how much narrower its view is than the main camera's
    /// (fields of view in degrees): the nearest of the zooms phones come with.
    static func telephotoFactor(wideFieldOfView: Float, telephotoFieldOfView: Float) -> Int {
        guard wideFieldOfView > 0, telephotoFieldOfView > 0 else { return 2 }
        let ratio = tan(Double(wideFieldOfView) / 2 * .pi / 180) / tan(Double(telephotoFieldOfView) / 2 * .pi / 180)
        return [2, 3, 4, 5].min { abs(Double($0) - ratio) < abs(Double($1) - ratio) } ?? 2
    }

    /// The back cameras, widest first, each with its device. An iPad or a phone with one camera has one.
    @MainActor static func back() -> [(lens: ScannerLens, device: AVCaptureDevice)] {
        let session = AVCaptureDevice.DiscoverySession(deviceTypes: [.builtInUltraWideCamera, .builtInWideAngleCamera, .builtInTelephotoCamera], mediaType: .video, position: .back)
        let devices = session.devices
        let wide = devices.first { $0.deviceType == .builtInWideAngleCamera }
        let list: [(ScannerLens, AVCaptureDevice)] = devices.compactMap { device in
            switch device.deviceType {
            case .builtInUltraWideCamera: return (ScannerLens(id: device.uniqueID, kind: .ultraWide, label: "0.5×"), device)
            case .builtInWideAngleCamera: return (ScannerLens(id: device.uniqueID, kind: .wide, label: "1×"), device)
            case .builtInTelephotoCamera:
                let factor = telephotoFactor(wideFieldOfView: wide?.activeFormat.videoFieldOfView ?? 0, telephotoFieldOfView: device.activeFormat.videoFieldOfView)
                return (ScannerLens(id: device.uniqueID, kind: .telephoto, label: "\(factor)×"), device)
            default: return nil
            }
        }
        return list.sorted { $0.0.kind.rawValue < $1.0.kind.rawValue }.map { (lens: $0.0, device: $0.1) }
    }
}

/// What the sheet's buttons talk to the scanner through: the lenses to offer (none on a phone with one back camera), the one in
/// use, and the flashlight, which only the person turns on.
@MainActor @Observable final class ScannerControls {
    var lenses: [ScannerLens] = []
    var selected: String?
    var torchAvailable = false
    var torchOn = false
    @ObservationIgnored var choose: (ScannerLens) -> Void = { _ in }
    @ObservationIgnored var toggleTorch: () -> Void = {}
}
