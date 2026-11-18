import { expect, test } from "bun:test";
import { applicationRange } from "./application-range";

test("periods include today and use Singapore dates across month boundaries", () => {
  const now = Date.parse("2026-10-31T16:00:00Z");
  for (const [value, days, since] of [
    ["1", 1, "2026-11-01"],
    ["7", 7, "2026-10-26"],
    ["14", 14, "2026-10-19"],
    ["30", 30, "2026-10-03"],
    [null, 30, "2026-10-03"],
  ] as const) {
    expect(applicationRange(value, now)).toEqual({ days, since });
  }
  expect(applicationRange("1", now - 1)?.since).toBe("2026-10-31");
});

test("range handles leap years and rejects unsupported or malformed inputs", () => {
  expect(applicationRange("7", Date.parse("2024-03-01T01:00:00Z"))?.since).toBe("2024-02-24");
  for (const value of ["", "0", "-1", "2", "365", "7.5", "NaN", "Infinity", "7oops", " 7"]) {
    expect(applicationRange(value)).toBeUndefined();
  }
});
