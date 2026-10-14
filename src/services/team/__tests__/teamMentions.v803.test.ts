// BF_SERVER_v803_TEAM_MENTIONS
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ query: vi.fn(), push: vi.fn() }));
vi.mock("../../../db.js", () => ({ runQuery: (sql: string, params?: unknown[]) => h.query(sql, params) }));
vi.mock("../../notifications/pushToUser.js", () => ({ pushToUser: (...a: unknown[]) => h.push(...a) }));

import { mentionedMemberIds, notifyTeamMentions, teamMentionsFor } from "../teamMentions.js";

const MEMBERS = [
  { user_id: "u-andrew", first_name: "Andrew", last_name: "Polturak" },
  { user_id: "u-caden", first_name: "Caden", last_name: "Werboweski" },
  { user_id: "u-todd", first_name: "Todd", last_name: "Werboweski" },
];

beforeEach(() => {
  h.query.mockReset();
  h.push.mockReset();
  h.query.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM team_channel_members m JOIN users u")) return { rows: MEMBERS };
    if (sql.includes("FROM team_channels c LEFT JOIN users u")) return { rows: [{ kind: "channel", name: "deals", sender: "Todd Werboweski" }] };
    if (sql.includes("INSERT INTO notifications")) return { rows: [{ id: "n1" }] };
    return { rows: [] };
  });
});

describe("v803 @mentions typed in Team chat", () => {
  it("finds @First Last and @First, any case, not inside an email or a longer word", () => {
    expect(mentionedMemberIds("@andrew polturak can you look?", MEMBERS)).toEqual(["u-andrew"]);
    expect(mentionedMemberIds("Thanks @Caden!", MEMBERS)).toEqual(["u-caden"]);
    expect(mentionedMemberIds("mail andrew@boreal.financial or @Andrewx", MEMBERS)).toEqual([]);
    expect(mentionedMemberIds("no mention here", MEMBERS)).toEqual([]);
  });

  it("adds typed names to the picked ids, keeps only members, and never the sender", async () => {
    const ids = await teamMentionsFor("ch-1", "u-todd", "@Caden and @Todd please", ["u-andrew", "not-a-member"]);
    expect(ids.sort()).toEqual(["u-andrew", "u-caden"]);
  });

  it("puts each mention in the bell with a title and a link to the conversation, then pushes", async () => {
    const n = await notifyTeamMentions({ channelId: "ch-1", messageId: "m-9", senderId: "u-todd", body: "@Andrew can you call TFG?", mentions: ["u-andrew"] });
    expect(n).toBe(1);
    const insert = h.query.mock.calls.find((c) => String(c[0]).includes("INSERT INTO notifications"));
    expect(insert?.[1]).toEqual(["u-andrew", "Todd Werboweski mentioned you in #deals", "m-9", "@Andrew can you call TFG?", "/communications?tab=team&channel=ch-1"]);
    expect(String(insert?.[0])).toContain("'mention'");
    expect(String(insert?.[0])).toContain("'team_messages'");
    expect(h.push).toHaveBeenCalledWith("u-andrew", "Todd Werboweski mentioned you in #deals", "@Andrew can you call TFG?", "/communications?tab=team&channel=ch-1");
  });

  it("does nothing without mentions, and a failure is logged, not thrown", async () => {
    expect(await notifyTeamMentions({ channelId: "ch-1", messageId: "m-1", senderId: "u-todd", body: "hi", mentions: [] })).toBe(0);
    h.query.mockRejectedValueOnce(new Error("db down"));
    await expect(notifyTeamMentions({ channelId: "ch-1", messageId: "m-2", senderId: "u-todd", body: "@Andrew", mentions: ["u-andrew"] })).resolves.toBe(0);
  });
});
