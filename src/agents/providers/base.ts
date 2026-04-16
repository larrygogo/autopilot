import type { AgentResult, RunOptions } from "../types";

export abstract class BaseProvider {
  constructor(protected config: Record<string, unknown>) {}
  abstract run(prompt: string, options?: RunOptions): Promise<AgentResult>;
  abstract close(): Promise<void>;
}
