// BF_SERVER_v789_SAFE_HANDLERS - the parameter is typed (rather than `any`) so an
// inline arrow passed here is contextually typed and does not trip noImplicitAny.
export function safeHandler(fn: (req: any, res: any, next: any) => unknown) {
  return function (req: any, res: any, next: any) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
