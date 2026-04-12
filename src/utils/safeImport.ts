export async function safeImport<T = any>(moduleName: string): Promise<T | null> {
  try {
    const mod = await import(moduleName);
    return ((mod as any)?.default || mod) as T;
  } catch {
    console.warn(`safeImport_failed: ${moduleName}`);
    return null;
  }
}
