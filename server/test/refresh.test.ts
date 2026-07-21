import { describe, expect, it } from "vitest";
import { computeRefreshDelay } from "../src/core/tokenRefresher.js";

const MIN = 1_000;

describe("computeRefreshDelay", () => {
  it("schedules at 80% of the token lifetime", () => {
    const savedAt = 1_000_000;
    const expiresAt = savedAt + 3600_000; // 1h lifetime
    // At save time: refresh in 0.8 * 1h = 48 min
    expect(computeRefreshDelay(savedAt, savedAt, expiresAt)).toBe(0.8 * 3600_000);
  });

  it("accounts for time already elapsed", () => {
    const savedAt = 0;
    const expiresAt = 3600_000;
    const now = 1800_000; // halfway through
    expect(computeRefreshDelay(now, savedAt, expiresAt)).toBe(0.8 * 3600_000 - 1800_000);
  });

  it("fires (min-clamped) when already past the 80% point", () => {
    expect(computeRefreshDelay(3500_000, 0, 3600_000)).toBe(MIN);
  });

  it("fires immediately (min-clamped) for already-expired tokens", () => {
    expect(computeRefreshDelay(10_000_000, 0, 3600_000)).toBe(MIN);
  });

  it("returns null when no expiry is known — nothing to schedule", () => {
    expect(computeRefreshDelay(1000, 500, null)).toBeNull();
  });

  it("falls back to now as basis when savedAt is missing", () => {
    const now = 1_000_000;
    const expiresAt = now + 1000_000;
    expect(computeRefreshDelay(now, null, expiresAt)).toBe(800_000);
  });
});
