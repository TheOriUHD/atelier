import SwiftUI

/// A Code session's details: what it made, and where it works (the computer, the folder, the branch).
struct CodeSessionDetailsSheet: View {
    let store: AppStore
    let openArtifact: (JSON) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var folders: CodeFolders
    @State private var branch: String?

    init(store: AppStore, openArtifact: @escaping (JSON) -> Void) {
        self.store = store
        self.openArtifact = openArtifact
        _folders = State(initialValue: CodeFolders(store: store))
    }

    private var session: Conversation? { ChatNav.session(store) }
    private var workspace: CodeWorkspace? { session?.workspaceID.flatMap { id in folders.folders.first { $0.id == id } } }

    var body: some View {
        NavigationStack {
            List {
                if !store.artifacts.isEmpty {
                    Section("Outputs") {
                        ForEach(store.artifacts, id: \.self) { artifact in
                            Button { dismiss(); openArtifact(artifact) } label: {
                                HStack(spacing: 14) {
                                    Image(systemName: "doc.on.doc").font(.system(size: 18)).foregroundStyle(Theme.ink).frame(width: 26)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(artifact["title"].string.isEmpty ? "Untitled" : artifact["title"].string).foregroundStyle(Theme.ink).lineLimit(1)
                                        Text("Artifact").font(.subheadline).foregroundStyle(Theme.inkMuted)
                                    }
                                    Spacer(minLength: 8)
                                    Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Theme.inkMuted)
                                }.contentShape(Rectangle())
                            }
                        }
                    }
                }
                Section("Environment") {
                    if let workspace {
                        line("laptopcomputer", workspace.computer(devices: folders.devices))
                        line(workspace.kind == .codespace ? "cloud" : workspace.kind == .ssh ? "server.rack" : "folder", workspace.label)
                        if let branch { line("arrow.triangle.branch", branch) }
                    } else if !folders.didLoad, session?.workspaceID != nil {
                        HStack { Spacer(); ProgressView(); Spacer() }
                    } else {
                        line("folder.badge.questionmark", "No folder")
                    }
                }
            }
            .listStyle(.insetGrouped).scrollContentBackground(.hidden).background(Theme.sunken)
            .navigationTitle("Session details").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarLeading) { Button(role: .close) { dismiss() }.tint(Theme.ink) } }
        }
        .tint(Theme.clay)
        .presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
        .task {
            await folders.load(devices: true)
            guard let workspace, workspace.available, workspace.trusted else { return }
            if let status = try? await store.rpc.call("workspaces.gitStatus", ["workspaceId": .string(workspace.id)]), status != .null { branch = status["branch"].stringOrNil }
        }
    }

    private func line(_ symbol: String, _ text: String) -> some View {
        HStack(spacing: 14) {
            Image(systemName: symbol).font(.system(size: 18)).foregroundStyle(Theme.ink).frame(width: 26)
            Text(text).foregroundStyle(Theme.ink).lineLimit(1).truncationMode(.middle)
            Spacer(minLength: 0)
        }
    }
}
