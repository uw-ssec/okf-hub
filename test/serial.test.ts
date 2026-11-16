import { describe, expect, it } from "vitest";
import { serialQueue } from "../src/serial";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("serialQueue", () => {
  it("never runs two tasks at once, even when each one awaits", async () => {
    const run = serialQueue();
    let active = 0;
    let maxActive = 0;
    const order: number[] = [];
    const task = (id: number) => async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await tick(5); // a task awaiting I/O must not let the next one start
      order.push(id);
      active--;
      return id;
    };
    const results = await Promise.all([1, 2, 3, 4, 5].map((id) => run(task(id))));
    expect(maxActive).toBe(1);
    expect(order).toEqual([1, 2, 3, 4, 5]);
    expect(results).toEqual([1, 2, 3, 4, 5]);
  });

  it("keeps serving after a task fails", async () => {
    const run = serialQueue();
    await expect(run(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(run(async () => "next")).resolves.toBe("next");
  });
});
