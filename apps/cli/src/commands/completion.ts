/** `atelier completion <shell>`: completion for the subcommands and options. */
import { COMMAND_HELP, FLAGS } from '../args.ts';

const SUBCOMMANDS = [...new Set(COMMAND_HELP.map(([c]) => c.split(' ')[1]).filter((w): w is string => !!w && /^[a-z]/.test(w)))];
const OPTIONS = FLAGS.filter((f) => f.help).map((f) => `--${f.name}`);

export function completion(shell: string): string | null {
  switch (shell) {
    case 'bash':
      return `_atelier() {\n  local cur=\${COMP_WORDS[COMP_CWORD]}\n  if [[ $COMP_CWORD -eq 1 && $cur != -* ]]; then COMPREPLY=($(compgen -W "${SUBCOMMANDS.join(' ')}" -- "$cur"))\n  else COMPREPLY=($(compgen -W "${OPTIONS.join(' ')}" -- "$cur")); fi\n}\ncomplete -F _atelier atelier\n`;
    case 'zsh':
      return `#compdef atelier\n_atelier() {\n  if (( CURRENT == 2 )) && [[ $words[2] != -* ]]; then\n    compadd ${SUBCOMMANDS.join(' ')}\n  else\n    compadd -- ${OPTIONS.join(' ')}\n  fi\n}\ncompdef _atelier atelier\n`;
    case 'fish':
      return [...SUBCOMMANDS.map((c) => `complete -c atelier -n "__fish_use_subcommand" -a ${c}`), ...FLAGS.filter((f) => f.help).map((f) => `complete -c atelier -l ${f.name}${f.short ? ` -s ${f.short}` : ''} -d "${f.help.replace(/"/g, "'")}"`)].join('\n') + '\n';
    case 'pwsh':
    case 'powershell':
      return `Register-ArgumentCompleter -Native -CommandName atelier -ScriptBlock {\n  param($word)\n  @(${[...SUBCOMMANDS, ...OPTIONS].map((w) => `'${w}'`).join(', ')}) | Where-Object { $_ -like "$word*" } | ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) }\n}\n`;
    default:
      return null;
  }
}
