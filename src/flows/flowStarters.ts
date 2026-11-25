// BF_SERVER_CRM_FLOWS_v1 - starter wording for a new flow, so every email has something to edit. Merge fields:
// {{first_name}}, {{company}}, {{link}} (the flow's page), {{booking_link}} (the owner's calendar).
type Email = { subject: string; body: string };

const p = (...lines: string[]) => lines.map((l) => `<p>${l}</p>`).join("");

const KS: Record<string, Email> = {
  e1: { subject: "One system for your brokerage", body: p("Hi {{first_name}},", "We run a lending brokerage ourselves and built the system we wished we could buy: the pipeline, calls, documents and commissions in one place.", "Would it help {{company}}? <a href=\"{{link}}\">See how it works</a>.", "Todd") },
  n2: { subject: "Re: one system for your brokerage", body: p("Hi {{first_name}},", "Quick follow-up. Most brokerages we talk to juggle a CRM, a dialler, a shared drive and a spreadsheet for commissions.", "<a href=\"{{link}}\">Here is what one system looks like</a>.", "Todd") },
  n3: { subject: "The client portal", body: p("Hi {{first_name}},", "Your clients get their own branded portal to upload documents and see where their file is, so fewer \"any update?\" calls.", "<a href=\"{{link}}\">Take a look</a>.", "Todd") },
  n4: { subject: "Last note from me", body: p("Hi {{first_name}},", "I will stop here. If a better system for {{company}} is ever on the list, the link is below.", "<a href=\"{{link}}\">Keystone</a>", "Todd") },
  o1: { subject: "What you would get", body: p("Hi {{first_name}},", "Thanks for opening my note. In short: CRM, client portal, iPhone dialler, documents with OCR and an AI assistant, hosted in Canada and licensed per seat.", "<a href=\"{{link}}\">The details</a>.", "Todd") },
  o2: { subject: "A 15-minute look", body: p("Hi {{first_name}},", "If it is easier to see it than read about it, pick a time and I will walk you through it with your own brokerage name on it.", "<a href=\"{{booking_link}}\">Book 15 minutes</a>", "Todd") },
  c1: { subject: "Happy to show you", body: p("Hi {{first_name}},", "Thanks for taking a look. Pick a time below or reply with a good number and I will call you.", "<a href=\"{{booking_link}}\">Book a time</a>", "Todd") },
};

const BF: Record<string, Email> = {
  e1: { subject: "Financing options for {{company}}", body: p("Hi {{first_name}},", "Boreal Financial works with over 120 lenders to find business financing that fits: term loans, lines of credit, equipment and more.", "<a href=\"{{link}}\">See what you could qualify for</a>.", "Boreal Financial") },
  n2: { subject: "Re: financing options", body: p("Hi {{first_name}},", "A quick follow-up in case my last note got buried. One application, many lenders.", "<a href=\"{{link}}\">Start here</a>.", "Boreal Financial") },
  n3: { subject: "How it works", body: p("Hi {{first_name}},", "Tell us what you need, upload a few documents, and we match you with the lenders most likely to say yes.", "<a href=\"{{link}}\">See how it works</a>.", "Boreal Financial") },
  n4: { subject: "Last note from us", body: p("Hi {{first_name}},", "We will stop here. If financing is ever on the list for {{company}}, the link is below.", "<a href=\"{{link}}\">Boreal Financial</a>") },
  o1: { subject: "More detail", body: p("Hi {{first_name}},", "Thanks for opening our note. Here is more on the products and how the process works.", "<a href=\"{{link}}\">The details</a>.", "Boreal Financial") },
  o2: { subject: "An example", body: p("Hi {{first_name}},", "Businesses like yours use us to compare offers from several lenders in one go, without filling in the same forms again and again.", "<a href=\"{{link}}\">See an example</a>.", "Boreal Financial") },
  c1: { subject: "Happy to talk", body: p("Hi {{first_name}},", "Thanks for taking a look. Pick a time below or reply with a good number and we will call you.", "<a href=\"{{booking_link}}\">Book a time</a>", "Boreal Financial") },
};

export function starterEmails(silo: string): Record<string, Email> {
  return String(silo ?? "BF").toUpperCase() === "KS" ? KS : BF;
}
