/**
 * Colour for code in the terminal: a small tokenizer that knows comments, strings, numbers and each language family's
 * keywords and types, in the app's code colours. Not a parser; enough to read code at a glance.
 */
import type { Paint } from '../style.ts';

interface Lang {
  keywords: Set<string>;
  types?: Set<string>;
  line?: string[];
  block?: [string, string][];
  /** Strings: their delimiters. */
  quotes: string[];
}

const words = (s: string) => new Set(s.split(/\s+/).filter(Boolean));

const C_LIKE = { line: ['//'], block: [['/*', '*/']] as [string, string][], quotes: ['"', "'", '`'] };
const LANGS: Record<string, Lang> = {
  js: { ...C_LIKE, keywords: words('async await break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new of return static super switch this throw try typeof var void while with yield null undefined true false as satisfies'), types: words('Array Promise Map Set Record string number boolean unknown any never object void Error Date RegExp') },
  ts: { ...C_LIKE, keywords: words('async await break case catch class const continue declare default delete do else enum export extends finally for from function if implements import in instanceof interface keyof let namespace new of private protected public readonly return satisfies static super switch this throw try type typeof var void while yield null undefined true false as is infer abstract override'), types: words('Array Promise Map Set Record Partial Pick Omit string number boolean unknown any never object void Error Date RegExp bigint symbol') },
  py: { line: ['#'], quotes: ['"""', "'''", '"', "'"], keywords: words('and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield None True False self match case'), types: words('int str float bool list dict set tuple bytes object') },
  go: { ...C_LIKE, keywords: words('break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false iota'), types: words('int int8 int16 int32 int64 uint uint8 uint16 uint32 uint64 float32 float64 string bool byte rune error any') },
  rust: { ...C_LIKE, keywords: words('as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while None Some Ok Err'), types: words('i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str String Vec Option Result Box') },
  c: { ...C_LIKE, quotes: ['"', "'"], keywords: words('auto break case const continue default do else enum extern for goto if inline register restrict return sizeof static struct switch typedef union volatile while class namespace public private protected template typename virtual override new delete this using nullptr true false #include #define #ifdef #ifndef #endif #pragma'), types: words('int char float double long short unsigned signed void bool size_t uint8_t uint32_t int32_t std string vector') },
  glsl: { ...C_LIKE, quotes: ['"'], keywords: words('attribute const uniform varying buffer shared layout centroid flat smooth noperspective break continue do for while switch case default if else in out inout true false discard return struct precision highp mediump lowp #version #define #ifdef #endif #include'), types: words('float int uint bool vec2 vec3 vec4 ivec2 ivec3 ivec4 bvec2 bvec3 bvec4 mat2 mat3 mat4 sampler2D sampler3D samplerCube void') },
  java: { ...C_LIKE, quotes: ['"', "'"], keywords: words('abstract assert break case catch class const continue default do else enum extends final finally for goto if implements import instanceof interface native new package private protected public return static super switch synchronized this throw throws try void volatile while var val fun when object null true false override suspend data sealed'), types: words('int long short byte char float double boolean String Integer List Map Set Unit Any') },
  sh: { line: ['#'], quotes: ['"', "'"], keywords: words('if then else elif fi for while until do done case esac function in return export local readonly set unset source alias echo exit cd') },
  ruby: { line: ['#'], quotes: ['"', "'"], keywords: words('begin end def class module if elsif else unless while until for do return yield self nil true false and or not require include extend attr_accessor') },
  sql: { line: ['--'], block: [['/*', '*/']], quotes: ["'", '"'], keywords: words('select from where and or not insert into values update set delete create table index view drop alter join left right inner outer on group by order having limit offset as distinct union all null is in like between case when then else end primary key references default SELECT FROM WHERE AND OR NOT INSERT INTO VALUES UPDATE SET DELETE CREATE TABLE JOIN ON GROUP BY ORDER LIMIT AS NULL') },
  css: { block: [['/*', '*/']], quotes: ['"', "'"], keywords: words('@media @import @keyframes @font-face !important') },
  yaml: { line: ['#'], quotes: ['"', "'"], keywords: words('true false null yes no on off') },
  json: { quotes: ['"'], keywords: words('true false null') },
};
const ALIAS: Record<string, string> = {
  javascript: 'js', jsx: 'js', mjs: 'js', cjs: 'js', typescript: 'ts', tsx: 'ts', mts: 'ts', python: 'py', golang: 'go', rs: 'rust',
  cpp: 'c', cc: 'c', h: 'c', hpp: 'c', cs: 'c', csharp: 'c', 'c++': 'c', objc: 'c', swift: 'java', kotlin: 'java', kt: 'java', scala: 'java', dart: 'java', php: 'c',
  bash: 'sh', zsh: 'sh', shell: 'sh', fish: 'sh', console: 'sh', ps1: 'sh', powershell: 'sh', rb: 'ruby', fsh: 'glsl', vsh: 'glsl', frag: 'glsl', vert: 'glsl', hlsl: 'glsl', wgsl: 'glsl',
  scss: 'css', less: 'css', yml: 'yaml', toml: 'yaml', ini: 'yaml', jsonc: 'json', json5: 'json',
};

export function langOf(name: string): Lang | null {
  const key = name.toLowerCase();
  return LANGS[key] ?? LANGS[ALIAS[key] ?? ''] ?? null;
}

/** Colours one line; `state` carries an open block comment or string from the line before. */
export function highlightLine(line: string, lang: Lang | null, paint: Paint, state: { open: string | null } = { open: null }): string {
  if (!lang || paint.p.depth === 0) return line;
  let out = '';
  let i = 0;
  const comment = (t: string) => paint.fg('comment', t);
  while (i < line.length) {
    if (state.open) {
      const end = line.indexOf(state.open, i);
      const stop = end === -1 ? line.length : end + state.open.length;
      const piece = line.slice(i, stop);
      out += state.open.length === 3 || state.open === '`' ? paint.fg('string', piece) : comment(piece);
      i = stop;
      if (end !== -1) state.open = null;
      continue;
    }
    const rest = line.slice(i);
    const lineComment = lang.line?.find((l) => rest.startsWith(l));
    if (lineComment && !(lineComment === '#' && /^#(include|define|ifdef|ifndef|endif|pragma|version)\b/.test(rest) && lang.keywords.has(rest.split(/\s/)[0]!))) {
      out += comment(rest);
      break;
    }
    const block = lang.block?.find(([open]) => rest.startsWith(open));
    if (block) {
      state.open = block[1];
      out += comment(block[0]);
      i += block[0].length;
      continue;
    }
    const quote = lang.quotes.find((q) => rest.startsWith(q));
    if (quote) {
      let j = quote.length;
      while (j < rest.length && !rest.startsWith(quote, j)) j += rest[j] === '\\' ? 2 : 1;
      if (j >= rest.length && (quote.length === 3 || quote === '`')) {
        state.open = quote;
        out += paint.fg('string', rest);
        break;
      }
      const piece = rest.slice(0, Math.min(rest.length, j + quote.length));
      out += paint.fg('string', piece);
      i += piece.length;
      continue;
    }
    const num = /^(0x[0-9a-f_]+|\d[\d_]*(\.\d+)?(e[+-]?\d+)?)[a-z]*\b/i.exec(rest);
    if (num && !/[\w$]/.test(line[i - 1] ?? '')) {
      out += paint.fg('type', num[0]);
      i += num[0].length;
      continue;
    }
    const word = /^[#@]?[A-Za-z_$][\w$]*/.exec(rest);
    if (word) {
      const w = word[0];
      out += lang.keywords.has(w) ? paint.fg('keyword', w) : lang.types?.has(w) || /^[A-Z][a-z]\w*$/.test(w) ? paint.fg('type', w) : w;
      i += w.length;
      continue;
    }
    out += line[i];
    i++;
  }
  return out;
}

/** A whole block, line by line. */
export function highlight(code: string, language: string, paint: Paint): string[] {
  const lang = langOf(language);
  const state = { open: null as string | null };
  return code.split('\n').map((l) => highlightLine(l, lang, paint, state));
}
