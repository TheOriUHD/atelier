/** The fence label Shiki knows a file's language by: its extension, or the whole name (Dockerfile, Makefile). */
export function languageOf(path: string): string {
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1).toLowerCase();
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1) : name;
}

/** `path` relative to the workspace root when it lies inside it; tools usually get absolute paths. */
export function displayPath(path: string, root: string | null): string {
  if (!root || !path.startsWith(root) || !/[\\/]/.test(path[root.length] ?? '')) return path;
  return path.slice(root.length + 1);
}
