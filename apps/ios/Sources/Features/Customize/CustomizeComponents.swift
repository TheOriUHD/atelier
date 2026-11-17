import SwiftUI

// Small pieces shared by the Connectors, Skills and Plugins screens.

/// Where a screen's data is: loading, ready, failed (with a way to try again) or not offered by this older server.
enum CustomizePhase: Equatable, Sendable { case loading, ready, failed(String), unsupported }

/// The rows of a page that is not showing data yet: a spinner, the failure with Try again, or the calm "not on this server" state.
struct CustomizeStateRows: View {
    let phase: CustomizePhase
    let retry: () -> Void
    var body: some View {
        if phase != .ready {
            Section {
                Group {
                    switch phase {
                    case .loading: ProgressView().controlSize(.large).frame(maxWidth: .infinity, minHeight: 220)
                    case .failed(let message): InlineError(message: message, retry: retry)
                    case .unsupported: EmptyState(title: "Not available yet", symbol: "clock.arrow.circlepath", message: "This server doesn't support this yet.")
                    case .ready: EmptyView()
                    }
                }
                .listRowBackground(Color.clear).listRowSeparator(.hidden)
            }
        }
    }
}

/// A dot and a word: how a connector is doing. The word always says it; the colour only helps.
struct CustomizeStatusLine: View {
    let presentation: CustomizeStatusPresentation
    var extra: String?
    private var color: Color {
        switch presentation.tone { case .good: Theme.success; case .warn: Theme.waiting; case .bad: Theme.danger; case .neutral: Theme.inkMuted }
    }
    var body: some View {
        HStack(spacing: 6) {
            if presentation.busy { ProgressView().controlSize(.mini) } else { Circle().fill(color).frame(width: 7, height: 7).accessibilityHidden(true) }
            Text(presentation.label)
            if let extra, !extra.isEmpty { Text("·").accessibilityHidden(true); Text(extra) }
        }
        .font(.footnote).foregroundStyle(Theme.inkMuted).lineLimit(1)
        .accessibilityElement(children: .combine)
    }
}

/// The help under a field, or the reason it is not valid, in red.
struct CustomizeFooter: View {
    var text: String?
    var error: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let error, !error.isEmpty { Text(error).foregroundStyle(Theme.danger) }
            if let text, !text.isEmpty { Text(text) }
        }
    }
}

/// A full-width clay button as the last row of a form.
struct CustomizeSubmitRow: View {
    let title: String
    var busy = false
    var enabled = true
    var error: String?
    let action: () -> Void
    var body: some View {
        Section {
            Button(title, action: action)
                .buttonStyle(ClayButtonStyle(busy: busy))
                .disabled(!enabled || busy)
                .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
                .listRowBackground(Color.clear)
        } footer: {
            if let error, !error.isEmpty { Text(error).foregroundStyle(Theme.danger) }
        }
    }
}

/// A multi-line text field with its title above it, in the form's own look.
struct CustomizeTextBox: View {
    let title: String
    let placeholder: String
    @Binding var text: String
    var mono = false
    var lines = 3
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.footnote).foregroundStyle(Theme.inkMuted)
            TextField(placeholder, text: $text, axis: .vertical)
                .lineLimit(lines...(lines + 6))
                .textInputAutocapitalization(.never).autocorrectionDisabled()
                .font(mono ? .mono(.body) : .body)
        }
    }
}

/// A row that says what a thing is and, under it, what it does: the shape of a skill, a plugin or a tool in a list.
struct CustomizeItemRow: View {
    var symbol: String
    var tint: Color = Theme.clay
    let title: String
    var subtitle: String?
    var detail: String?
    var mono = false
    var value: String?
    var body: some View {
        HStack(spacing: 12) {
            IconTile(symbol: symbol, tint: tint)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(mono ? .mono(.subheadline) : .body).foregroundStyle(Theme.ink).lineLimit(1).truncationMode(.middle)
                if let subtitle, !subtitle.isEmpty { Text(subtitle).font(.footnote).foregroundStyle(Theme.inkMuted).lineLimit(2) }
                if let detail, !detail.isEmpty { Text(detail).font(.footnote).foregroundStyle(Theme.inkSecondary).lineLimit(1) }
            }
            Spacer(minLength: 8)
            if let value, !value.isEmpty { Text(value).font(.subheadline).foregroundStyle(Theme.inkMuted).lineLimit(1) }
        }
        .contentShape(Rectangle())
    }
}

/// A read-only block of long text: the full description of something, selectable.
struct CustomizeProse: View {
    let text: String
    var body: some View {
        Text(text).font(.body).foregroundStyle(Theme.ink).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
    }
}
