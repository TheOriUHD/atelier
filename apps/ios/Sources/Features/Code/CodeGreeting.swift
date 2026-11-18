import Foundation

/// The line above the Code start page's box: a different one each time the page opens, most of them with the person's first name
/// and the rest without (when no name is known, the same lines without it). A few depend on the time of day.
enum CodeGreeting {
    /// `{name}` is the first name; a line is written so that it still reads well without it (`bare`).
    private struct Line {
        let withName: String
        let bare: String
        /// Hours (0…23) it fits, or all of them.
        var hours: ClosedRange<Int> = 0...23
    }

    private static let lines: [Line] = [
        Line(withName: "What are we building today, {name}?", bare: "What are we building today?"),
        Line(withName: "Ready when you are, {name}.", bare: "Ready when you are."),
        Line(withName: "What are we working on, {name}?", bare: "What are we working on?"),
        Line(withName: "What's the plan, {name}?", bare: "What's the plan?"),
        Line(withName: "Let's build something, {name}.", bare: "Let's build something."),
        Line(withName: "What shall we ship today, {name}?", bare: "What shall we ship today?"),
        Line(withName: "Where do we start, {name}?", bare: "Where do we start?"),
        Line(withName: "Got a bug to chase, {name}?", bare: "Got a bug to chase?"),
        Line(withName: "What needs fixing, {name}?", bare: "What needs fixing?"),
        Line(withName: "Back at it, {name}?", bare: "Back at it?"),
        Line(withName: "What's on the list today, {name}?", bare: "What's on the list today?"),
        Line(withName: "Point me at some code, {name}.", bare: "Point me at some code."),
        Line(withName: "{name}, what shall we tackle?", bare: "What shall we tackle?"),
        Line(withName: "What are we making, {name}?", bare: "What are we making?"),
        Line(withName: "What are we refactoring, {name}?", bare: "What are we refactoring?"),
        Line(withName: "Which repo today, {name}?", bare: "Which repo today?"),
        Line(withName: "Something to build or something to break, {name}?", bare: "Something to build or something to break?"),
        Line(withName: "Hello, {name}. What shall we code?", bare: "Hello. What shall we code?"),
        Line(withName: "Good morning, {name}. What are we building?", bare: "Good morning. What are we building?", hours: 5...11),
        Line(withName: "Good afternoon, {name}. What's next?", bare: "Good afternoon. What's next?", hours: 12...17),
        Line(withName: "Good evening, {name}. One more feature?", bare: "Good evening. One more feature?", hours: 18...23),
        Line(withName: "Burning the midnight oil, {name}?", bare: "Burning the midnight oil?", hours: 0...4),
        Line(withName: "Late night, {name}. What are we building?", bare: "Late night. What are we building?", hours: 0...4),
        Line(withName: "Coffee first, {name}? Then code.", bare: "Coffee first? Then code.", hours: 5...10),
    ]

    /// The lines that fit this hour, with the name put in (or left out when there is none).
    static func lines(name: String, hour: Int) -> [String] {
        let first = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return lines.filter { $0.hours.contains(hour) }.map { first.isEmpty ? $0.bare : $0.withName.replacingOccurrences(of: "{name}", with: first) }
    }

    @MainActor private static var last: String?

    /// One of them, chosen at random, and never the one shown the time before.
    @MainActor static func pick(name: String, hour: Int = Calendar.current.component(.hour, from: .now)) -> String {
        let all = lines(name: name, hour: hour)
        let choices = all.filter { $0 != last }
        let chosen = (choices.isEmpty ? all : choices).randomElement() ?? "What are we building today?"
        last = chosen
        return chosen
    }
}
