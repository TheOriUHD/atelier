import SwiftUI
import UIKit

// MARK: - Showing panels from a menu
//
// A conversation's "…" menu is a SwiftUI `Menu`, and what is inside a menu can't hold sheets: it is gone the moment an
// item is chosen. So the Code entries show their panels the way UIKit does: a hosting controller presented from the
// topmost screen, as a sheet. The same way shows the SSH questions that come up while a folder is being added.

/// Wraps what is shown so it follows the app's appearance and tint like the rest of the app.
struct CodeHosted<Content: View>: View {
    @AppStorage("appearance") private var appearance = "system"
    @ViewBuilder var content: Content
    var body: some View {
        content
            .tint(Theme.clay)
            .preferredColorScheme(appearance == "dark" ? .dark : appearance == "light" ? .light : nil)
    }
}

@MainActor enum CodePresenter {
    /// Shows `content` as a sheet over whatever is on screen. Returns the controller, to dismiss it from outside.
    @discardableResult
    static func present<Content: View>(_ content: Content, detents: [UISheetPresentationController.Detent] = [.large()], modal: Bool = false, retries: Int = 6) -> UIViewController? {
        guard let top = topController() else { return nil }
        if top.isBeingPresented || top.isBeingDismissed {
            // Another sheet is still coming or going: try again in a moment.
            if retries > 0 { Task { try? await Task.sleep(for: .milliseconds(250)); present(content, detents: detents, modal: modal, retries: retries - 1) } }
            return nil
        }
        let host = UIHostingController(rootView: CodeHosted { content })
        host.modalPresentationStyle = .pageSheet
        host.isModalInPresentation = modal
        if let sheet = host.sheetPresentationController {
            sheet.detents = detents
            sheet.prefersGrabberVisible = !modal
            sheet.preferredCornerRadius = 28
        }
        top.present(host, animated: true)
        return host
    }

    static func topController() -> UIViewController? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let scene = scenes.first { $0.activationState == .foregroundActive } ?? scenes.first
        let window = scene?.windows.first { $0.isKeyWindow } ?? scene?.windows.first
        var top = window?.rootViewController
        while let presented = top?.presentedViewController, !presented.isBeingDismissed { top = presented }
        return top
    }
}

/// A confirmation that shows inside a sheet: toasts of the app sit behind sheets, so the Code screens show their own.
struct CodeToastModifier: ViewModifier {
    let store: AppStore
    func body(content: Content) -> some View {
        content
            .overlay(alignment: .bottom) {
                if let toast = store.toast {
                    Text(toast).font(.subheadline.weight(.medium)).padding(.horizontal, 16).padding(.vertical, 10)
                        .glassEffect(.regular, in: .capsule).padding(.bottom, 28)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                        .accessibilityAddTraits(.updatesFrequently)
                }
            }
            .animation(.snappy, value: store.toast)
    }
}
extension View {
    func codeToast(_ store: AppStore) -> some View { modifier(CodeToastModifier(store: store)) }
}

// MARK: - What the "…" menu offers

/// One panel of a Code session.
enum CodePanel: String, CaseIterable, Identifiable {
    case files, changes, git, terminal, plan, tasks, checkpoints, folder
    var id: String { rawValue }
    var title: String {
        switch self {
        case .files: "Files"
        case .changes: "Changes"
        case .git: "Git"
        case .terminal: "Terminal"
        case .plan: "Plan"
        case .tasks: "Background tasks"
        case .checkpoints: "Checkpoints"
        case .folder: "Folder"
        }
    }
    var symbol: String {
        switch self {
        case .files: "folder"
        case .changes: "plusminus"
        case .git: "arrow.triangle.branch"
        case .terminal: "terminal"
        case .plan: "list.bullet.clipboard"
        case .tasks: "square.stack.3d.up"
        case .checkpoints: "clock.arrow.circlepath"
        case .folder: "folder.badge.gearshape"
        }
    }

    @MainActor @ViewBuilder func view(store: AppStore) -> some View {
        switch self {
        case .files: CodeFilesPanel(store: store)
        case .changes: CodeChangesPanel(store: store)
        case .git: CodeGitPanel(store: store)
        case .terminal: CodeTerminalPanel(store: store)
        case .plan: CodePlanPanel(store: store)
        case .tasks: CodeTasksPanel(store: store)
        case .checkpoints: CodeCheckpointsPanel(store: store)
        case .folder: CodeFolderPanel(store: store)
        }
    }

    @MainActor func present(store: AppStore) {
        CodePresenter.present(view(store: store), detents: [.large()])
    }
}

/// The Code entries of a conversation's "…" menu: Files, Changes, Git, Terminal, Plan, Background tasks, Checkpoints and the
/// folder. Used inside a `Menu`; each opens its panel as a sheet.
struct CodeToolsMenu: View {
    let store: AppStore

    private var session: CodeSession { CodeSession(store: store) }
    private var running: Int { session.tasks.filter(\.running).count }

    var body: some View {
        if session.isCode {
            Section("Code") {
                ForEach([CodePanel.files, .changes, .git, .terminal]) { panel in
                    Button(panel.title, systemImage: panel.symbol) { panel.present(store: store) }
                }
            }
            Section {
                Button(running > 0 ? "Background tasks (\(running) running)" : CodePanel.tasks.title, systemImage: CodePanel.tasks.symbol) { CodePanel.tasks.present(store: store) }
                Button(CodePanel.plan.title, systemImage: CodePanel.plan.symbol) { CodePanel.plan.present(store: store) }
                Button(CodePanel.checkpoints.title, systemImage: CodePanel.checkpoints.symbol) { CodePanel.checkpoints.present(store: store) }
                Button("Move to another folder", systemImage: CodePanel.folder.symbol) { CodePanel.folder.present(store: store) }
            }
        }
    }
}

/// Wraps a panel's content in the navigation bar every panel has: a title and Done. A panel adds its own toolbar items.
struct CodePanelFrame<Content: View>: View {
    let title: String
    let store: AppStore
    @ViewBuilder var content: Content
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            content
                .background(Theme.sunken)
                .navigationTitle(title).navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        .tint(Theme.clay)
        .codeToast(store)
    }
}
