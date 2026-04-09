export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).then(() => undefined).catch(next);
