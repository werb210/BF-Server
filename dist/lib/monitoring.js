"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.initMonitoring = initMonitoring;
function initMonitoring(connectionString) {
    return {
        setup: () => {
            console.log('Monitoring initialized', connectionString || 'none');
        },
    };
}
