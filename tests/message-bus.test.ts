import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MessageBus } from "../src/core/message-bus";
import { asAgentId, asMessageId } from "../src/core/types";

const requestBus = async (
  socketPath: string,
  method: string,
  route: string,
  body?: unknown,
): Promise<{
  status: number;
  data: unknown;
  headers: http.IncomingHttpHeaders;
}> =>
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
            headers: res.headers,
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

const requestRaw = async (
  socketPath: string,
  method: string,
  route: string,
  rawBody: string,
): Promise<number> =>
  new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        method,
        path: route,
        headers: { "Content-Type": "application/json" },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );

    req.on("error", reject);
    req.write(rawBody);
    req.end();
  });

const requestRawResponse = async (
  socketPath: string,
  method: string,
  route: string,
  rawBody: string,
): Promise<{ status: number; body: string }> =>
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
          resolve({ status: res.statusCode ?? 0, body: raw });
        });
      },
    );

    req.on("error", reject);
    req.write(rawBody);
    req.end();
  });

describe("MessageBus", () => {
  it("stop is safe before start", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-bus-"));
    const bus = new MessageBus(
      path.join(tmp, "bus.sock"),
      path.join(tmp, "bus.wal"),
    );
    await expect(bus.stop()).resolves.toBeUndefined();
  });

  it("propagates server close errors", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-bus-"));
    const bus = new MessageBus(
      path.join(tmp, "bus.sock"),
      path.join(tmp, "bus.wal"),
    );
    (
      bus as unknown as { server: { close: (cb: (e: Error) => void) => void } }
    ).server = {
      close: (cb) => cb(new Error("close failed")),
    };

    await expect(bus.stop()).rejects.toThrow("close failed");
  });

  it("removes stale socket file on start", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-bus-"));
    const socketPath = path.join(tmp, "bus.sock");
    const walPath = path.join(tmp, "bus.wal");
    fs.writeFileSync(socketPath, "stale", "utf8");

    const bus = new MessageBus(socketPath, walPath);
    await bus.start({
      status: () => ({}),
      workflowStatus: () => ({}),
      evidence: async () => ({}),
      heartbeat: () => ({}),
    });

    expect(fs.existsSync(socketPath)).toBe(true);
    await bus.stop();
    expect(fs.existsSync(socketPath)).toBe(false);
  });

  it("serves message, status, evidence, and heartbeat endpoints", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-bus-"));
    const socketPath = path.join(tmp, "bus.sock");
    const walPath = path.join(tmp, "bus.wal");
    const bus = new MessageBus(socketPath, walPath);

    await bus.start({
      status: () => ({ ok: true }),
      workflowStatus: (workflowId) => ({ workflowId, state: "RED" }),
      evidence: async (workflowId, body) => ({ workflowId, received: body }),
      heartbeat: (agentId) => {
        if (agentId === "explode") {
          throw "boom";
        }
        return { ok: true, agentId };
      },
    });

    const post = await requestBus(socketPath, "POST", "/messages", {
      from: "agent-a",
      to: "agent-b",
      type: "handoff",
      payload: { step: 1 },
      requires_ack: true,
      timestamp: "2026-01-01T00:00:00.000Z",
      workflow_id: "wf-99",
      phase: "RED",
    });
    expect(post.status).toBe(200);
    const postBody = post.data as { id: string; status: string };
    expect(postBody.status).toBe("queued");
    expect(postBody.id.length).toBeGreaterThan(0);

    const inbox = await requestBus(socketPath, "GET", "/inbox/agent-b");
    const inboxMessages = inbox.data as Array<{
      id: string;
      to: string;
      timestamp: string;
      workflow_id?: string;
      phase?: string;
    }>;
    expect(inbox.status).toBe(200);
    expect(inboxMessages).toHaveLength(1);
    expect(inboxMessages[0]?.to).toBe("agent-b");
    expect(inboxMessages[0]?.timestamp).toBe("2026-01-01T00:00:00.000Z");
    expect(inboxMessages[0]?.workflow_id).toBe("wf-99");
    expect(inboxMessages[0]?.phase).toBe("RED");

    const ack = await requestBus(
      socketPath,
      "POST",
      `/ack/${inboxMessages[0]?.id ?? ""}`,
    );
    expect(ack.status).toBe(200);
    expect(ack.data).toEqual({ ok: true });

    const status = await requestBus(socketPath, "GET", "/status");
    expect(status.data).toEqual({ ok: true });
    expect(status.headers["content-type"]).toContain("application/json");

    const unknown = await requestBus(socketPath, "GET", "/missing");
    expect(unknown.status).toBe(404);
    expect(unknown.data).toEqual({ error: "not_found" });

    const wrongMessageMethod = await requestBus(socketPath, "GET", "/messages");
    expect(wrongMessageMethod.status).toBe(404);
    expect(wrongMessageMethod.data).toEqual({ error: "not_found" });

    const wrongInboxMethod = await requestBus(
      socketPath,
      "POST",
      "/inbox/agent-b",
    );
    expect(wrongInboxMethod.status).toBe(404);
    expect(wrongInboxMethod.data).toEqual({ error: "not_found" });

    const wrongAckMethod = await requestBus(socketPath, "GET", "/ack/x");
    expect(wrongAckMethod.status).toBe(404);
    expect(wrongAckMethod.data).toEqual({ error: "not_found" });

    const wrongEvidenceMethod = await requestBus(
      socketPath,
      "GET",
      "/evidence/wf-1",
    );
    expect(wrongEvidenceMethod.status).toBe(404);
    expect(wrongEvidenceMethod.data).toEqual({ error: "not_found" });

    const wrongStatusMethod = await requestBus(socketPath, "POST", "/status");
    expect(wrongStatusMethod.status).toBe(404);
    expect(wrongStatusMethod.data).toEqual({ error: "not_found" });

    const wrongWorkflowStatusMethod = await requestBus(
      socketPath,
      "POST",
      "/status/wf-1",
    );
    expect(wrongWorkflowStatusMethod.status).toBe(404);
    expect(wrongWorkflowStatusMethod.data).toEqual({ error: "not_found" });

    const wrongHeartbeatMethod = await requestBus(
      socketPath,
      "GET",
      "/heartbeat/agent-b",
    );
    expect(wrongHeartbeatMethod.status).toBe(404);
    expect(wrongHeartbeatMethod.data).toEqual({ error: "not_found" });

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

    const heartbeatErr = await requestBus(
      socketPath,
      "POST",
      "/heartbeat/explode",
    );
    expect(heartbeatErr.status).toBe(500);
    expect(heartbeatErr.data).toEqual({ error: "unknown error" });

    const bad = await requestBus(socketPath, "POST", "/messages", {
      nope: true,
    });
    expect(bad.status).toBe(500);
    expect((bad.data as { error: string }).error).toContain(
      "invalid message body",
    );

    const missingFrom = await requestBus(socketPath, "POST", "/messages", {
      to: "agent-b",
      type: "t",
      payload: {},
    });
    expect((missingFrom.data as { error: string }).error).toContain(
      "invalid message body",
    );

    const missingTo = await requestBus(socketPath, "POST", "/messages", {
      from: "agent-a",
      type: "t",
      payload: {},
    });
    expect((missingTo.data as { error: string }).error).toContain(
      "invalid message body",
    );

    const missingType = await requestBus(socketPath, "POST", "/messages", {
      from: "agent-a",
      to: "agent-b",
      payload: {},
    });
    expect((missingType.data as { error: string }).error).toContain(
      "invalid message body",
    );

    const malformed = await requestRaw(
      socketPath,
      "POST",
      "/messages",
      "{not-json",
    );
    expect(malformed).toBe(500);

    const whitespaceBody = await requestRawResponse(
      socketPath,
      "POST",
      "/messages",
      "   ",
    );
    expect(whitespaceBody.status).toBe(500);
    expect(JSON.parse(whitespaceBody.body)).toEqual({
      error: "invalid message body",
    });

    const emptyBody = await requestBus(socketPath, "POST", "/messages");
    expect(emptyBody.status).toBe(500);
    expect((emptyBody.data as { error: string }).error).toContain(
      "invalid message body",
    );

    expect(fs.existsSync(socketPath)).toBe(true);
    await bus.stop();
    expect(fs.existsSync(socketPath)).toBe(false);
    expect(fs.readFileSync(walPath, "utf8")).toContain('"type":"send"');
    expect(fs.readFileSync(walPath, "utf8")).toContain('"type":"ack"');
  });

  it("delivers to pending long poll immediately on send", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-bus-"));
    const socketPath = path.join(tmp, "bus.sock");
    const walPath = path.join(tmp, "bus.wal");
    const bus = new MessageBus(socketPath, walPath);

    await bus.start({
      status: () => ({}),
      workflowStatus: () => ({}),
      evidence: async () => ({}),
      heartbeat: () => ({}),
    });

    const pending = requestBus(socketPath, "GET", "/inbox/agent-r");
    await new Promise((resolve) => setTimeout(resolve, 10));
    await requestBus(socketPath, "POST", "/messages", {
      from: "agent-s",
      to: "agent-r",
      type: "handoff",
      payload: { x: 1 },
    });

    const delivered = await pending;
    const messages = delivered.data as Array<{ payload: { x: number } }>;
    expect(messages).toHaveLength(1);
    expect(messages[0]?.payload.x).toBe(1);

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

  it("covers internal queue and waiter behaviors", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-bus-"));
    const bus = new MessageBus(
      path.join(tmp, "bus.sock"),
      path.join(tmp, "bus.wal"),
    );

    const appendSpy = vi.fn();
    (bus as unknown as { appendWal: (evt: unknown) => void }).appendWal =
      appendSpy;

    bus.ack(asMessageId("missing"), false);
    expect(appendSpy).toHaveBeenCalledTimes(0);

    const msg = bus.send({
      from: asAgentId("s"),
      to: asAgentId("r"),
      type: "t",
      payload: {},
    });
    expect(appendSpy).toHaveBeenCalledTimes(1);

    const internalBeforeAck = bus as unknown as {
      messages: Map<string, unknown>;
      inboxes: Map<string, string[]>;
    };
    expect(internalBeforeAck.messages.has(msg.id)).toBe(true);
    expect(internalBeforeAck.inboxes.get(asAgentId("r"))?.length).toBe(1);

    bus.ack(msg.id, false);
    expect(appendSpy).toHaveBeenCalledTimes(1);

    const internalAfterAck = bus as unknown as {
      messages: Map<string, unknown>;
      inboxes: Map<string, string[]>;
    };
    expect(internalAfterAck.messages.has(msg.id)).toBe(false);
    expect(internalAfterAck.inboxes.has(asAgentId("r"))).toBe(false);

    const msgA = bus.send({
      from: asAgentId("s"),
      to: asAgentId("multi"),
      type: "t",
      payload: { n: 1 },
    });
    const msgB = bus.send({
      from: asAgentId("s"),
      to: asAgentId("multi"),
      type: "t",
      payload: { n: 2 },
    });
    expect(
      (bus as unknown as { inboxes: Map<string, string[]> }).inboxes.get(
        asAgentId("multi"),
      ),
    ).toEqual([msgA.id, msgB.id]);

    const tampered = bus as unknown as {
      inboxes: Map<string, string[]>;
      messages: Map<string, unknown>;
      ack: (id: string, persist: boolean) => void;
      removeWaiter: (
        id: string,
        resolver: (messages: unknown[]) => void,
      ) => void;
      drain: (id: string) => unknown[];
    };
    tampered.inboxes.set(asAgentId("ghost"), ["missing-id"]);
    expect(tampered.drain(asAgentId("ghost"))).toEqual([]);

    tampered.messages.set(asMessageId("orphan"), {
      id: asMessageId("orphan"),
      from: asAgentId("s"),
      to: asAgentId("orphan-to"),
      type: "t",
      payload: {},
      requires_ack: true,
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    expect(() => tampered.ack(asMessageId("orphan"), false)).not.toThrow();

    tampered.inboxes.set(asAgentId("idx"), ["another-id"]);
    tampered.messages.set(asMessageId("idx-msg"), {
      id: asMessageId("idx-msg"),
      from: asAgentId("s"),
      to: asAgentId("idx"),
      type: "t",
      payload: {},
      requires_ack: true,
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    tampered.ack(asMessageId("idx-msg"), false);
    expect(tampered.inboxes.get(asAgentId("idx"))).toEqual(["another-id"]);
    expect(() =>
      tampered.removeWaiter(asAgentId("none"), vi.fn()),
    ).not.toThrow();

    const waiterResolve = vi.fn();
    const waitersMap = new Map([
      [
        asAgentId("r"),
        [{ resolve: waiterResolve, timeout: setTimeout(() => {}, 1000) }],
      ],
    ]);
    (bus as unknown as { waiters: Map<unknown, unknown> }).waiters = waitersMap;
    (bus as unknown as { drain: (id: unknown) => unknown[] }).drain = () => [];
    (
      bus as unknown as { deliverIfWaiting: (id: unknown) => void }
    ).deliverIfWaiting(asAgentId("r"));
    expect(waiterResolve).not.toHaveBeenCalled();

    (bus as unknown as { waiters: Map<unknown, unknown> }).waiters = new Map([
      [asAgentId("empty"), []],
    ]);
    (bus as unknown as { drain: (id: unknown) => unknown[] }).drain = () => {
      throw new Error("drain should not be called");
    };
    expect(() =>
      (
        bus as unknown as { deliverIfWaiting: (id: unknown) => void }
      ).deliverIfWaiting(asAgentId("empty")),
    ).not.toThrow();

    (bus as unknown as { waiters: Map<unknown, unknown> }).waiters = waitersMap;
    (bus as unknown as { drain: (id: unknown) => unknown[] }).drain = () => [
      { id: "m" },
    ];
    (
      bus as unknown as { deliverIfWaiting: (id: unknown) => void }
    ).deliverIfWaiting(asAgentId("r"));
    expect(waiterResolve).toHaveBeenCalledTimes(1);
    expect(
      (
        bus as unknown as {
          waiters: Map<unknown, Array<{ resolve: () => void }>>;
        }
      ).waiters.get(asAgentId("r")),
    ).toEqual([]);

    const resolverA = vi.fn();
    const resolverB = vi.fn();
    const timeoutA = setTimeout(() => {}, 1000);
    const timeoutB = setTimeout(() => {}, 1000);
    (bus as unknown as { waiters: Map<unknown, unknown> }).waiters = new Map([
      [
        asAgentId("x"),
        [
          { resolve: resolverA, timeout: timeoutA },
          { resolve: resolverB, timeout: timeoutB },
        ],
      ],
    ]);
    (
      bus as unknown as {
        removeWaiter: (
          id: unknown,
          resolver: (messages: unknown[]) => void,
        ) => void;
      }
    ).removeWaiter(asAgentId("x"), resolverA);

    const remaining = (
      (
        bus as unknown as {
          waiters: Map<unknown, Array<{ resolve: () => void }>>;
        }
      ).waiters.get(asAgentId("x")) ?? []
    ).map((entry) => entry.resolve);
    expect(remaining).toEqual([resolverB]);

    clearTimeout(timeoutA);
    clearTimeout(timeoutB);
  });

  it("replays wal dead-letter events", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-bus-"));
    const socketPath = path.join(tmp, "bus.sock");
    const walPath = path.join(tmp, "bus.wal");

    fs.writeFileSync(
      walPath,
      `${JSON.stringify({
        type: "dead-letter",
        message: {
          id: "msg-1",
          from: "a",
          to: "b",
          type: "handoff",
          timestamp: "2026-01-01T00:00:00.000Z",
          payload: {},
          requires_ack: true,
        },
      })}\n`,
    );

    const bus = new MessageBus(socketPath, walPath);
    await bus.start({
      status: () => ({}),
      workflowStatus: () => ({}),
      evidence: async () => ({}),
      heartbeat: () => ({}),
    });

    const deadLetters = (bus as unknown as { deadLetters: unknown[] })
      .deadLetters;
    expect(deadLetters).toHaveLength(1);

    await bus.stop();
  });

  it("replays WAL send events preserving queue order", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-bus-"));
    const socketPath = path.join(tmp, "bus.sock");
    const walPath = path.join(tmp, "bus.wal");

    const firstId = asMessageId("m-a");
    const secondId = asMessageId("m-b");
    fs.writeFileSync(
      walPath,
      `${[
        {
          type: "send",
          message: {
            id: firstId,
            from: asAgentId("x"),
            to: asAgentId("y"),
            type: "work",
            payload: { id: 1 },
            requires_ack: true,
            timestamp: "2026-01-01T00:00:00.000Z",
          },
        },
        {
          type: "send",
          message: {
            id: secondId,
            from: asAgentId("x"),
            to: asAgentId("y"),
            type: "work",
            payload: { id: 2 },
            requires_ack: true,
            timestamp: "2026-01-01T00:00:01.000Z",
          },
        },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n")}
`,
    );

    const bus = new MessageBus(socketPath, walPath);
    await bus.start({
      status: () => ({}),
      workflowStatus: () => ({}),
      evidence: async () => ({}),
      heartbeat: () => ({}),
    });

    const inbox = await bus.longPollInbox(asAgentId("y"), 10);
    expect(inbox.map((m) => m.id)).toEqual([firstId, secondId]);

    await bus.stop();
  });

  it("replays WAL send and ack events deterministically", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-bus-"));
    const socketPath = path.join(tmp, "bus.sock");
    const walPath = path.join(tmp, "bus.wal");

    const firstId = asMessageId("m-1");
    const secondId = asMessageId("m-2");
    fs.writeFileSync(
      walPath,
      `${[
        {
          type: "send",
          message: {
            id: firstId,
            from: asAgentId("x"),
            to: asAgentId("y"),
            type: "work",
            payload: { id: 1 },
            requires_ack: true,
            timestamp: "2026-01-01T00:00:00.000Z",
          },
        },
        {
          type: "send",
          message: {
            id: secondId,
            from: asAgentId("x"),
            to: asAgentId("y"),
            type: "work",
            payload: { id: 2 },
            requires_ack: true,
            timestamp: "2026-01-01T00:00:01.000Z",
          },
        },
        { type: "ack", messageId: firstId },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n")}
`,
    );

    const bus = new MessageBus(socketPath, walPath);
    await bus.start({
      status: () => ({}),
      workflowStatus: () => ({}),
      evidence: async () => ({}),
      heartbeat: () => ({}),
    });

    const walLinesAfterReplay = fs
      .readFileSync(walPath, "utf8")
      .split("\n")
      .filter(Boolean);
    expect(walLinesAfterReplay).toHaveLength(3);

    const inbox = await bus.longPollInbox(asAgentId("y"), 10);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.id).toBe(secondId);

    await bus.stop();
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

    const duplicate = first.send({
      id: sent.id,
      from: asAgentId("x"),
      to: asAgentId("y"),
      type: "work",
      payload: { id: 2 },
    });
    expect(duplicate.id).toBe(sent.id);
    expect(duplicate.payload).toEqual({ id: 1 });

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
    expect(inbox[0]?.requires_ack).toBe(true);

    second.ack(sent.id);
    const empty = await second.longPollInbox(asAgentId("y"), 20);
    expect(empty).toHaveLength(0);

    await second.stop();
  });
});
