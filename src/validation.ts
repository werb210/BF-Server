import { z } from "zod";

// BF_SERVER_v791_LEAD_SCHEMA - POST /api/public/lead requires companyName (the
// route's requireFields) but this strict schema used to reject companyName, so no
// lead could ever be created. It now accepts the website lead/contact shape
// (BF-Website ContactForm: companyName, fullName, firstName, lastName, email,
// phone, message) plus the older productType/businessName/requestedAmount keys.
// Still strict: an unknown key is a 400. CASL consent fields are stripped by the
// route before parsing.
const optionalText = (max: number) => z.string().trim().max(max).optional().nullable();

export const LeadSchema = z.object({
  companyName: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(254),
  phone: optionalText(32),
  fullName: optionalText(200),
  firstName: optionalText(100),
  lastName: optionalText(100),
  message: optionalText(5000),
  productType: optionalText(100),
  businessName: optionalText(200),
  requestedAmount: z.union([z.number().nonnegative(), z.string().trim().max(32)]).optional().nullable(),
}).strict();

export type LeadInput = z.infer<typeof LeadSchema>;
