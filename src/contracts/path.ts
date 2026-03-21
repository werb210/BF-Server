export function stripPrefix(fullPath: string, prefix: string) {
  if (!fullPath.startsWith(prefix)) {
    throw new Error(`Invalid contract path: ${fullPath} does not start with ${prefix}`);
  }
  const out = fullPath.slice(prefix.length);
  return out.startsWith("/") ? out : `/${out}`;
}
