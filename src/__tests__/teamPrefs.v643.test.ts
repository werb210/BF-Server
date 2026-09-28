import { describe, expect, it } from "vitest";
import { pushRecipients } from "../services/team/teamPrefs.js";
const base = { senderId: "s", members: [{ user_id: "s", muted: false }, { user_id: "a", muted: false }, { user_id: "b", muted: true }, { user_id: "c", muted: false }], mentions: [] as string[], dndUserIds: new Set<string>(), connected: (_: string) => false };
describe("team push recipients", () => {
  it("everyone but the sender and muted members", () => { expect(pushRecipients(base).map((r) => r.userId)).toEqual(["a", "c"]); });
  it("a muted member still hears an @mention", () => { expect(pushRecipients({ ...base, mentions: ["b"] })).toEqual([{ userId: "a", mentioned: false }, { userId: "b", mentioned: true }, { userId: "c", mentioned: false }]); });
  it("Do Not Disturb silences everything, even mentions", () => { expect(pushRecipients({ ...base, mentions: ["a"], dndUserIds: new Set(["a"]) }).map((r) => r.userId)).toEqual(["c"]); });
  it("no push to someone with the portal open (it alerts in the portal instead)", () => { expect(pushRecipients({ ...base, connected: (u) => u === "c" }).map((r) => r.userId)).toEqual(["a"]); });
});
