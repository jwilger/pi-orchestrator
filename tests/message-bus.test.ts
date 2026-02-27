import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MessageBus } from "../src/core/message-bus";
import { asAgentId } from "../src/core/types";

const requestBus = async (
  socketPath: string,
  method: string,
  route: string,
  body?: unknown,
): Promise<{ status: number; data: unknown }> =>
  new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        method,
        path: route,
        headers: { "Content-Type": "application/json" },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            data: raw ? (JSON.parse(raw) as unknown) : {},
          });
        });
      },
    );

    req.on("error", reject);
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });

describe("MessageBus", () => {
  it("serves message, status, evidence, and heartbeat endpoints", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-bus-"));
    const socketPath = path.join(tmp, "bus.sock");
    const walPath = path.join(tmp, "bus.wal");
    const bus = new MessageBus(socketPath, walPath);

    await bus.start({
      status: () => ({ ok: true }),
      workflowStatus: (workflowId) => ({ workflowId, state: "RED" }),
      evidence: async (workflowId, body) => ({ workflowId, received: body }),
      heartbeat: (agentId) => ({ ok: true, agentId }),
    });

    const post = await requestBus(socketPath, "POST", "/messages", {
      from: "agent-a",
      to: "agent-b",
      type: "handoff",
      payload: { step: 1 },
    });
    expect(post.status).toBe(200);

    const inbox = await requestBus(socketPath, "GET", "/inbox/agent-b");
    const inboxMessages = inbox.data as Array<{ id: string; to: string }>;
    expect(inbox.status).toBe(200);
    expect(inboxMessages).toHaveLength(1);
    expect(inboxMessages[0]?.to).toBe("agent-b");

    const ack = await requestBus(
      socketPath,
      "POST",
      `/ack/${inboxMessages[0]?.id ?? ""}`,
    );
    expect(ack.status).toBe(200);

    const status = await requestBus(socketPath, "GET", "/status");
    expect(status.data).toEqual({ ok: true });

    const unknown = await requestBus(socketPath, "GET", "/missing");
    expect(unknown.status).toBe(404);

    const workflowStatus = await requestBus(socketPath, "GET", "/status/wf-1");
    expect(workflowStatus.data).toEqual({ workflowId: "wf-1", state: "RED" });

    const evidence = await requestBus(socketPath, "POST", "/evidence/wf-1", {
      state: "RED",
      result: "pass",
    });
    expect(evidence.data).toEqual({
      workflowId: "wf-1",
      received: { state: "RED", result: "pass" },
    });

    const heartbeat = await requestBus(
      socketPath,
      "POST",
      "/heartbeat/agent-b",
    );
    expect(heartbeat.data).toEqual({ ok: true, agentId: "agent-b" });

    const bad = await requestBus(socketPath, "POST", "/messages", {
      nope: true,
    });
    expect(bad.status).toBe(500);

    await bus.stop();
  });

  it("times out long polling with no messages", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-bus-"));
    const bus = new MessageBus(
      path.join(tmp, "bus.sock"),
      path.join(tmp, "bus.wal"),
    );

    const start = Date.now();
    const inbox = await bus.longPollInbox(asAgentId("nobody"), 15);
    const elapsed = Date.now() - start;

    expect(inbox).toHaveLength(0);
    expect(elapsed).toBeGreaterThanOrEqual(10);
  });

  it("replays WAL and preserves unacked messages", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-bus-"));
    const socketPath = path.join(tmp, "bus.sock");
    const walPath = path.join(tmp, "bus.wal");

    const first = new MessageBus(socketPath, walPath);
    await first.start({
      status: () => ({}),
      workflowStatus: () => ({}),
      evidence: async () => ({}),
      heartbeat: () => ({}),
    });

    const sent = first.send({
      from: asAgentId("x"),
      to: asAgentId("y"),
      type: "work",
      payload: { id: 1 },
    });

    first.send({
      id: sent.id,
      from: asAgentId("x"),
      to: asAgentId("y"),
      type: "work",
      payload: { id: 2 },
    });

    await first.stop();

    const second = new MessageBus(socketPath, walPath);
    await second.start({
      status: () => ({}),
      workflowStatus: () => ({}),
      evidence: async () => ({}),
      heartbeat: () => ({}),
    });

    const inbox = await second.longPollInbox(asAgentId("y"), 20);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.payload).toEqual({ id: 1 });

    second.ack(sent.id);
    const empty = await second.longPollInbox(asAgentId("y"), 20);
    expect(empty).toHaveLength(0);

    await second.stop();
  });
});
