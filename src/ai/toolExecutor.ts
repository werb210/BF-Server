import { runQuery } from "../lib/db";

export async function executeTool(
  callId: string,
  name: string,
  params: any,
  fn: () => Promise<any>
): Promise<any> {
  let attempts = 0;

  while (attempts < 3) {
    try {
      const result = await fn();

      await runQuery("insert into tool_log(call_id, name) values ($1,$2)", [
        callId,
        name,
      ]);

      return result;
    } catch (err) {
      attempts++;

      if (attempts >= 3) {
        await runQuery("insert into dead_letter(call_id, name) values ($1,$2)", [
          callId,
          name,
        ]);
        throw err;
      }
    }
  }

  throw new Error(`Tool execution failed unexpectedly: ${name}`);
}
