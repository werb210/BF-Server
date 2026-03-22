const store = new Map<string, any>();

export function requireIdempotency(req: any, res: any, next: any) {
  const key = req.headers["idempotency-key"];

  if (!key) {
    return res.status(400).json({ error: "Missing Idempotency-Key" });
  }

  if (store.has(key)) {
    return res.json(store.get(key));
  }

  const originalJson = res.json.bind(res);

  res.json = (body: any) => {
    store.set(key, body);
    return originalJson(body);
  };

  next();
}
