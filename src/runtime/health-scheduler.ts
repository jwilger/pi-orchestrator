export interface HealthCheckResult {
  name: string;
  ok: boolean;
  message: string;
}

export type HealthCheck = () => Promise<HealthCheckResult> | HealthCheckResult;

export interface HealthEscalation {
  at: string;
  streak: number;
  failing: HealthCheckResult[];
}

export class HealthScheduler {
  private timer: NodeJS.Timeout | undefined;
  private failureStreak = 0;
  private escalation: HealthEscalation | undefined;

  constructor(
    private readonly intervalMs: number,
    private readonly checks: HealthCheck[],
    private readonly onResults: (results: HealthCheckResult[]) => void,
    private readonly onEscalation?: (escalation: HealthEscalation) => void,
    private readonly escalationThreshold = 3,
  ) {}

  start(): void {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.intervalMs);
  }

  async runOnce(): Promise<HealthCheckResult[]> {
    const results: HealthCheckResult[] = [];
    for (const check of this.checks) {
      try {
        results.push(await check());
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "health check failed";
        results.push({ name: "unknown", ok: false, message });
      }
    }

    const failing = results.filter((result) => !result.ok);
    if (failing.length > 0) {
      this.failureStreak += 1;
    } else {
      this.failureStreak = 0;
      this.escalation = undefined;
    }

    if (failing.length > 0 && this.failureStreak >= this.escalationThreshold) {
      const escalation: HealthEscalation = {
        at: new Date().toISOString(),
        streak: this.failureStreak,
        failing,
      };
      this.escalation = escalation;
      this.onEscalation?.(escalation);
    }

    this.onResults(results);
    return results;
  }

  getState(): {
    failureStreak: number;
    escalationThreshold: number;
    escalation?: HealthEscalation;
  } {
    return {
      failureStreak: this.failureStreak,
      escalationThreshold: this.escalationThreshold,
      ...(this.escalation ? { escalation: this.escalation } : {}),
    };
  }

  stop(): void {
    if (!this.timer) {
      return;
    }
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
