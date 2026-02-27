import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MessageBus } from "../src/core/message-bus";
import { asAgentId } from "../src/core/types";

describe("MessageBus", () => {
  it("queues and acknowledges messages", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-bus-"));
    const bus = new MessageBus(
      path.join(tmp, "bus.sock"),
      path.join(tmp, "bus.wal"),
    );

    const sent = bus.send({
      from: asAgentId("a"),
      to: asAgentId("b"),
      type: "handoff",
      payload: { ok: true },
    });

    return bus.longPollInbox(asAgentId("b"), 10).then((inbox) => {
      expect(inbox).toHaveLength(1);
      expect(inbox[0]?.id).toBe(sent.id);
      bus.ack(sent.id);
    });
  });
});
