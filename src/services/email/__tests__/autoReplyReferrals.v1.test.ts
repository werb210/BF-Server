// BF_SERVER_AUTO_REPLY_REFERRALS_v1
import { describe, expect, it } from "vitest";
import { parseAutoReply } from "../autoReplyReferrals.js";

describe("people named in auto-replies", () => {
  it("reads the colleagues an out-of-office names, with phones, and not the sender", () => {
    const r = parseAutoReply("Automatic reply: An option your borrowers may not know about",
      "Thank you for reaching out. I will be out of the office indefinately.\n\nIf you need assistence please contact Tyler Wright at Tyler.Wright@shoreunitedbank.com (443 675 6196) or Megan Newcomb at Megan.Newcomb@shoreunitedbank.com (443 262 9318).\n\nThank you\nDave Kenney\nDavid.Kenney@shoreunitedbank.com | ShoreUnitedBank.com\nConnect with us: Facebook",
      "david.kenney@shoreunitedbank.com");
    expect(r.autoReply).toBe(true);
    expect(r.left).toBe(false);
    expect(r.referrals).toEqual([
      { email: "tyler.wright@shoreunitedbank.com", name: "Tyler Wright", phone: "443 675 6196" },
      { email: "megan.newcomb@shoreunitedbank.com", name: "Megan Newcomb", phone: "443 262 9318" },
    ]);
  });

  it("knows the sender has retired and keeps team inboxes", () => {
    const r = parseAutoReply("Automatic reply: Hello",
      "My last day of employment with Dakota Business Lending is April 15th. I have transitioned into retirement. For new loan projects in North Dakota please contact Emily Schroeder at eschroeder@dakotabusinesslending.com. For existing loan servicing questions contact servicing@dakotabusinesslending.com.",
      "sschake@dakotabusinesslending.com");
    expect(r.left).toBe(true);
    expect(r.referrals.map((x) => x.email)).toEqual(["eschroeder@dakotabusinesslending.com", "servicing@dakotabusinesslending.com"]);
    expect(r.referrals[0]!.name).toBe("Emily Schroeder");
  });

  it("ignores ordinary replies and other companies' addresses", () => {
    expect(parseAutoReply("Re: An option", "Call me at bob@other.com", "a@bank.com").referrals).toEqual([]);
    expect(parseAutoReply("Automatic reply: x", "Contact bob@gmail.com", "a@bank.com").referrals).toEqual([]);
  });
});
