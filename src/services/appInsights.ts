export function trackRequest(data: any) {
  // minimal implementation for tests
  console.log("trackRequest", data)
}

export function trackDependency(data: any) {
  console.log("trackDependency", data)
}

export function trackException(err: any) {
  console.log("trackException", err?.message || err)
}
