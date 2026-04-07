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
  const result: ApiSuccess<T> = {
    status: "ok",
    data,
  };

  if (rid !== undefined) {
    result.rid = rid;
  }

  return result;
}

export function fail(error: string, rid?: string): ApiError {
  const result: ApiError = {
    status: "error",
    error,
  };

  if (rid !== undefined) {
    result.rid = rid;
  }

  return result;
}
