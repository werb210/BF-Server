"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.followUpRules = void 0;
exports.followUpRules = [
    {
        id: "IMPORTANT_EMAIL_NOT_OPENED_1H",
        triggerEvent: "EMAIL_SENT",
        conditions: [
            {
                type: "metadata_equals",
                key: "important",
                value: true,
            },
            {
                type: "not_event_since",
                eventType: "EMAIL_OPENED",
                minutes: 60,
            },
        ],
        actions: [
            {
                type: "SEND_SMS",
                message: "Reminder: please review the important email we sent.",
                phoneField: "recipientPhoneNumber",
            },
            {
                type: "LOG_TIMELINE_EVENT",
                note: "Sent SMS escalation after 60 minutes with no open.",
            },
        ],
    },
    {
        id: "DOC_REJECTED_TWICE",
        triggerEvent: "DOC_REJECTED",
        conditions: [
            {
                type: "metadata_number_gte",
                key: "rejection_count",
                value: 2,
            },
        ],
        actions: [
            {
                type: "CREATE_TASK",
                title: "Document rejected twice",
                description: "Follow up with applicant after second rejection.",
            },
            {
                type: "LOG_TIMELINE_EVENT",
                note: "Created internal follow-up task after second rejection.",
            },
        ],
    },
    {
        id: "LENDER_SILENT_24H",
        triggerEvent: "LENDER_SUBMISSION_SENT",
        conditions: [
            {
                type: "not_event_since",
                eventType: "LENDER_STATUS_UPDATED",
                minutes: 24 * 60,
            },
        ],
        actions: [
            {
                type: "LOG_TIMELINE_EVENT",
                note: "Lender has not responded within 24 hours.",
            },
        ],
    },
];
