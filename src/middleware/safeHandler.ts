export function safeHandler(fn: any) {
  return function (req: any, res: any, next: any) {
    Promise.resolve(fn(req: any, res: any, next: any)).catch(next);
  };
}
