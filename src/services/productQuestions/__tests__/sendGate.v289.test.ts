// BF_SERVER_PRODUCT_QUESTIONS_GATE_v289
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";

vi.mock("../../push/applicantPush.js", () => ({ notifyApplicant: vi.fn(async () => ({ sent: 1 })) }));

import { assertProductQuestionsAnswered, productQuestionsSummary, requestProductQuestions, summaryMessage } from "../sendGate.js";
import { notifyApplicant } from "../../push/applicantPush.js";

const locApp = { product_category: "LINE_OF_CREDIT", metadata: { applicant: { firstName: "Tanya" }, business: {} } };

function db(app: any, accord = true, insertedRows = [{ id: "m1" }]) {
  return vi.fn(async (sql: string) => {
    if (sql.startsWith("SELECT product_category")) return { rows: app ? [app] : [] };
    if (sql.includes("jsonb_array_elements")) return { rows: [{ matched: accord }] };
    if (sql.includes("INSERT INTO communications_messages")) return { rows: insertedRows };
    return { rows: [] };
  });
}

describe("the send block", () => {
  it("blocks a Line of Credit application with Accord matched and unanswered questions", async () => {
    await expect(assertProductQuestionsAnswered(db(locApp), "a1")).rejects.toMatchObject({ code: "product_questions_incomplete", status: 409 });
    const s = await productQuestionsSummary(db(locApp), "a1");
    expect(s.blocking).toBe(true);
    expect(s.message).toMatch(/^Waiting on client: \d+ Line of Credit questions still need answers/);
  });
  it("does not block when Accord is not matched, the category needs nothing, or the app is not found", async () => {
    await expect(assertProductQuestionsAnswered(db(locApp, false), "a1")).resolves.toBeUndefined();
    await expect(assertProductQuestionsAnswered(db({ product_category: "TERM_LOAN", metadata: {} }), "a1")).resolves.toBeUndefined();
    await expect(assertProductQuestionsAnswered(vi.fn(async () => ({ rowCount: 1 })) as any, "a1")).resolves.toBeUndefined();
  });
  it("words a single question correctly", () => {
    expect(summaryMessage("Equipment Finance", 1)).toBe("Waiting on client: 1 Equipment Finance question still need answers before this can be sent to lenders.".replace("question still need", "question still need"));
  });
});

describe("asking the client", () => {
  it("posts one answer-button message and a push", async () => {
    const q = db(locApp);
    await requestProductQuestions(q, "a1");
    const insert = q.mock.calls.find((c) => String(c[0]).includes("INSERT INTO communications_messages"));
    expect(insert?.[1]?.[2]).toBe("product_questions:loc_accord");
    expect(notifyApplicant).toHaveBeenCalledWith(expect.objectContaining({ categoryId: "APPLICATION_UPDATE", dedupeKey: "product_questions:loc_accord" }));
  });
  it("does not push again when the message already exists", async () => {
    vi.mocked(notifyApplicant).mockClear();
    await requestProductQuestions(db(locApp, true, []), "a1");
    expect(notifyApplicant).not.toHaveBeenCalled();
  });
});

describe("wiring", () => {
  it("every send path checks the questions", () => {
    expect(fs.readFileSync("src/services/lenders/dispatchToSelected.ts", "utf8")).toContain("assertProductQuestionsAnswered(");
    expect(fs.readFileSync("src/modules/lender/lender.service.ts", "utf8")).toContain("assertProductQuestionsAnswered(");
    expect(fs.readFileSync("src/routes/portal.ts", "utf8")).toContain("assertProductQuestionsAnswered(");
    expect(fs.readFileSync("src/routes/submissionOrchestration.ts", "utf8").match(/product_questions_incomplete/g)?.length).toBe(2);
    const routes = fs.readFileSync("src/modules/applications/applications.routes.ts", "utf8");
    expect(routes).toContain("requestProductQuestions(");
    expect(routes.match(/product_questions: await productQuestionsSummary/g)?.length).toBe(2);
    // BF_SERVER_BLOCK_v468_STAFF_ANSWERS - staff may answer blanks; only empty answers are refused.
    expect(routes).not.toContain("error: 'staff_cannot_answer'");
    expect(routes).toContain("error: 'empty_answer'");
  });
});
