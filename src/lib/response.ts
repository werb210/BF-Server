export type ApiSuccess<T = unknown> = {
  status: "ok";
  data: T;
  rid?: string;
};

export type ApiError = {
  status: "error";
  error: string;
  rid?: string;
};

export function ok<T = unknown>(data: T, rid?: string): ApiSuccess<T> {
  return {
    status: "ok",
    data,
    rid,
  };
}

export function fail(error: string, rid?: string): ApiError {
  return {
    status: "error",
    error,
    rid,
  };
}
