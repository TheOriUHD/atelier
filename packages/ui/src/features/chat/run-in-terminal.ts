/**
 * Code blocks in a Code session get a Play button next to Copy: it sends the block to the session's terminal and runs
 * it there, opening the Terminal pane. The session provides the function (absent in Chat and Cowork, and while the
 * folder's computer is offline); only shell blocks offer it.
 */
import { createContext } from 'react';

export const RunInTerminal = createContext<((command: string) => void) | null>(null);

/** Shells' own fences, and PowerShell's: on Windows the terminal is PowerShell, where models write ```powershell. */
const SHELLS = new Set(['bash', 'sh', 'shell', 'zsh', 'fish', 'shellscript', 'shell-session', 'powershell', 'pwsh', 'ps1', 'ps', 'posh']);

/** Whether a code block's language is a shell script worth running as it is. */
export const isShellLanguage = (language: string): boolean => SHELLS.has(language.trim().toLowerCase());
