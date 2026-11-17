import SwiftUI
import QuickLook

/// A file a message carries: a picture shows in the conversation and opens full screen; a document shows as a card
/// that opens in Quick Look (and from there can be shared or saved).
struct AttachmentView: View {
    let part: JSON
    let store: AppStore
    var onReference: ((JSON) -> Void)?
    /// Where it sits in the width it is given: a person's own messages are on the right.
    var alignment: Alignment = .leading
    @State private var preview: URL?
    @State private var loading = false
    @State private var viewer = false
    @Environment(\.chatServer) private var chatServer

    private var isImage: Bool { part["type"].string == "image" }
    private var name: String { part["name"].string }
    private var server: String { chatServer.isEmpty ? store.address : chatServer }

    var body: some View {
        if isImage {
            Button { viewer = true } label: {
                BlobImage(blob: part["blob"].string, mime: part["mime"].string, maxHeight: 260, maxWidth: 280, corner: 16)
                    .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(Theme.hairline, lineWidth: 0.5))
            }
            .buttonStyle(.plain).accessibilityLabel(name.isEmpty ? "Attached picture" : "Attached picture \(name)").accessibilityHint("Opens it full screen")
            .fullScreenCover(isPresented: $viewer) { MediaViewer(items: [part], start: 0, onReference: onReference).environment(\.chatServer, server) }
            .frame(maxWidth: .infinity, alignment: alignment)
        } else {
            Button { open() } label: {
                HStack(spacing: 12) {
                    Image(systemName: "doc.text").font(.system(size: 18, weight: .light)).foregroundStyle(Theme.inkSecondary)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(name.isEmpty ? "File" : name).font(.subheadline).foregroundStyle(Theme.ink).lineLimit(1).truncationMode(.middle)
                        Text(Self.kind(name: name, mime: part["mime"].string)).font(.caption.weight(.semibold)).foregroundStyle(Theme.inkMuted)
                    }
                    if loading { ProgressView() }
                }
                .padding(.horizontal, 14).padding(.vertical, 10).frame(maxWidth: 260, alignment: .leading)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Theme.hairline, lineWidth: 0.5))
            }
            .buttonStyle(.plain).disabled(loading).accessibilityLabel("File \(name)").accessibilityHint("Opens it")
            .quickLookPreview($preview)
        }
    }

    private func open() {
        loading = true
        Task {
            defer { loading = false }
            do { preview = try await ChatBlobs.shared.file(sha: part["blob"].string, mime: part["mime"].string, name: name, server: server) }
            catch is CancellationError { return } catch { store.error = ChatError.text(error) }
        }
    }

    /// "PDF", "MD": the extension, else the type's subtype.
    static func kind(name: String, mime: String) -> String {
        let ext = URL(fileURLWithPath: name).pathExtension
        if !ext.isEmpty, ext.count <= 5 { return ext.uppercased() }
        return mime.split(separator: "/").last.map { String($0).uppercased() } ?? "FILE"
    }
}
