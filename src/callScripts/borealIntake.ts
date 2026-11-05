// BF_SERVER_v891_ONE_CALL_SCRIPT - Boreal's own intake call, the one that used to be typed into the portal's dialler
// ("Intake script"). It is now an ordinary call script: the BF silo gets it as its dialler script (migration
// 2026_11_19_v891_one_call_script.sql), and an Admin edits it, or picks another, in Settings > Call scripts.
// Question ids are fixed so the migration's copy and this one stay the same script.
import type { ScriptInput, Section } from "./scripts.js";

export const BOREAL_INTAKE_NAME = "Boreal intake call";

const sections: Section[] = [
  {
    "id": "consent",
    "title": "Recording consent (read first)",
    "body": "This call is recorded for quality and accuracy. Is that okay to continue?\n\nNote: If no: stop recording, offer unrecorded or a secure link, log the refusal.",
    "questions": [
      {
        "id": "rec_consent",
        "label": "Recording consent",
        "type": "yes_no",
        "options": [],
        "required": true,
        "help": "",
        "maps_to": null
      }
    ]
  },
  {
    "id": "greeting",
    "title": "Greeting",
    "body": "Thank you for calling Boreal Financial. My name is ___ - how can I help you today?\nIf financing: I will ask a few quick questions to match you with the lenders and products most likely to approve - about five minutes.",
    "questions": []
  },
  {
    "id": "identity",
    "title": "Contact and business identity",
    "body": "Your full name? Company name? Your position with the company?\nIs the business incorporated, a sole proprietorship, or a partnership?\nAre you the sole owner, or are there other owners or partners?\nBest mobile number? (this is also the number used to access the secure application)\nBest email address?",
    "questions": [
      {
        "id": "contact_name",
        "label": "Full name",
        "type": "text",
        "options": [],
        "required": true,
        "help": "",
        "maps_to": null
      },
      {
        "id": "business_name",
        "label": "Company name",
        "type": "text",
        "options": [],
        "required": true,
        "help": "",
        "maps_to": null
      },
      {
        "id": "title",
        "label": "Position with the company",
        "type": "text",
        "options": [],
        "required": false,
        "help": "",
        "maps_to": null
      },
      {
        "id": "entity_type",
        "label": "Business type",
        "type": "single_select",
        "options": [
          "Incorporated",
          "Sole proprietorship",
          "Partnership"
        ],
        "required": false,
        "help": "",
        "maps_to": null
      },
      {
        "id": "ownership",
        "label": "Ownership",
        "type": "single_select",
        "options": [
          "Sole owner",
          "Other owners or partners"
        ],
        "required": false,
        "help": "",
        "maps_to": null
      },
      {
        "id": "mobile",
        "label": "Mobile number",
        "type": "text",
        "options": [],
        "required": true,
        "help": "Also the number used to sign in to the secure application.",
        "maps_to": null
      },
      {
        "id": "email",
        "label": "Email address",
        "type": "text",
        "options": [],
        "required": false,
        "help": "",
        "maps_to": null
      }
    ]
  },
  {
    "id": "profile",
    "title": "Business profile",
    "body": "In a sentence, what does the company do?\nHow long operating? Which province and city? How many employees?",
    "questions": [
      {
        "id": "description",
        "label": "What the company does",
        "type": "long_text",
        "options": [],
        "required": false,
        "help": "",
        "maps_to": null
      },
      {
        "id": "time_in_business",
        "label": "Time in business",
        "type": "text",
        "options": [],
        "required": false,
        "help": "",
        "maps_to": null
      },
      {
        "id": "location",
        "label": "Province and city",
        "type": "text",
        "options": [],
        "required": false,
        "help": "",
        "maps_to": null
      },
      {
        "id": "employees",
        "label": "Employees",
        "type": "number",
        "options": [],
        "required": false,
        "help": "",
        "maps_to": null
      }
    ]
  },
  {
    "id": "request",
    "title": "Funding request",
    "body": "How much funding are you looking for?\nREAD BACK: So that is $___, correct?\nWhat will the funds be used for?",
    "questions": [
      {
        "id": "amount",
        "label": "Amount requested",
        "type": "money",
        "options": [],
        "required": true,
        "help": "Read it back before recording it.",
        "maps_to": null
      },
      {
        "id": "use_of_funds",
        "label": "Use of funds",
        "type": "single_select",
        "options": [
          "Working capital",
          "Equipment",
          "Expansion",
          "Inventory",
          "Payroll",
          "Acquisition",
          "Commercial real estate",
          "Debt consolidation",
          "Media / entertainment",
          "Factoring / receivables",
          "Purchase orders",
          "Other"
        ],
        "required": true,
        "help": "Use of funds drives routing.",
        "maps_to": null
      }
    ]
  },
  {
    "id": "timing",
    "title": "Timing",
    "body": "When do you need the funds?",
    "questions": [
      {
        "id": "urgency",
        "label": "When they need the funds",
        "type": "single_select",
        "options": [
          "Immediately",
          "Within 30 days",
          "1-3 months",
          "Just exploring"
        ],
        "required": false,
        "help": "",
        "maps_to": null
      }
    ]
  },
  {
    "id": "existing",
    "title": "Existing financing",
    "body": "Any of these in place now? Bank/term loans, lines of credit, merchant cash advances, equipment leases, factoring, government loans (CSBFP/BDC).",
    "questions": [
      {
        "id": "existing_debt",
        "label": "Financing in place now",
        "type": "multi_select",
        "options": [
          "Bank / term loan",
          "Line of credit",
          "Merchant cash advance",
          "Equipment lease",
          "Factoring",
          "Government loan (CSBFP / BDC)",
          "None"
        ],
        "required": false,
        "help": "",
        "maps_to": null
      }
    ]
  },
  {
    "id": "financials",
    "title": "Financial overview",
    "body": "Approximate annual revenue last year?\nREAD BACK: So roughly $___, correct?\nIs the business currently profitable?\nAny bankruptcies, consumer proposals, CRA/tax arrears, or judgments - business or owners?",
    "questions": [
      {
        "id": "annual_revenue",
        "label": "Annual revenue last year",
        "type": "money",
        "options": [],
        "required": true,
        "help": "Read it back before recording it.",
        "maps_to": null
      },
      {
        "id": "profitable",
        "label": "Currently profitable",
        "type": "yes_no",
        "options": [],
        "required": false,
        "help": "",
        "maps_to": null
      },
      {
        "id": "credit_issues",
        "label": "Bankruptcies, proposals, CRA arrears or judgments",
        "type": "long_text",
        "options": [],
        "required": false,
        "help": "Business or owners. Leave blank if none.",
        "maps_to": null
      }
    ]
  },
  {
    "id": "collateral",
    "title": "Collateral",
    "body": "Any assets to support the financing? Equipment, real estate, accounts receivable, inventory, or none.",
    "questions": [
      {
        "id": "collateral",
        "label": "Assets to support the financing",
        "type": "multi_select",
        "options": [
          "Equipment",
          "Real estate",
          "Accounts receivable",
          "Inventory",
          "None"
        ],
        "required": false,
        "help": "",
        "maps_to": null
      }
    ]
  },
  {
    "id": "route",
    "title": "Route-specific (ask the matching block)",
    "body": "Media: signed contracts, broadcaster/distribution agreements, or approved tax credits?\nReal estate: property type, approximate value, owned or being purchased?\nEquipment: what equipment, approximate cost, new or used?\nFactoring: main customers and outstanding receivables?",
    "questions": [
      {
        "id": "route_detail",
        "label": "Route-specific details",
        "type": "long_text",
        "options": [],
        "required": false,
        "help": "",
        "maps_to": null
      }
    ]
  },
  {
    "id": "decision",
    "title": "Decision-makers",
    "body": "Will all decision-makers and owners be available to take part?",
    "questions": [
      {
        "id": "decision_makers",
        "label": "All decision-makers available",
        "type": "yes_no",
        "options": [],
        "required": false,
        "help": "",
        "maps_to": null
      }
    ]
  },
  {
    "id": "documents",
    "title": "Documents and secure link",
    "body": "We will typically need recent financial statements, bank statements, government ID, and corporate documents.\nNothing to send now - I will text a secure link to your mobile; you upload there and complete the application. It is protected by a one-time code sent to your phone.",
    "questions": [
      {
        "id": "casl_consent",
        "label": "Consent to text and email the secure link (CASL)",
        "type": "yes_no",
        "options": [],
        "required": true,
        "help": "",
        "maps_to": null
      }
    ]
  },
  {
    "id": "appointment",
    "title": "Appointment and next steps",
    "body": "Want a specialist to call at a particular time, or is now-onward fine?\nOnce reviewed, a specialist reaches out with next steps and the strongest-fit lenders.",
    "questions": [
      {
        "id": "callback",
        "label": "Preferred callback time",
        "type": "text",
        "options": [],
        "required": false,
        "help": "",
        "maps_to": null
      }
    ]
  },
  {
    "id": "close",
    "title": "Close",
    "body": "Anything else you would like us to know before we begin?\nThank you - sending your secure link now; we will begin reviewing right away.",
    "questions": [
      {
        "id": "notes",
        "label": "Notes",
        "type": "long_text",
        "options": [],
        "required": false,
        "help": "",
        "maps_to": null
      }
    ]
  },
  {
    "id": "agent_notes",
    "title": "Agent notes",
    "body": "- Read back amount and revenue before recording them.\n- Use of funds drives routing: media -> Media Funding, equipment -> Equipment, factoring -> Factoring, real estate -> Commercial Mortgage, general -> Working Capital, POs -> PO, new business -> Startup.\n- $1M+ routes to the senior broker queue.\n- No documents by voice - always the secure OTP link.",
    "questions": []
  }
];

export function borealIntakeScript(): ScriptInput {
  return { name: BOREAL_INTAKE_NAME, description: "The Boreal Financial intake call: recording consent, the business, the request and the secure link.", use_for: "calls", dialer_default: true, sections: JSON.parse(JSON.stringify(sections)) as Section[] };
}
