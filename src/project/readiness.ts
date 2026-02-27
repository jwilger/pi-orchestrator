import type { CutlineStatus } from "./cutline";

export interface ReadinessReport {
  ready: boolean;
  reasons: string[];
  summary: {
    shipNowCount: number;
    deferredCount: number;
    mutationGate: string;
    requiredChecks: string[];
  };
}

export const buildReadinessReport = (
  cutline: CutlineStatus,
): ReadinessReport => {
  const reasons: string[] = [];
  if (cutline.shipNow.length === 0) {
    reasons.push("No ship-now capabilities were recorded");
  }

  const ready = reasons.length === 0;
  return {
    ready,
    reasons,
    summary: {
      shipNowCount: cutline.shipNow.length,
      deferredCount: cutline.deferred.length,
      mutationGate: "100%",
      requiredChecks: ["lint", "typecheck", "test", "mutation"],
    },
  };
};
