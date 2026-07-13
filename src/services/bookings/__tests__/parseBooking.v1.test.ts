// BF_SERVER_BOOKINGS_TO_CRM_v1
import { describe, it, expect } from "vitest";
import { parseBooking, isBookingBody, toE164 } from "../parseBooking.js";

const REAL = `Customer Info ------------------- Name: MICHAEL COTIC Email: ffxinc@gmail.com Phone Number: 19055698018 Address: 3450 RIDGEWAY DRIVE UNIT 17 Time Zone: Mountain Standard Time Notes: WORKING CAPITAL LOANS Additional Recipients: ffxinc@gmail.com, Booking Info ------------------- Service name: 30 minute Phone Call Additional Information -------------------`;

describe("parseBooking", () => {
  it("parses the real Microsoft Bookings body", () => {
    const p = parseBooking(REAL);
    expect(p).not.toBeNull();
    expect(p!.customerName).toBe("MICHAEL COTIC");
    expect(p!.customerEmail).toBe("ffxinc@gmail.com");
    expect(p!.customerPhone).toBe("19055698018");
    expect(p!.customerAddress).toBe("3450 RIDGEWAY DRIVE UNIT 17");
    expect(p!.customerNotes).toBe("WORKING CAPITAL LOANS");
    expect(p!.serviceName).toBe("30 minute Phone Call");
  });

  it("handles the HTML body Graph actually returns", () => {
    const html = `<html><body><div>Customer Info</div><p>Name: Jane Doe<br>Email: jane@x.com<br>Phone Number: 4035551234<br>Notes: Equipment financing</p></body></html>`;
    const p = parseBooking(html);
    expect(p!.customerName).toBe("Jane Doe");
    expect(p!.customerNotes).toBe("Equipment financing");
  });

  it("ignores ordinary calendar events", () => {
    expect(isBookingBody("Lunch with Andrew")).toBe(false);
    expect(parseBooking("<p>Team standup</p>")).toBeNull();
  });

  it("will not create a ghost contact from an unusable booking", () => {
    expect(parseBooking("Customer Info ---- Name: Notes: nothing here")).toBeNull();
  });

  it("normalises the phone to E.164 so the contact actually links up", () => {
    expect(toE164("19055698018")).toBe("+19055698018");
    expect(toE164("4035551234")).toBe("+14035551234");
    expect(toE164("")).toBe("");
  });
});
