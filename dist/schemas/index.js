import { z } from "zod";
export const LeadSchema = z.object({
    name: z.string().trim().min(1),
    email: z.string().email(),
    phone: z.string().trim().min(1),
    businessName: z.string().optional(),
    productType: z.string().optional(),
    message: z.string().optional(),
}).strict();
export const CallStartSchema = z.object({
    to: z.string(),
});
export const CallStatusSchema = z.object({
    callId: z.string(),
    status: z.enum(["initiated", "ringing", "in-progress", "completed", "failed"]),
});
export const MayaMessageSchema = z.object({
    message: z.string(),
});
