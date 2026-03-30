"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const users_service_1 = require("../services/users.service");
const users_routes_1 = __importDefault(require("../modules/users/users.routes"));
const roles_1 = require("../auth/roles");
const router = (0, express_1.Router)();
/**
 * Self profile
 */
router.get("/me", auth_1.requireAuth, (0, auth_1.requireAuthorization)({ roles: roles_1.ALL_ROLES }), users_service_1.fetchMe);
router.patch("/me", auth_1.requireAuth, (0, auth_1.requireAuthorization)({ roles: roles_1.ALL_ROLES }), users_service_1.updateMe);
/**
 * Admin user management
 */
router.get("/", auth_1.requireAuth, (0, auth_1.requireAuthorization)({ roles: [roles_1.ROLES.ADMIN] }), users_service_1.listUsers);
router.post("/", auth_1.requireAuth, (0, auth_1.requireAuthorization)({ roles: [roles_1.ROLES.ADMIN] }), users_service_1.createUser);
router.patch("/:id", auth_1.requireAuth, (0, auth_1.requireAuthorization)({ roles: [roles_1.ROLES.ADMIN] }), users_service_1.adminUpdateUser);
router.delete("/:id", auth_1.requireAuth, (0, auth_1.requireAuthorization)({ roles: [roles_1.ROLES.ADMIN] }), users_service_1.deleteUser);
router.use("/", auth_1.requireAuth, (0, auth_1.requireAuthorization)({ roles: [roles_1.ROLES.ADMIN] }), users_routes_1.default);
exports.default = router;
