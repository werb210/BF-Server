type AnyObj = Record<string, unknown>;
type UndefinedKeys<T> = { [K in keyof T]-?: undefined extends T[K] ? K : never }[keyof T];
type DefinedKeys<T> = Exclude<keyof T, UndefinedKeys<T>>;
type StripUndefinedResult<T extends AnyObj> = {
  [K in DefinedKeys<T>]: T[K];
} & {
  [K in UndefinedKeys<T>]?: Exclude<T[K], undefined>;
};

export function stripUndefined<T extends AnyObj>(obj: T): StripUndefinedResult<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined)) as StripUndefinedResult<T>;
}

export function toNullable<T>(value: T | undefined): T | null {
  return value === undefined ? null : value;
}

export function toStringSafe(value: unknown): string {
  if (value === undefined || value === null) return "";
  return String(value);
}
