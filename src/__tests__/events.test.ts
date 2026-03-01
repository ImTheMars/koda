import { describe, test, expect } from "bun:test";
import { subscribe, emit, connectionCount } from "../events.js";

describe("events", () => {
  test("connectionCount starts at baseline", () => {
    const baseCount = connectionCount();
    expect(typeof baseCount).toBe("number");
  });

  test("subscribe adds listener and returns unsubscribe", () => {
    const before = connectionCount();
    const unsub = subscribe(() => {});
    expect(connectionCount()).toBe(before + 1);
    unsub();
    expect(connectionCount()).toBe(before);
  });

  test("emit calls all listeners", () => {
    const calls: Array<{ name: string; data: unknown }> = [];
    const unsub1 = subscribe((name, data) => calls.push({ name, data }));
    const unsub2 = subscribe((name, data) => calls.push({ name, data }));

    emit("heartbeat", { ts: 123 });
    expect(calls.length).toBe(2);
    expect(calls[0]!.name).toBe("heartbeat");
    expect(calls[0]!.data).toEqual({ ts: 123 });

    unsub1();
    unsub2();
  });

  test("emit survives listener errors", () => {
    const calls: string[] = [];
    const unsub1 = subscribe(() => { throw new Error("boom"); });
    const unsub2 = subscribe(() => calls.push("ok"));

    emit("spawn");
    expect(calls).toEqual(["ok"]);

    unsub1();
    unsub2();
  });

  test("unsubscribe removes only that listener", () => {
    const calls: number[] = [];
    const unsub1 = subscribe(() => calls.push(1));
    const unsub2 = subscribe(() => calls.push(2));

    unsub1();
    emit("heartbeat");
    expect(calls).toEqual([2]);

    unsub2();
  });

  test("double unsubscribe is safe", () => {
    const unsub = subscribe(() => {});
    unsub();
    unsub(); // should not throw
  });

  test("emit with no listeners is safe", () => {
    // Subscribe and immediately unsubscribe
    const unsub = subscribe(() => {});
    unsub();
    emit("heartbeat"); // should not throw
  });

  test("emit default data is empty object", () => {
    let receivedData: unknown;
    const unsub = subscribe((_, data) => { receivedData = data; });
    emit("heartbeat");
    expect(receivedData).toEqual({});
    unsub();
  });
});
