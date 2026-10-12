// BF_SERVER_v789_SAFE_HANDLERS
// Express 4 does not catch a rejected promise from an async handler: the request
// hangs until the client times out and the error never reaches the error handler.
// Every async function registered on the live app must therefore be wrapped
// (safeHandler) or keep its whole body inside one try/catch. This walks the real
// router stack built by createApp(), so a new route file is covered the moment it
// is mounted.
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { createApp } from "../app.js";

type Layer = { name?: string; handle?: any; route?: { path: string; stack: Layer[]; methods: Record<string, boolean> }; regexp?: RegExp };

function isAsync(fn: unknown): fn is (...a: unknown[]) => unknown {
  return typeof fn === "function" && fn.constructor?.name === "AsyncFunction";
}

// True when the function body is (optionally some await-free statements and then)
// a single try/catch whose catch does not await outside its own try.
export function fullyTried(source: string): boolean {
  const sf = ts.createSourceFile("h.ts", `(${source})`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let fn: ts.FunctionLikeDeclaration | null = null;
  const find = (n: ts.Node) => {
    if (fn) return;
    if (ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) { fn = n; return; }
    ts.forEachChild(n, find);
  };
  find(sf);
  const body = (fn as ts.FunctionLikeDeclaration | null)?.body;
  if (!body || !ts.isBlock(body)) return false;
  const st = body.statements;
  if (st.length === 0) return true;
  const last = st[st.length - 1];
  if (!ts.isTryStatement(last) || !last.catchClause) return false;
  for (const s of st.slice(0, -1)) if (/\bawait\b/.test(s.getText())) return false;
  const cb = last.catchClause.block.getText();
  if (/\bawait\b/.test(cb) && !/\btry\b/.test(cb)) return false;
  if (last.finallyBlock && /\bawait\b/.test(last.finallyBlock.getText())) return false;
  return true;
}

function walk(stack: Layer[], prefix: string, out: string[]) {
  for (const layer of stack) {
    if (layer.route) {
      const methods = Object.keys(layer.route.methods).join(",").toUpperCase();
      for (const h of layer.route.stack) {
        if (isAsync(h.handle) && !fullyTried(h.handle.toString())) {
          out.push(`${methods} ${prefix}${layer.route.path} -> ${h.handle.name || "<anonymous>"}`);
        }
      }
    } else if (layer.handle && Array.isArray(layer.handle.stack)) {
      const src = layer.regexp?.source ?? "";
      const seg = src.replace(/^\^\\?/, "").replace(/\\\/\?\(\?=\\\/\|\$\)$/i, "").replace(/\\\//g, "/");
      walk(layer.handle.stack, prefix + (seg && seg !== "/?(?=/|$)" ? "/" + seg.replace(/^\//, "") : ""), out);
    } else if (isAsync(layer.handle) && !fullyTried(layer.handle.toString())) {
      out.push(`USE ${prefix} -> ${layer.handle.name || "<anonymous>"}`);
    }
  }
}

describe("every async handler on the live app is wrapped", () => {
  it("the detector accepts wrapped / fully-tried bodies and rejects the rest", () => {
    expect(fullyTried("async (req, res) => { try { await x(); } catch (e) { res.status(500).end(); } }")).toBe(true);
    expect(fullyTried("async (req, res) => { const a = 1; try { await x(a); } catch (e) { next(e); } }")).toBe(true);
    expect(fullyTried("async (req, res) => { await x(); res.json({}); }")).toBe(false);
    expect(fullyTried("async (req, res) => { const r = await x(); try { y(r); } catch {} }")).toBe(false);
    expect(fullyTried("async (req, res) => { try { await x(); } catch (e) { await log(e); } }")).toBe(false);
  });

  it("finds no unwrapped async handler", () => {
    const app: any = createApp();
    const offenders: string[] = [];
    walk(app._router.stack, "", offenders);
    expect(offenders, `Wrap these in safeHandler (src/middleware/safeHandler.ts):\n${offenders.join("\n")}`).toEqual([]);
  });
});
