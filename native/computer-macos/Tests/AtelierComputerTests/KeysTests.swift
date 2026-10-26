import Carbon.HIToolbox
import CoreGraphics
import XCTest

@testable import AtelierComputer

final class KeysTests: XCTestCase {
  private func stroke(_ keys: [String], layout: KeyboardLayoutMap? = nil) throws -> KeyStroke {
    try KeyMap.resolve(keys, layout: layout)
  }

  private func code(_ keys: [String], layout: KeyboardLayoutMap? = nil) throws -> CGKeyCode? {
    try stroke(keys, layout: layout).keyCode
  }

  func testModifiersAndLetter() throws {
    let s = try stroke(["cmd", "shift", "t"])
    XCTAssertEqual(s.modifiers, [.command, .shift])
    XCTAssertEqual(s.keyCode, CGKeyCode(kVK_ANSI_T))
    XCTAssertEqual(s.flags, [.maskCommand, .maskShift])
  }

  func testModifierAliases() throws {
    XCTAssertEqual(try stroke(["command", "option", "control", "fn", "a"]).modifiers, [.command, .option, .control, .function])
    XCTAssertEqual(try stroke(["alt", "ctrl", "a"]).modifiers, [.option, .control])
    XCTAssertEqual(try stroke(["CMD", "Shift", "a"]).modifiers, [.command, .shift])
    XCTAssertEqual(try stroke(["cmd", "command", "a"]).modifiers, [.command])
    XCTAssertEqual(Modifier.option.flag, .maskAlternate)
    XCTAssertEqual(Modifier.function.flag, .maskSecondaryFn)
    XCTAssertEqual(Modifier.command.keyCode, 55)
    XCTAssertEqual(Modifier.shift.keyCode, 56)
    XCTAssertEqual(Modifier.option.keyCode, 58)
    XCTAssertEqual(Modifier.control.keyCode, 59)
    XCTAssertEqual(Modifier.function.keyCode, 63)
  }

  func testNamedKeys() throws {
    let expected: [String: Int] = [
      "return": kVK_Return, "enter": kVK_Return, "tab": kVK_Tab, "space": kVK_Space, "escape": kVK_Escape,
      "esc": kVK_Escape, "delete": kVK_Delete, "backspace": kVK_Delete, "forwarddelete": kVK_ForwardDelete,
      "forward_delete": kVK_ForwardDelete, "up": kVK_UpArrow, "down": kVK_DownArrow, "left": kVK_LeftArrow,
      "right": kVK_RightArrow, "arrowup": kVK_UpArrow, "ArrowLeft": kVK_LeftArrow, "home": kVK_Home, "end": kVK_End,
      "pageup": kVK_PageUp, "page_down": kVK_PageDown, "Return": kVK_Return, " ": kVK_Space,
    ]
    for (name, code) in expected {
      XCTAssertEqual(try self.code([name]), CGKeyCode(code), name)
    }
    XCTAssertEqual(InputController.escape, CGKeyCode(kVK_Escape))
  }

  func testFunctionKeys() throws {
    let codes = [
      kVK_F1, kVK_F2, kVK_F3, kVK_F4, kVK_F5, kVK_F6, kVK_F7, kVK_F8, kVK_F9, kVK_F10, kVK_F11, kVK_F12, kVK_F13,
      kVK_F14, kVK_F15, kVK_F16, kVK_F17, kVK_F18, kVK_F19, kVK_F20,
    ]
    for (index, code) in codes.enumerated() {
      let s = try stroke(["f\(index + 1)"])
      XCTAssertEqual(s.keyCode, CGKeyCode(code), "f\(index + 1)")
      XCTAssertTrue(s.keyFlags.contains(.maskSecondaryFn))
    }
    XCTAssertThrowsError(try stroke(["f21"]))
  }

  func testNavigationKeysCarryHardwareFlags() throws {
    XCTAssertEqual(try stroke(["up"]).keyFlags, [.maskSecondaryFn, .maskNumericPad])
    XCTAssertEqual(try stroke(["home"]).keyFlags, [.maskSecondaryFn])
    XCTAssertEqual(try stroke(["return"]).keyFlags, [])
    // A modifier's flag joins the key's own.
    XCTAssertEqual(try stroke(["shift", "left"]).flags, [.maskShift, .maskSecondaryFn, .maskNumericPad])
  }

  func testUSLettersDigitsAndPunctuation() throws {
    XCTAssertEqual(try code(["a"]), CGKeyCode(kVK_ANSI_A))
    XCTAssertEqual(try code(["A"]), CGKeyCode(kVK_ANSI_A), "case-insensitive, no implied shift")
    XCTAssertEqual(try stroke(["A"]).modifiers, [])
    XCTAssertEqual(try code(["z"]), CGKeyCode(kVK_ANSI_Z))
    XCTAssertEqual(try code(["0"]), CGKeyCode(kVK_ANSI_0))
    XCTAssertEqual(try code(["9"]), CGKeyCode(kVK_ANSI_9))
    XCTAssertEqual(try code(["-"]), CGKeyCode(kVK_ANSI_Minus))
    XCTAssertEqual(try code(["="]), CGKeyCode(kVK_ANSI_Equal))
    XCTAssertEqual(try code(["["]), CGKeyCode(kVK_ANSI_LeftBracket))
    XCTAssertEqual(try code(["\\"]), CGKeyCode(kVK_ANSI_Backslash))
    XCTAssertEqual(try code([";"]), CGKeyCode(kVK_ANSI_Semicolon))
    XCTAssertEqual(try code(["'"]), CGKeyCode(kVK_ANSI_Quote))
    XCTAssertEqual(try code(["/"]), CGKeyCode(kVK_ANSI_Slash))
    XCTAssertEqual(try code(["`"]), CGKeyCode(kVK_ANSI_Grave))
    XCTAssertEqual(try code(["comma"]), CGKeyCode(kVK_ANSI_Comma))
    XCTAssertEqual(try code(["period"]), CGKeyCode(kVK_ANSI_Period))
    XCTAssertEqual(try code(["minus"]), CGKeyCode(kVK_ANSI_Minus))
  }

  func testShiftedCharactersAddShift() throws {
    let question = try stroke(["cmd", "?"])
    XCTAssertEqual(question.keyCode, CGKeyCode(kVK_ANSI_Slash))
    XCTAssertEqual(question.modifiers, [.command, .shift])
    let plus = try stroke(["cmd", "+"])
    XCTAssertEqual(plus.keyCode, CGKeyCode(kVK_ANSI_Equal))
    XCTAssertEqual(plus.modifiers, [.command, .shift])
    // Shift already there: not twice.
    XCTAssertEqual(try stroke(["shift", "!"]).modifiers, [.shift])
  }

  func testOnlyModifiers() throws {
    let s = try stroke(["shift"])
    XCTAssertNil(s.keyCode)
    XCTAssertEqual(s.modifiers, [.shift])
  }

  func testRejectsUnknownAndAmbiguous() {
    for keys in [[], ["nosuchkey"], ["cmd", "a", "b"], ["hyperspace"], ["🙂"], Array(repeating: "shift", count: 9)] {
      XCTAssertThrowsError(try KeyMap.resolve(keys, layout: nil), "\(keys)") { error in
        XCTAssertEqual((error as? RPCError)?.code, ComputerErrorCode.invalidParams.rawValue)
      }
    }
  }

  /// A German (QWERTZ) layout: y and z swap, '-' sits where US has '/', '+' is unshifted and '/' is shift-7.
  private let german = KeyboardLayoutMap(
    plain: [
      "a": 0, "s": 1, "y": 6, "z": 16, "c": 8, "v": 9, "t": 17, "-": 44, "+": 30, "ü": 33, "ö": 41, "1": 18, "7": 26,
    ],
    shifted: ["/": 26, "?": 27, "!": 18])

  func testLettersFollowTheLayout() throws {
    XCTAssertEqual(try code(["cmd", "z"], layout: german), 16)
    XCTAssertEqual(try code(["cmd", "y"], layout: german), 6)
    XCTAssertEqual(try code(["ü"], layout: german), 33)
    XCTAssertEqual(try code(["Ö"], layout: german), 41)
    // A letter the layout lacks falls back to the US key.
    XCTAssertEqual(try code(["q"], layout: german), CGKeyCode(kVK_ANSI_Q))
  }

  func testPunctuationFollowsTheLayout() throws {
    XCTAssertEqual(try code(["-"], layout: german), 44)
    let plus = try stroke(["cmd", "+"], layout: german)
    XCTAssertEqual(plus.keyCode, 30)
    XCTAssertEqual(plus.modifiers, [.command], "unshifted on this layout")
    let slash = try stroke(["/"], layout: german)
    XCTAssertEqual(slash.keyCode, 26)
    XCTAssertEqual(slash.modifiers, [.shift])
    // Not on the layout at all: the US key.
    XCTAssertEqual(try code(["["], layout: german), CGKeyCode(kVK_ANSI_LeftBracket))
  }

  func testDigitsNeverPickUpShiftFromTheLayout() throws {
    // AZERTY: the digit row types symbols, digits need shift. The digit stays the US key, without shift.
    let azerty = KeyboardLayoutMap(plain: ["&": 18, "a": 12], shifted: ["1": 18])
    let one = try stroke(["cmd", "1"], layout: azerty)
    XCTAssertEqual(one.keyCode, CGKeyCode(kVK_ANSI_1))
    XCTAssertEqual(one.modifiers, [.command])
    XCTAssertEqual(try code(["a"], layout: azerty), 12)
  }

  func testCommandLayer() throws {
    // "Dvorak – QWERTY ⌘": under command the keys are QWERTY again.
    let dvorak = KeyboardLayoutMap(plain: ["c": 34], commandPlain: ["c": 8])
    XCTAssertEqual(try code(["c"], layout: dvorak), 34)
    XCTAssertEqual(try code(["cmd", "c"], layout: dvorak), 8)
  }

  func testClickModifiers() throws {
    XCTAssertEqual(try Helper.modifiers(["cmd", "shift", "cmd"]), [.command, .shift])
    XCTAssertThrowsError(try Helper.modifiers(["hyper"]))
  }

  @MainActor
  func testCurrentLayoutReadsWithoutCrashing() {
    // Reads the person's layout (read-only). A Latin layout types 'a' with one of the typing keys.
    guard let layout = KeyboardLayout.current(), layout.plain["a"] != nil else { return }
    // On a Latin layout every letter has its own key among the typing keys.
    let letters = "abcdefghijklmnopqrstuvwxyz".compactMap { layout.plain[$0] }
    XCTAssertEqual(letters.count, 26)
    XCTAssertEqual(Set(letters).count, 26)
    XCTAssertTrue(letters.allSatisfy { (0...50).contains(Int($0)) })
  }
}

final class KeyTextTests: XCTestCase {
  func testChunksOfTwenty() {
    let text = String(repeating: "x", count: 45)
    let pieces = KeyText.pieces(text)
    XCTAssertEqual(pieces.count, 3)
    guard case .text(let first) = pieces[0], case .text(let last) = pieces[2] else { return XCTFail() }
    XCTAssertEqual(first.count, 20)
    XCTAssertEqual(last.count, 5)
  }

  func testNeverSplitsASurrogatePair() {
    let text = String(repeating: "a", count: 19) + "😀" + "b"
    let pieces = KeyText.pieces(text)
    XCTAssertEqual(pieces.count, 2)
    guard case .text(let first) = pieces[0], case .text(let second) = pieces[1] else { return XCTFail() }
    XCTAssertEqual(first.count, 19)
    XCTAssertEqual(String(utf16CodeUnits: second, count: second.count), "😀b")
    for piece in pieces {
      if case .text(let units) = piece { XCTAssertLessThanOrEqual(units.count, KeyText.chunkLength) }
    }
  }

  func testLineBreaksAreReturn() {
    XCTAssertEqual(
      KeyText.pieces("ab\ncd\r\nef\rg\n"),
      [
        .text(Array("ab".utf16)), .newline, .text(Array("cd".utf16)), .newline, .text(Array("ef".utf16)), .newline,
        .text(Array("g".utf16)), .newline,
      ])
    XCTAssertEqual(KeyText.pieces("\n\n"), [.newline, .newline])
    XCTAssertEqual(KeyText.pieces(""), [])
  }
}
