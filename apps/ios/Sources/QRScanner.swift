import SwiftUI
import AVFoundation

/// The camera, looking for QR codes: the first one it reads is handed on once.
struct QRScanner: UIViewControllerRepresentable {
    let onCode: (String) -> Void
    let onUnavailable: (String) -> Void

    func makeUIViewController(context: Context) -> ScannerController {
        let controller = ScannerController()
        controller.onCode = onCode
        controller.onUnavailable = onUnavailable
        return controller
    }

    func updateUIViewController(_ controller: ScannerController, context: Context) {}

    final class ScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
        var onCode: (String) -> Void = { _ in }
        var onUnavailable: (String) -> Void = { _ in }
        private let capture = CaptureSession()
        private var preview: AVCaptureVideoPreviewLayer?
        private var delivered = false

        override func viewDidLoad() {
            super.viewDidLoad()
            view.backgroundColor = .black
            guard let device = AVCaptureDevice.default(for: .video), let input = try? AVCaptureDeviceInput(device: device) else {
                onUnavailable("This device has no camera to scan with.")
                return
            }
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
            capture.stop()
        }

        nonisolated func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection) {
            let text = (objects.first as? AVMetadataMachineReadableCodeObject)?.stringValue
            MainActor.assumeIsolated {
                guard !delivered, let text else { return }
                delivered = true
                UINotificationFeedbackGenerator().notificationOccurred(.success)
                onCode(text)
            }
        }
    }
}

/// The capture session lives on its own queue: starting and stopping it blocks.
private final class CaptureSession: @unchecked Sendable {
    let session = AVCaptureSession()
    private let queue = DispatchQueue(label: "app.atelier.qr-scanner")
    func start() { queue.async { [session] in if !session.isRunning { session.startRunning() } } }
    func stop() { queue.async { [session] in if session.isRunning { session.stopRunning() } } }
}

/// Asks the camera for a QR code from the person's computer (Settings › Account › Sign in your phone).
struct QRScanSheet: View {
    let onLink: (PairingLink) -> Void
    @Environment(\.dismiss) private var dismiss
    /// Why the camera can't be used, and what to tell about a code that was read but isn't Atelier's.
    @State private var unavailableReason: String?
    @State private var hint: String?
    @State private var attempt = 0
    @State private var denied = AVCaptureDevice.authorizationStatus(for: .video) == .denied || AVCaptureDevice.authorizationStatus(for: .video) == .restricted
    @State private var allowed = AVCaptureDevice.authorizationStatus(for: .video) == .authorized

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if allowed, unavailableReason == nil {
                QRScanner(onCode: handle, onUnavailable: { unavailableReason = $0 }).id(attempt).ignoresSafeArea()
                frame
            } else {
                unavailable
            }
        }
        .overlay(alignment: .topLeading) {
            Button { dismiss() } label: { Image(systemName: "xmark").font(.system(size: 16, weight: .semibold)).foregroundStyle(.white).frame(width: 44, height: 44).glassEffect(.regular.interactive(), in: .circle) }
                .padding(16).accessibilityLabel("Close")
        }
        .task { if !allowed, !denied { allowed = await AVCaptureDevice.requestAccess(for: .video); denied = !allowed } }
        .preferredColorScheme(.dark)
    }

    private var frame: some View {
        VStack(spacing: 22) {
            Spacer()
            RoundedRectangle(cornerRadius: 28, style: .continuous).stroke(.white.opacity(0.9), lineWidth: 3).frame(width: 240, height: 240)
            Text(hint ?? "Point the camera at the QR code on your computer.\nIt is in Settings, Account, Sign in your phone.")
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
            hint = "That isn't a code from Atelier. Open Settings, Account, Sign in your phone on your computer."
            attempt += 1
            return
        }
        dismiss()
        onLink(link)
    }
}
