import { describe, expect, it, vi } from "vitest";
import { HealthScheduler } from "../src/runtime/health-scheduler";

describe("HealthScheduler", () => {
  it("runs checks and reports results", async () => {
    const onResults = vi.fn();
    const scheduler = new HealthScheduler(
      1000,
      [
        () => ({ name: "a", ok: true, message: "ok" }),
        () => {
          throw new Error("boom");
        },
      ],
      onResults,
    );

    const results = await scheduler.runOnce();
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ name: "a", ok: true, message: "ok" });
    expect(results[1]?.ok).toBe(false);
    expect(onResults).toHaveBeenCalledWith(results);
    expect(scheduler.getState().failureStreak).toBe(1);
  });

  it("escalates after threshold and resets on recovery", async () => {
    const onResults = vi.fn();
    const onEscalation = vi.fn();
    const scheduler = new HealthScheduler(
      1000,
      [() => ({ name: "a", ok: false, message: "warn" })],
      onResults,
      onEscalation,
      2,
    );

    await scheduler.runOnce();
    expect(onEscalation).not.toHaveBeenCalled();
    await scheduler.runOnce();
    expect(onEscalation).toHaveBeenCalledTimes(1);
    expect(scheduler.getState().failureStreak).toBe(2);

    const healthy = new HealthScheduler(
      1000,
      [() => ({ name: "a", ok: true, message: "ok" })],
      onResults,
    );
    await healthy.runOnce();
    expect(healthy.getState().failureStreak).toBe(0);
  });

  it("starts once and can stop safely", () => {
    vi.useFakeTimers();
    const onResults = vi.fn();
    const scheduler = new HealthScheduler(
      1000,
      [() => ({ name: "a", ok: true, message: "ok" })],
      onResults,
    );

    scheduler.start();
    scheduler.start();
    vi.advanceTimersByTime(1000);
    scheduler.stop();
    scheduler.stop();

    vi.useRealTimers();
  });
});
