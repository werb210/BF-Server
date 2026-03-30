"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.dbClient = void 0;
const pg_1 = require("pg");
const config_1 = require("../config");
exports.dbClient = new pg_1.Pool({
    connectionString: config_1.config.db.url,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
});
exports.default = exports.dbClient;
