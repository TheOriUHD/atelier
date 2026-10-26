import Carbon.HIToolbox
import CoreGraphics
import Foundation

/// A modifier key: pressed as a key of its own (flagsChanged) and carried in the flags of the events in between.
public enum Modifier: String, Sendable, CaseIterable {
  case command, shift, option, control, function

  public var keyCode: CGKeyCode {
    switch self {
    case .command: CGKeyCode(kVK_Command)
    case .shift: CGKeyCode(kVK_Shift)
    case .option: CGKeyCode(kVK_Option)
    case .control: CGKeyCode(kVK_Control)
    case .function: CGKeyCode(kVK_Function)
    }
  }

  public var flag: CGEventFlags {
    switch self {
    case .command: .maskCommand
    case .shift: .maskShift
    case .option: .maskAlternate
    case .control: .maskControl
    case .function: .maskSecondaryFn
    }
  }

  public static func named(_ name: String) -> Modifier? {
    switch name.lowercased() {
    case "cmd", "command", "meta", "super": .command
    case "shift": .shift
    case "alt", "option", "opt": .option
    case "ctrl", "control": .control
    case "fn", "function": .function
    default: nil
    }
  }

  public static func flags(_ modifiers: [Modifier]) -> CGEventFlags {
    modifiers.reduce(into: CGEventFlags()) { $0.insert($1.flag) }
  }
}

/// A resolved `key.press` / `key.hold`: the modifiers to hold, in order, and at most one key.
public struct KeyStroke: Equatable, Sendable {
  public var modifiers: [Modifier]
  /// nil when only modifiers are pressed.
  public var keyCode: CGKeyCode?
  /// Flags the key carries by itself, as the hardware sends them: `fn` for the function and navigation keys, and the
  /// numeric-pad flag for the arrows.
  public var keyFlags: CGEventFlags

  public init(modifiers: [Modifier], keyCode: CGKeyCode?, keyFlags: CGEventFlags = []) {
    self.modifiers = modifiers
    self.keyCode = keyCode
    self.keyFlags = keyFlags
  }

  public var modifierFlags: CGEventFlags { Modifier.flags(modifiers) }
  public var flags: CGEventFlags { modifierFlags.union(keyFlags) }
}

/// Which key types which character on the current keyboard layout, without and with shift; and the same with
/// command held (some layouts, such as "Dvorak – QWERTY ⌘", switch to another arrangement under command).
public struct KeyboardLayoutMap: Sendable, Equatable {
  public var plain: [Character: CGKeyCode]
  public var shifted: [Character: CGKeyCode]
  public var commandPlain: [Character: CGKeyCode]
  public var commandShifted: [Character: CGKeyCode]

  public init(
    plain: [Character: CGKeyCode], shifted: [Character: CGKeyCode] = [:],
    commandPlain: [Character: CGKeyCode]? = nil, commandShifted: [Character: CGKeyCode]? = nil
  ) {
    self.plain = plain
    self.shifted = shifted
    self.commandPlain = commandPlain ?? plain
    self.commandShifted = commandShifted ?? shifted
  }
}

public enum KeyMap {
  private static let functionKeys: [CGKeyCode] = [
    CGKeyCode(kVK_F1), CGKeyCode(kVK_F2), CGKeyCode(kVK_F3), CGKeyCode(kVK_F4), CGKeyCode(kVK_F5),
    CGKeyCode(kVK_F6), CGKeyCode(kVK_F7), CGKeyCode(kVK_F8), CGKeyCode(kVK_F9), CGKeyCode(kVK_F10),
    CGKeyCode(kVK_F11), CGKeyCode(kVK_F12), CGKeyCode(kVK_F13), CGKeyCode(kVK_F14), CGKeyCode(kVK_F15),
    CGKeyCode(kVK_F16), CGKeyCode(kVK_F17), CGKeyCode(kVK_F18), CGKeyCode(kVK_F19), CGKeyCode(kVK_F20),
  ]

  /// Keys by name (lowercase, without `_`, `-` or spaces), with the flags they carry by themselves.
  static let named: [String: (CGKeyCode, CGEventFlags)] = {
    let fn = CGEventFlags.maskSecondaryFn
    let arrow: CGEventFlags = [.maskSecondaryFn, .maskNumericPad]
    var keys: [String: (CGKeyCode, CGEventFlags)] = [
      "return": (CGKeyCode(kVK_Return), []),
      "enter": (CGKeyCode(kVK_Return), []),
      "tab": (CGKeyCode(kVK_Tab), []),
      "space": (CGKeyCode(kVK_Space), []),
      "spacebar": (CGKeyCode(kVK_Space), []),
      "escape": (CGKeyCode(kVK_Escape), []),
      "esc": (CGKeyCode(kVK_Escape), []),
      "delete": (CGKeyCode(kVK_Delete), []),
      "backspace": (CGKeyCode(kVK_Delete), []),
      "forwarddelete": (CGKeyCode(kVK_ForwardDelete), fn),
      "up": (CGKeyCode(kVK_UpArrow), arrow),
      "down": (CGKeyCode(kVK_DownArrow), arrow),
      "left": (CGKeyCode(kVK_LeftArrow), arrow),
      "right": (CGKeyCode(kVK_RightArrow), arrow),
      "home": (CGKeyCode(kVK_Home), fn),
      "end": (CGKeyCode(kVK_End), fn),
      "pageup": (CGKeyCode(kVK_PageUp), fn),
      "pagedown": (CGKeyCode(kVK_PageDown), fn),
    ]
    for direction in ["up", "down", "left", "right"] {
      keys["arrow" + direction] = keys[direction]
      keys[direction + "arrow"] = keys[direction]
    }
    for (index, code) in functionKeys.enumerated() {
      keys["f\(index + 1)"] = (code, fn)
    }
    return keys
  }()

  /// Punctuation by name, for callers that spell it out.
  static let punctuationNames: [String: Character] = [
    "minus": "-", "hyphen": "-", "dash": "-", "equal": "=", "equals": "=", "plus": "+",
    "leftbracket": "[", "bracketleft": "[", "rightbracket": "]", "bracketright": "]", "backslash": "\\",
    "semicolon": ";", "quote": "'", "apostrophe": "'", "comma": ",", "period": ".", "dot": ".", "slash": "/",
    "grave": "`", "backtick": "`", "backquote": "`",
  ]

  /// The US layout: which key types which character.
  static let usPlain: [Character: CGKeyCode] = {
    let pairs: [(Character, Int)] = [
      ("a", kVK_ANSI_A), ("b", kVK_ANSI_B), ("c", kVK_ANSI_C), ("d", kVK_ANSI_D), ("e", kVK_ANSI_E),
      ("f", kVK_ANSI_F), ("g", kVK_ANSI_G), ("h", kVK_ANSI_H), ("i", kVK_ANSI_I), ("j", kVK_ANSI_J),
      ("k", kVK_ANSI_K), ("l", kVK_ANSI_L), ("m", kVK_ANSI_M), ("n", kVK_ANSI_N), ("o", kVK_ANSI_O),
      ("p", kVK_ANSI_P), ("q", kVK_ANSI_Q), ("r", kVK_ANSI_R), ("s", kVK_ANSI_S), ("t", kVK_ANSI_T),
      ("u", kVK_ANSI_U), ("v", kVK_ANSI_V), ("w", kVK_ANSI_W), ("x", kVK_ANSI_X), ("y", kVK_ANSI_Y),
      ("z", kVK_ANSI_Z), ("0", kVK_ANSI_0), ("1", kVK_ANSI_1), ("2", kVK_ANSI_2), ("3", kVK_ANSI_3),
      ("4", kVK_ANSI_4), ("5", kVK_ANSI_5), ("6", kVK_ANSI_6), ("7", kVK_ANSI_7), ("8", kVK_ANSI_8),
      ("9", kVK_ANSI_9), ("-", kVK_ANSI_Minus), ("=", kVK_ANSI_Equal), ("[", kVK_ANSI_LeftBracket),
      ("]", kVK_ANSI_RightBracket), ("\\", kVK_ANSI_Backslash), (";", kVK_ANSI_Semicolon), ("'", kVK_ANSI_Quote),
      (",", kVK_ANSI_Comma), (".", kVK_ANSI_Period), ("/", kVK_ANSI_Slash), ("`", kVK_ANSI_Grave),
    ]
    return Dictionary(uniqueKeysWithValues: pairs.map { ($0.0, CGKeyCode($0.1)) })
  }()

  /// The US layout's shifted characters.
  static let usShifted: [Character: CGKeyCode] = {
    let pairs: [(Character, Character)] = [
      ("!", "1"), ("@", "2"), ("#", "3"), ("$", "4"), ("%", "5"), ("^", "6"), ("&", "7"), ("*", "8"), ("(", "9"),
      (")", "0"), ("_", "-"), ("+", "="), ("{", "["), ("}", "]"), ("|", "\\"), (":", ";"), ("\"", "'"),
      ("<", ","), (">", "."), ("?", "/"), ("~", "`"),
    ]
    return Dictionary(uniqueKeysWithValues: pairs.map { ($0.0, usPlain[$0.1]!) })
  }()

  /// Resolves `['cmd', 'shift', 't']` into the keys to press. Names are case-insensitive (`'T'` is the t key, not
  /// shift-t); a character that needs shift on the layout (`'?'`) adds shift. Letters and punctuation follow the
  /// current layout when there is one, so `['cmd', 'z']` is undo on a German keyboard too; otherwise, and for
  /// characters the layout doesn't have, the US arrangement.
  public static func resolve(_ keys: [String], layout: KeyboardLayoutMap?) throws -> KeyStroke {
    guard !keys.isEmpty else { throw RPCError.invalidParams("keys must not be empty") }
    guard keys.count <= 8 else { throw RPCError.invalidParams("at most 8 keys at once") }
    var modifiers: [Modifier] = []
    var others: [String] = []
    for name in keys {
      if let modifier = Modifier.named(name) {
        if !modifiers.contains(modifier) { modifiers.append(modifier) }
      } else {
        others.append(name)
      }
    }
    guard others.count <= 1 else {
      throw RPCError.invalidParams("one key besides the modifiers, not \(others.count): \(others.joined(separator: ", "))")
    }
    guard let name = others.first else { return KeyStroke(modifiers: modifiers, keyCode: nil) }
    guard let key = key(named: name, layout: layout, command: modifiers.contains(.command)) else {
      throw RPCError.invalidParams("unknown key \"\(name)\"")
    }
    if key.shift && !modifiers.contains(.shift) { modifiers.append(.shift) }
    return KeyStroke(modifiers: modifiers, keyCode: key.code, keyFlags: key.flags)
  }

  /// One key by name or character.
  static func key(named name: String, layout: KeyboardLayoutMap?, command: Bool = false)
    -> (code: CGKeyCode, flags: CGEventFlags, shift: Bool)?
  {
    if name.count == 1, let character = name.first {
      if character == " " { return (CGKeyCode(kVK_Space), [], false) }
      return key(for: character, layout: layout, command: command)
    }
    let normalized = name.lowercased().filter { $0 != "_" && $0 != "-" && $0 != " " }
    if let (code, flags) = named[normalized] { return (code, flags, false) }
    if let character = punctuationNames[normalized] { return key(for: character, layout: layout, command: command) }
    return nil
  }

  static func key(for raw: Character, layout: KeyboardLayoutMap?, command: Bool) -> (
    code: CGKeyCode, flags: CGEventFlags, shift: Bool
  )? {
    let character = raw.isLetter ? Character(raw.lowercased()) : raw
    if let layout {
      let plain = command ? layout.commandPlain : layout.plain
      let shifted = command ? layout.commandShifted : layout.shifted
      if let code = plain[character] { return (code, [], false) }
      // Letters and digits never add shift: a layout without them (Cyrillic, AZERTY's digit row) gets the US key.
      if !character.isLetter && !character.isNumber, let code = shifted[character] { return (code, [], true) }
    }
    if let code = usPlain[character] { return (code, [], false) }
    if let code = usShifted[character] { return (code, [], true) }
    return nil
  }
}

/// Typing text: runs of at most 20 UTF-16 units (a surrogate pair is never split), and line breaks as Return.
public enum KeyText {
  public enum Piece: Equatable, Sendable {
    case text([UniChar])
    case newline
  }

  public static let chunkLength = 20

  public static func pieces(_ text: String) -> [Piece] {
    var pieces: [Piece] = []
    var run: [UniChar] = []
    var previousCR = false
    func flush() {
      if !run.isEmpty { pieces.append(.text(run)) }
      run = []
    }
    for scalar in text.unicodeScalars {
      if scalar == "\n" || scalar == "\r" {
        // "\r\n" is one line break.
        if !(scalar == "\n" && previousCR) {
          flush()
          pieces.append(.newline)
        }
        previousCR = scalar == "\r"
        continue
      }
      previousCR = false
      let units = Array(String(scalar).utf16)
      if run.count + units.count > chunkLength { flush() }
      run.append(contentsOf: units)
    }
    flush()
    return pieces
  }
}

/// Reads the current keyboard layout (Text Input Sources must be used on the main thread).
@MainActor
public enum KeyboardLayout {
  /// The keys that type characters: letters, digits and punctuation, without the keypad.
  private static let typingKeys: [CGKeyCode] = {
    var codes: [CGKeyCode] = []
    for code in 0...50 where code != kVK_Return && code != kVK_Tab && code != kVK_Space {
      codes.append(CGKeyCode(code))
    }
    codes.append(CGKeyCode(kVK_JIS_Yen))
    codes.append(CGKeyCode(kVK_JIS_Underscore))
    return codes
  }()

  public static func current() -> KeyboardLayoutMap? {
    guard let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
      let raw = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData)
    else { return nil }
    let data = Unmanaged<CFData>.fromOpaque(raw).takeUnretainedValue()
    guard let bytes = CFDataGetBytePtr(data) else { return nil }
    return bytes.withMemoryRebound(to: UCKeyboardLayout.self, capacity: 1) { layout in
      let shift = UInt32(shiftKey >> 8) & 0xFF
      let command = UInt32(cmdKey >> 8) & 0xFF
      let map = KeyboardLayoutMap(
        plain: table(layout, modifiers: 0),
        shifted: table(layout, modifiers: shift),
        commandPlain: table(layout, modifiers: command),
        commandShifted: table(layout, modifiers: command | shift)
      )
      return map.plain.isEmpty ? nil : map
    }
  }

  private static func table(_ layout: UnsafePointer<UCKeyboardLayout>, modifiers: UInt32) -> [Character: CGKeyCode] {
    var table: [Character: CGKeyCode] = [:]
    let keyboardType = UInt32(LMGetKbdType())
    for code in typingKeys {
      var deadKeyState: UInt32 = 0
      var length = 0
      var chars = [UniChar](repeating: 0, count: 4)
      let status = UCKeyTranslate(
        layout, code, UInt16(kUCKeyActionDown), modifiers, keyboardType, OptionBits(kUCKeyTranslateNoDeadKeysMask),
        &deadKeyState, chars.count, &length, &chars)
      guard status == noErr, length > 0 else { continue }
      let string = String(utf16CodeUnits: chars, count: length)
      guard string.count == 1, let character = string.first,
        let scalar = character.unicodeScalars.first, scalar.value >= 0x20, scalar.value != 0x7F
      else { continue }
      // The first key that types it wins (keys are scanned in key-code order).
      if table[character] == nil { table[character] = code }
    }
    return table
  }
}
