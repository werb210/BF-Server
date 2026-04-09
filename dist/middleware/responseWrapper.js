export function safeResponseWrapper(_req, res, next) {
    // Do not override the global response serializer here.
    next();
}
