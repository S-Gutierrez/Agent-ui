import { describe, expect, it } from "vitest";
import { ConversationTracker, OfficeStore } from "../src/server/store.ts";

describe("ConversationTracker", () => {
  const make = () => {
    let now = 1_000;
    const t = new ConversationTracker(60_000, () => {}, () => now);
    return { t, advance: (ms: number) => (now += ms) };
  };

  it("starts a 1:1 conversation with the sender first", () => {
    const { t } = make();
    t.message("a", "b");
    expect(t.active()).toHaveLength(1);
    expect(t.active()[0]!.participants).toEqual(["a", "b"]);
    t.dispose();
  });

  it("replies stay in the same conversation and keep the initiator", () => {
    const { t } = make();
    t.message("a", "b");
    t.message("b", "a");
    expect(t.active()).toHaveLength(1);
    expect(t.active()[0]!.participants).toEqual(["a", "b"]);
    t.dispose();
  });

  it("a third agent joining turns it into a group", () => {
    const { t } = make();
    t.message("a", "b");
    t.message("b", "c");
    expect(t.active()).toHaveLength(1);
    expect(t.active()[0]!.participants).toEqual(["a", "b", "c"]);
    t.dispose();
  });

  it("merges two conversations bridged by a message", () => {
    const { t } = make();
    t.message("a", "b");
    t.message("c", "d");
    expect(t.active()).toHaveLength(2);
    t.message("b", "c");
    expect(t.active()).toHaveLength(1);
    expect(new Set(t.active()[0]!.participants)).toEqual(new Set(["a", "b", "c", "d"]));
    t.dispose();
  });

  it("expires after the ttl without messages", () => {
    const { t, advance } = make();
    t.message("a", "b");
    advance(61_000);
    t.expire();
    expect(t.active()).toHaveLength(0);
    t.dispose();
  });

  it("drops conversations that fall below two participants", () => {
    const { t } = make();
    t.message("a", "b");
    t.leave("b");
    expect(t.active()).toHaveLength(0);
    t.dispose();
  });
});

describe("OfficeStore", () => {
  it("marks agents with pending permissions as needs_review", () => {
    const s = new OfficeStore("test");
    s.upsertAgent({ id: "a", name: "A", status: "working" });
    s.addPermission({ id: "p1", agentId: "a", title: "bash", at: 1 });
    expect(s.snapshot().agents[0]!.status).toBe("needs_review");
    s.removePermission("p1");
    expect(s.snapshot().agents[0]!.status).toBe("working");
    s.dispose();
  });

  it("upserts log entries by id (streaming parts)", () => {
    const s = new OfficeStore("test");
    s.log({ id: "x", agentId: "a", kind: "reasoning", text: "Hel", at: 1 });
    s.log({ id: "x", agentId: "a", kind: "reasoning", text: "Hello", at: 1 });
    expect(s.history("a")).toEqual([{ id: "x", agentId: "a", kind: "reasoning", text: "Hello", at: 1 }]);
    s.dispose();
  });
});
