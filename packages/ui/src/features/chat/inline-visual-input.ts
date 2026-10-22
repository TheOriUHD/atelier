/** Reads a top-level string from streamed tool JSON without interpreting HTML as JSON fields. */
export function visualField(json: string | undefined, field: string): string | undefined {
  if (!json) return undefined;
  let depth = 0;
  for (let i = 0; i < json.length; i++) {
    const char = json[i];
    if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') depth--;
    else if (char === '"') {
      const start = i++;
      for (; i < json.length; i++) {
        if (json[i] === '\\') i++;
        else if (json[i] === '"') break;
      }
      if (i >= json.length) return undefined;
      let key: unknown;
      try { key = JSON.parse(json.slice(start, i + 1)); } catch { return undefined; }
      let next = i + 1;
      while (/\s/.test(json[next] ?? '') && next < json.length) next++;
      if (depth !== 1 || key !== field || json[next] !== ':') continue;
      next++;
      while (/\s/.test(json[next] ?? '') && next < json.length) next++;
      if (json[next] !== '"') return undefined;
      const valueStart = ++next;
      for (; next < json.length; next++) {
        if (json[next] === '\\') next++;
        else if (json[next] === '"') break;
      }
      let value = json.slice(valueStart, Math.min(next, json.length));
      if (next >= json.length) value = value.replace(/\\(?:u[\da-fA-F]{0,3})?$/, '');
      try { return JSON.parse(`"${value}"`) as string; } catch { return undefined; }
    }
  }
  return undefined;
}
