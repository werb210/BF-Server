import { z } from "zod";

export const LeadSchema = z.object({
  email: z.string().email(),
  phone: z.string().min(10),
  productType: z.string().min(1),
  businessName: z.string().min(1),
  requestedAmount: z.number().optional(),
}).strict();

export type LeadInput = z.infer<typeof LeadSchema>;
