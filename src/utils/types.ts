export type StripUndefinedResult<T> = {
  [K in keyof T]-?: Exclude<T[K], undefined>;
};
