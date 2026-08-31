import { describe, expect, it } from "vitest";
import { measureSmsContent } from "../src/lib/sms-content.js";

describe("single-segment SMS accounting", () => {
  it("counts GSM-7 basic and extension characters", () => {
    expect(measureSmsContent("A".repeat(160))).toMatchObject({
      encoding: "gsm7",
      units: 160,
      fitsSingleSegment: true,
    });
    expect(measureSmsContent("A".repeat(161)).fitsSingleSegment).toBe(false);
    expect(measureSmsContent("^".repeat(80))).toMatchObject({ units: 160, fitsSingleSegment: true });
    expect(measureSmsContent("^".repeat(81)).fitsSingleSegment).toBe(false);
  });

  it("counts UTF-16 units conservatively for UCS-2 messages", () => {
    expect(measureSmsContent("ن".repeat(70))).toMatchObject({
      encoding: "ucs2",
      units: 70,
      fitsSingleSegment: true,
    });
    expect(measureSmsContent("ن".repeat(71)).fitsSingleSegment).toBe(false);
    expect(measureSmsContent("🙂".repeat(35))).toMatchObject({ units: 70, fitsSingleSegment: true });
    expect(measureSmsContent("🙂".repeat(36)).fitsSingleSegment).toBe(false);
  });
});
