/** The keys of a session, for /help and the docs' reference (one list for both). */
export const KEY_HELP: [string, string][] = [
  ['Enter', 'Send (while a reply runs, it waits its turn)'],
  ['Ctrl+S', 'Send into the reply that is running'],
  ['Shift+Enter, Alt+Enter, Ctrl+J', 'A new line'],
  ['Esc', 'Stop the reply; twice on an empty box, go back to an earlier message'],
  ['Shift+Tab', 'Auto → Ask → Accept edits → Plan'],
  ['Tab', 'Take the suggested next message'],
  ['↑ / ↓', 'What you sent before; ↑ also takes back a waiting message; ↓ shows background tasks'],
  ['Ctrl+O', 'Show thinking, then every step in full'],
  ['Ctrl+T', 'Show or hide the task list'],
  ['Ctrl+R', 'Open another session'],
  ['Ctrl+G', 'Write the message in your editor'],
  ['Ctrl+V', 'Paste an image'],
  ['Ctrl+L', 'Print the transcript again'],
  ['@', 'A file in this folder'],
  ['!', 'Run a command here; its output goes with your next message'],
  ['Ctrl+C twice, Ctrl+D', 'Leave (a running reply goes on)'],
];
