import XCTest
@testable import Atelier

@MainActor final class CodeGreetingTests: XCTestCase {
    func testTheNameGoesInWhereTheLineAsksForIt() {
        let named = CodeGreeting.lines(name: "Philipp", hour: 14)
        XCTAssertTrue(named.contains("What are we building today, Philipp?"))
        XCTAssertTrue(named.allSatisfy { !$0.contains("{") && !$0.contains("}") })
        XCTAssertTrue(named.contains { $0.contains("Philipp") })
    }

    func testWithoutANameEveryLineStillReadsWell() {
        for hour in [2, 8, 14, 20] {
            let bare = CodeGreeting.lines(name: "  ", hour: hour)
            XCTAssertFalse(bare.isEmpty)
            for line in bare {
                XCTAssertFalse(line.contains("{"), line)
                XCTAssertFalse(line.contains(", ?") || line.contains(" ,") || line.contains("  "), line)
                XCTAssertTrue(line.hasSuffix("?") || line.hasSuffix("."), line)
            }
        }
        XCTAssertTrue(CodeGreeting.lines(name: "", hour: 14).contains("What are we building today?"))
    }

    func testTimeOfDayLinesOnlyAppearWhenTheyFit() {
        let night = CodeGreeting.lines(name: "Mia", hour: 2)
        let morning = CodeGreeting.lines(name: "Mia", hour: 8)
        let afternoon = CodeGreeting.lines(name: "Mia", hour: 15)
        XCTAssertTrue(night.contains("Burning the midnight oil, Mia?"))
        XCTAssertFalse(morning.contains("Burning the midnight oil, Mia?"))
        XCTAssertTrue(morning.contains("Good morning, Mia. What are we building?"))
        XCTAssertFalse(afternoon.contains("Good morning, Mia. What are we building?"))
        XCTAssertTrue(afternoon.contains("Good afternoon, Mia. What's next?"))
        XCTAssertEqual(Set(afternoon).count, afternoon.count, "no line twice")
        XCTAssertGreaterThan(afternoon.count, 15, "plenty to choose from")
    }

    func testAPickIsOneOfThemAndNeverTheSameTwiceInARow() {
        var previous = ""
        var seen = Set<String>()
        for _ in 0..<60 {
            let line = CodeGreeting.pick(name: "Ada", hour: 11)
            XCTAssertTrue(CodeGreeting.lines(name: "Ada", hour: 11).contains(line))
            XCTAssertNotEqual(line, previous)
            previous = line
            seen.insert(line)
        }
        XCTAssertGreaterThan(seen.count, 8, "it varies")
    }
}
