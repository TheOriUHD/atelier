// atelier-computer: the macOS computer-use helper. Computer protocol v1 over stdio (packages/protocol/src/computer.ts).
import AtelierComputer
import CoreFoundation
import Foundation

// main may go away mid-write; its stdin then reaches EOF and the helper exits cleanly.
signal(SIGPIPE, SIG_IGN)

let helper = Helper(output: .standardOutput())
helper.installSignalHandlers()
Thread.detachNewThread { helper.runStdin() }

// The main thread serves AppKit (NSWorkspace, NSRunningApplication and NSScreen update with the main run loop) and the
// main actor (keyboard layouts).
CFRunLoopRun()
