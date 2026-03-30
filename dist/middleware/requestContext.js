"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runWithRequestContext = exports.fetchRequestDbProcessIds = exports.fetchRequestIdempotencyKeyHash = exports.fetchRequestRoute = exports.fetchRequestId = exports.fetchRequestContext = exports.requestContextMiddleware = void 0;
exports.requestContext = requestContext;
const requestContext_1 = require("../observability/requestContext");
Object.defineProperty(exports, "requestContextMiddleware", { enumerable: true, get: function () { return requestContext_1.requestContextMiddleware; } });
Object.defineProperty(exports, "fetchRequestContext", { enumerable: true, get: function () { return requestContext_1.fetchRequestContext; } });
Object.defineProperty(exports, "fetchRequestId", { enumerable: true, get: function () { return requestContext_1.fetchRequestId; } });
Object.defineProperty(exports, "fetchRequestRoute", { enumerable: true, get: function () { return requestContext_1.fetchRequestRoute; } });
Object.defineProperty(exports, "fetchRequestIdempotencyKeyHash", { enumerable: true, get: function () { return requestContext_1.fetchRequestIdempotencyKeyHash; } });
Object.defineProperty(exports, "fetchRequestDbProcessIds", { enumerable: true, get: function () { return requestContext_1.fetchRequestDbProcessIds; } });
Object.defineProperty(exports, "runWithRequestContext", { enumerable: true, get: function () { return requestContext_1.runWithRequestContext; } });
function requestContext(req, res, next) {
    (0, requestContext_1.requestContextMiddleware)(req, res, () => {
        req.requestId = req.id;
        next();
    });
}
