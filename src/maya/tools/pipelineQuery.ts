// AGENT_BLOCK_v2_AUDIENCE_AND_STAFF_PIPELINE_TOOL_v1
// Staff-only tool that turns a natural-language question about
// the BF pipeline into a canned BF-Server query. The full
// canned-query allowlist lives server-side in BF-Server's
// /api/maya/staff/pipeline-query handler; Maya forwards the
// user's question verbatim and renders the structured response.
import { callBFServer } from "../../integrations/bfServerClient.js";

export type PipelineQueryArgs = {
  question: string;
};

export type PipelineQueryResult = {
  ok: boolean;
  query?: string;
  rows?: ReadonlyArray<Record<string, unknown>>;
  summary?: string;
  not_supported?: boolean;
  supported_queries?: ReadonlyArray<string>;
};

export async function pipelineQuery(args: PipelineQueryArgs): Promise<PipelineQueryResult> {
  const question = String(args?.question ?? "").trim();
  if (!question) {
    return { ok: false, summary: "Empty question." };
  }
  try {
    const r = await callBFServer<PipelineQueryResult>(
      "/api/maya/staff/pipeline-query",
      { method: "POST", body: { question } },
    );
    return r ?? { ok: false, summary: "No response from BF-Server." };
  } catch (e: any) {
    return { ok: false, summary: `pipeline_query_failed: ${e?.message ?? "unknown"}` };
  }
}

// OpenAI tool descriptor — emitted to the model alongside other
// staff tools. The description steers the model toward using
// this tool for pipeline questions instead of guessing.
export const PIPELINE_QUERY_TOOL_DESCRIPTOR = {
  type: "function" as const,
  function: {
    name: "pipeline.query",
    description:
      "Answer factual questions about the staff pipeline of loan applications, contacts, lenders, and stages. Use this for questions like 'oldest active application', 'apps without bank statements', 'approvals this week', 'lender X's open deals', 'contacts touched today'.",
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The staff member's natural-language question, passed through verbatim.",
        },
      },
      required: ["question"],
    },
  },
};
