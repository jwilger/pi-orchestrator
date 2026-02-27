import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { nanoid } from "nanoid";
import type { AgentId, Message, MessageId } from "./types";
import { asMessageId } from "./types";

interface PendingInboxWaiter {
  resolve: (messages: Message[]) => void;
  timeout: NodeJS.Timeout;
}

type WalEvent =
  | { type: "send"; message: Message }
  | { type: "ack"; messageId: MessageId }
  | { type: "dead-letter"; message: Message };

export class MessageBus {
  private messages = new Map<MessageId, Message>();
  private inboxes = new Map<AgentId, MessageId[]>();
  private waiters = new Map<AgentId, PendingInboxWaiter[]>();
  private deadLetters: Message[] = [];
  private server?: http.Server;

  constructor(
    private readonly socketPath: string,
    private readonly walPath: string,
  ) {}

  start(handlers: {
    status: () => unknown;
    workflowStatus: (workflowId: string) => unknown;
    evidence: (workflowId: string, body: unknown) => Promise<unknown>;
    heartbeat: (agentId: string) => unknown;
  }): Promise<void> {
    this.replayWal();
    fs.mkdirSync(path.dirname(this.socketPath), { recursive: true });
    fs.rmSync(this.socketPath, { force: true });

    this.server = http.createServer(async (req, res) => {
      try {
        const url = req.url as string;
        const method = req.method as string;

        if (method === "POST" && url === "/messages") {
          const body = await readBody(req);
          const message = this.send(parseSendInput(body));
          respondJson(res, 200, { id: message.id, status: "queued" });
          return;
        }

        if (method === "GET" && url.startsWith("/inbox/")) {
          const agentId = decodeURIComponent(
            url.slice("/inbox/".length),
          ) as AgentId;
          const messages = await this.longPollInbox(agentId, 30_000);
          respondJson(res, 200, messages);
          return;
        }

        if (method === "POST" && url.startsWith("/ack/")) {
          const messageId = decodeURIComponent(
            url.slice("/ack/".length),
          ) as MessageId;
          this.ack(messageId);
          respondJson(res, 200, { ok: true });
          return;
        }

        if (method === "POST" && url.startsWith("/evidence/")) {
          const workflowId = decodeURIComponent(url.slice("/evidence/".length));
          const body = await readBody(req);
          const outcome = await handlers.evidence(workflowId, body);
          respondJson(res, 200, outcome);
          return;
        }

        if (method === "GET" && url === "/status") {
          respondJson(res, 200, handlers.status());
          return;
        }

        if (method === "GET" && url.startsWith("/status/")) {
          const workflowId = decodeURIComponent(url.slice("/status/".length));
          respondJson(res, 200, handlers.workflowStatus(workflowId));
          return;
        }

        if (method === "POST" && url.startsWith("/heartbeat/")) {
          const agentId = decodeURIComponent(url.slice("/heartbeat/".length));
          respondJson(res, 200, handlers.heartbeat(agentId));
          return;
        }

        respondJson(res, 404, { error: "not_found" });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "unknown error";
        respondJson(res, 500, { error: message });
      }
    });

    const server = this.server;
    return new Promise((resolve) => {
      server.listen(this.socketPath, () => {
        fs.chmodSync(this.socketPath, 0o600);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    const server = this.server;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    fs.rmSync(this.socketPath, { force: true });
  }

  send(
    input: Partial<Message> & {
      from: AgentId;
      to: AgentId;
      type: string;
      payload: unknown;
    },
  ): Message {
    const id = asMessageId(input.id ?? nanoid());
    if (this.messages.has(id)) {
      return this.messages.get(id) as Message;
    }

    const message: Message = {
      id,
      from: input.from,
      to: input.to,
      type: input.type,
      payload: input.payload,
      requires_ack: input.requires_ack ?? true,
      timestamp: input.timestamp ?? new Date().toISOString(),
      ...(input.workflow_id ? { workflow_id: input.workflow_id } : {}),
      ...(input.phase ? { phase: input.phase } : {}),
    };

    this.messages.set(message.id, message);
    const existingQueue = this.inboxes.get(message.to);
    if (existingQueue) {
      existingQueue.push(message.id);
    } else {
      this.inboxes.set(message.to, [message.id]);
    }
    this.appendWal({ type: "send", message });
    this.deliverIfWaiting(message.to);
    return message;
  }

  ack(messageId: MessageId, persist = true): void {
    const message = this.messages.get(messageId);
    if (!message) {
      return;
    }

    this.messages.delete(messageId);
    const queue = this.inboxes.get(message.to);
    if (queue) {
      const index = queue.indexOf(messageId);
      if (index >= 0) {
        queue.splice(index, 1);
      }
      if (queue.length === 0) {
        this.inboxes.delete(message.to);
      }
    }
    if (persist) {
      this.appendWal({ type: "ack", messageId });
    }
  }

  async longPollInbox(agentId: AgentId, timeoutMs: number): Promise<Message[]> {
    const current = this.drain(agentId);
    if (current.length > 0) {
      return current;
    }

    return new Promise<Message[]>((resolve) => {
      const timeout = setTimeout(() => {
        this.removeWaiter(agentId, resolve);
        resolve([]);
      }, timeoutMs);

      const entries = this.waiters.get(agentId) ?? [];
      entries.push({ resolve, timeout });
      this.waiters.set(agentId, entries);
    });
  }

  private drain(agentId: AgentId): Message[] {
    const queue = this.inboxes.get(agentId);
    if (!queue) {
      return [];
    }

    const messages: Message[] = [];
    for (const id of queue) {
      const message = this.messages.get(id);
      if (message) {
        messages.push(message);
      }
    }
    return messages;
  }

  private deliverIfWaiting(agentId: AgentId): void {
    const waiters = this.waiters.get(agentId);
    if (!waiters || waiters.length === 0) {
      return;
    }

    const messages = this.drain(agentId);
    if (messages.length === 0) {
      return;
    }

    this.waiters.set(agentId, []);
    for (const waiter of waiters) {
      clearTimeout(waiter.timeout);
      waiter.resolve(messages);
    }
  }

  private removeWaiter(
    agentId: AgentId,
    resolver: (messages: Message[]) => void,
  ): void {
    const waiters = this.waiters.get(agentId);
    if (!waiters) {
      return;
    }

    this.waiters.set(
      agentId,
      waiters.filter((entry) => entry.resolve !== resolver),
    );
  }

  private appendWal(event: WalEvent): void {
    fs.mkdirSync(path.dirname(this.walPath), { recursive: true });
    fs.appendFileSync(this.walPath, `${JSON.stringify(event)}\n`);
  }

  private replayWal(): void {
    if (!fs.existsSync(this.walPath)) {
      return;
    }

    const lines = fs
      .readFileSync(this.walPath, "utf8")
      .split("\n")
      .filter(Boolean);
    for (const line of lines) {
      const event = JSON.parse(line) as WalEvent;
      switch (event.type) {
        case "send": {
          const message = event.message;
          this.messages.set(message.id, message);
          const queue = this.inboxes.get(message.to);
          if (queue) {
            queue.push(message.id);
          } else {
            this.inboxes.set(message.to, [message.id]);
          }
          break;
        }
        case "ack":
          this.ack(event.messageId, false);
          break;
        case "dead-letter":
          this.deadLetters.push(event.message);
          break;
      }
    }
  }
}

const readBody = async (req: http.IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw) as unknown;
};

const respondJson = (
  res: http.ServerResponse,
  status: number,
  payload: unknown,
): void => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
};

const parseSendInput = (
  body: unknown,
): Partial<Message> & {
  from: AgentId;
  to: AgentId;
  type: string;
  payload: unknown;
} => {
  const input = (body ?? {}) as Record<string, unknown>;
  if (!input.from || !input.to || !input.type) {
    throw new Error("invalid message body");
  }

  return {
    ...input,
    from: input.from as AgentId,
    to: input.to as AgentId,
    type: String(input.type),
    payload: input.payload,
  };
};
