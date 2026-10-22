/**
 * Dollar amounts are not math. remark-math reads everything between two `$` as a formula, so "($299) … ($149)" became
 * one unbreakable italic formula (the math font, `**` left in as text, a line that scrolls the page sideways). The rule
 * typesetters use (pandoc's): a `$` opens math only when no space follows it (and no letter or digit precedes it), and
 * closes it only when no space precedes it and no digit follows. A `$` that can't take part in such a pair is escaped.
 * Code (fenced, or in backticks), `$$` display math and already escaped `\$` are left alone.
 */
export function protectCurrency(text: string): string {
  if (!text.includes('$')) return text;
  const out: string[] = [];
  let fence: string | null = null;
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) out.push(protectParagraph(paragraph.join('\n')));
    paragraph = [];
  };
  for (const line of text.split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      out.push(line);
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
    } else if (marker) {
      flush();
      fence = marker;
      out.push(line);
    } else if (line.trim() === '') {
      flush();
      out.push(line);
    } else {
      paragraph.push(line);
    }
  }
  flush();
  return out.join('\n');
}

/** `$` and an amount that ends like an amount does ("$299)", "$5 or", "$59.95.", "$3k"), unlike a formula's `$2x+3` or `$10^2`. */
const AMOUNT = /^\$\d[\d,]*(?:\.\d+)?(?=$|[\s)\]},;:!?/%\u2013\u2014-]|\.(?:\s|$)|[kmb]\b|\s*(?:million|billion|thousand|usd|dollars?)\b)/i;

function protectParagraph(s: string): string {
  if (!s.includes('$')) return s;
  // The `$` that could be a delimiter: outside code spans, not escaped, not part of `$$` display math.
  const candidates: number[] = [];
  const literal = new Set<number>();
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      i++;
    } else if (c === '`') {
      let ticks = 1;
      while (s[i + ticks] === '`') ticks++;
      const close = s.indexOf('`'.repeat(ticks), i + ticks);
      i = close === -1 ? i + ticks - 1 : close + ticks - 1;
    } else if (c === '$') {
      if (s[i + 1] === '$') {
        const close = s.indexOf('$$', i + 2);
        i = close === -1 ? i + 1 : close + 1;
      } else if (AMOUNT.test(s.slice(i))) {
        literal.add(i); // money, whatever surrounds it
      } else {
        candidates.push(i);
      }
    }
  }
  const opens = (p: number) => s[p + 1] !== undefined && !/\s/.test(s[p + 1]!) && !(s[p - 1] !== undefined && /[\p{L}\p{N}]/u.test(s[p - 1]!));
  const closes = (p: number) => s[p - 1] !== undefined && !/\s/.test(s[p - 1]!) && !(s[p + 1] !== undefined && /\d/.test(s[p + 1]!));
  for (let i = 0; i < candidates.length; ) {
    const open = candidates[i]!;
    if (opens(open)) {
      let j = i + 1;
      while (j < candidates.length && !(closes(candidates[j]!) && candidates[j]! - open > 1)) j++;
      if (j < candidates.length) {
        i = j + 1; // a formula: whatever `$` sits inside it belongs to it
        continue;
      }
    }
    literal.add(open);
    i++;
  }
  if (!literal.size) return s;
  let result = '';
  for (let i = 0; i < s.length; i++) result += (literal.has(i) ? '\\' : '') + s[i];
  return result;
}
