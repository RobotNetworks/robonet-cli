import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { liveNotificationNotice } from "../src/realtime/listener.js";
import {
  realtimeEventFromPayload,
  summarizeEvent,
} from "../src/realtime/events.js";

describe("realtimeEventFromPayload", () => {
  it("parses a valid event", () => {
    const event = realtimeEventFromPayload({
      type: "message.created",
      data: { thread_id: "thd_1", sender: { canonical_handle: "nick.me" }, content: "hello" },
    });

    assert.notEqual(event, null);
    assert.equal(event!.eventType, "message.created");
    assert.equal(event!.data.thread_id, "thd_1");
  });

  it("returns null for missing type", () => {
    assert.equal(realtimeEventFromPayload({ data: {} }), null);
  });
});

describe("summarizeEvent", () => {
  it("summarizes message.created", () => {
    const event = realtimeEventFromPayload({
      type: "message.created",
      data: {
        thread_id: "thd_1",
        sender: { canonical_handle: "nick.me" },
        content: "hello",
      },
    })!;

    const summary = summarizeEvent(event);
    assert.ok(summary.includes("message.created"));
    assert.ok(summary.includes("nick.me"));
    assert.ok(summary.includes("hello"));
  });

  it("summarizes thread.created", () => {
    const event = realtimeEventFromPayload({
      type: "thread.created",
      data: { id: "thd_2" },
    })!;

    assert.equal(summarizeEvent(event), "thread.created id=thd_2");
  });

  it("summarizes contact.request", () => {
    const event = realtimeEventFromPayload({
      type: "contact.request",
      data: { from: { canonical_handle: "tom.me" } },
    })!;

    assert.equal(summarizeEvent(event), "contact.request from=tom.me");
  });

  it("summarizes pong", () => {
    const event = realtimeEventFromPayload({ type: "pong", data: {} })!;
    assert.equal(summarizeEvent(event), "pong");
  });

  it("returns event type for unknown events", () => {
    const event = realtimeEventFromPayload({
      type: "custom.event",
      data: {},
    })!;
    assert.equal(summarizeEvent(event), "custom.event");
  });
});

describe("liveNotificationNotice", () => {
  it("documents agent-scoped live notifications and REST catch-up", () => {
    const notice = liveNotificationNotice("nick.me");

    assert.ok(notice.includes("Agent-scoped live notifications for nick.me"));
    assert.ok(notice.includes("Events are not replayed"));
    assert.ok(notice.includes("robonet threads get <thread_id>"));
    assert.ok(notice.includes("robonet messages search"));
  });
});
