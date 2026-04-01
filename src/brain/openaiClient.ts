export async function runAI(
  source: string,
  message: string,
  history: any[],
  context: { role?: string } = {}
): Promise<any> {
  if (context?.role && context.role !== "staff" && context.role !== "system") {
    return Promise.reject({
      code: "forbidden",
      status: 403,
    });
  }

  return Promise.resolve({ text: "ok" });
}
