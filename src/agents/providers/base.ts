import type { AgentResult, RunOptions } from "../types";

export abstract class BaseProvider {
  constructor(protected config: Record<string, unknown>) {}
  abstract run(prompt: string, options?: RunOptions): Promise<AgentResult>;
  abstract close(): Promise<void>;

  protected buildRunOptions(options?: RunOptions): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    if (options?.cwd) result["cwd"] = options.cwd;
    if (options?.timeout !== undefined) result["timeout_ms"] = options.timeout;
    if (options?.signal) result["signal"] = options.signal;
    return result;
  }
}
