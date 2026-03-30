"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.appInsights = void 0;
exports.appInsights = {
    trackRequest: (data) => {
        console.log('trackRequest', data);
    },
    trackDependency: (data) => {
        console.log('trackDependency', data);
    },
    trackException: (data) => {
        console.log('trackException', data);
    },
};
