export type CheckStatus = "ok" | "warning" | "error" | "skipped";
export type CheckCategory = "config" | "provider" | "agent" | "project" | "codebase";

export type FixId =
  | "init.providers"
  | "init.agents"
  | "fix.config.create"
  | "fix.agent.unbind-disabled-provider";

export interface CheckResult {
  id: string;
  category: CheckCategory;
  status: CheckStatus;
  title: string;
  detail?: string;
  fix?: { cli?: string; url?: string; auto?: FixId };
}

export interface DoctorReport {
  level: 1 | 2 | 3;
  status: "ok" | "warning" | "error";
  checks: CheckResult[];
  durationMs: number;
  generatedAt: string;
}

export interface RunChecksOptions {
  level: 1 | 2 | 3;
  providers?: string[];
}

export async function runChecks(opts: RunChecksOptions): Promise<DoctorReport> {
  const startedAt = Date.now();
  return {
    level: opts.level,
    status: "ok",
    checks: [],
    durationMs: Date.now() - startedAt,
    generatedAt: new Date().toISOString(),
  };
}
