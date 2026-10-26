import Foundation
import XCTest

@testable import AtelierComputer

/// Protocol.swift mirrors packages/protocol/src/computer.ts by hand; this keeps the two from drifting apart.
final class ProtocolParityTests: XCTestCase {
  private func contract() throws -> String {
    var url = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { url.deleteLastPathComponent() }
    let file = url.appendingPathComponent("packages/protocol/src/computer.ts")
    guard let text = try? String(contentsOf: file, encoding: .utf8) else {
      throw XCTSkip("computer.ts not found at \(file.path)")
    }
    return text
  }

  private func block(_ text: String, from start: String) throws -> Substring {
    let begin = try XCTUnwrap(text.range(of: start), "no \(start)")
    let end = try XCTUnwrap(text.range(of: "\n}", range: begin.upperBound..<text.endIndex))
    return text[begin.upperBound..<end.lowerBound]
  }

  private func matches(_ pattern: String, in text: Substring) throws -> [[String]] {
    let regex = try NSRegularExpression(pattern: pattern, options: [.anchorsMatchLines])
    let string = String(text)
    return regex.matches(in: string, range: NSRange(string.startIndex..., in: string)).map { match in
      (1..<match.numberOfRanges).map { String(string[Range(match.range(at: $0), in: string)!]) }
    }
  }

  func testMethods() throws {
    let methods = try block(contract(), from: "export interface ComputerMethods {")
    let names = try matches(#"^\s+'?([A-Za-z.]+)'?: \{ params:"#, in: methods).map { $0[0] }
    XCTAssertFalse(names.isEmpty)
    XCTAssertEqual(Set(names), Set(ComputerMethod.allCases.map(\.rawValue)))
  }

  func testErrorCodes() throws {
    let codes = try block(contract(), from: "export const ComputerErrorCode = {")
    let pairs = try matches(#"^\s+([A-Za-z]+): (-?\d+),"#, in: codes)
    let typescript = Dictionary(uniqueKeysWithValues: pairs.map { ($0[0], Int($0[1])!) })
    let swift = Dictionary(uniqueKeysWithValues: ComputerErrorCode.allCases.map { ($0.name, $0.rawValue) })
    XCTAssertEqual(typescript, swift)
  }

  func testVersion() throws {
    let text = try contract()
    let version = try matches(#"COMPUTER_PROTOCOL_VERSION = (\d+);"#, in: text[...]).first?.first
    XCTAssertEqual(version, String(ComputerProtocol.version))
  }

  func testNotifications() throws {
    let text = try contract()
    let names = try matches(#"\{ method: '([A-Za-z.]+)'; params:"#, in: text[...]).map { $0[0] }
    XCTAssertEqual(Set(names), Set(ComputerNotification.methods))
  }
}
