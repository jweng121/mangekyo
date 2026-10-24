// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { investigationPeriod } from "../src/investigationPeriod";

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

it("omits a blank cutoff even when the browser clock is ahead", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2099-01-01T00:00:00Z"));
  expect(investigationPeriod("", "")).toEqual({ from: null });
  expect(JSON.stringify(investigationPeriod("", ""))).not.toContain("cutoff");
});

it("serializes explicit datetime-local values using local winter and summer offsets", () => {
  vi.stubEnv("TZ", "America/Los_Angeles");
  expect(investigationPeriod("2026-01-15T09:30", "2026-07-15T09:30")).toEqual({
    from: Date.parse("2026-01-15T17:30:00Z"), cutoff: Date.parse("2026-07-15T16:30:00Z"),
  });
});

it("reports invalid or reversed explicit periods", () => {
  expect(() => investigationPeriod("", "invalid")).toThrow("valid local date");
  expect(() => investigationPeriod("2026-07-16T09:30", "2026-07-15T09:30")).toThrow("ending at or after");
});
