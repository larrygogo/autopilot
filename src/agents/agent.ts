import type { BaseProvider } from "./providers/base";
import type { AgentConfig, AgentResult, RunOptions } from "./types";

export class Agent {
  constructor(
    readonly name: string,
    private provider: BaseProvider,
    readonly config: AgentConfig
  ) {}

  async run(prompt: string, options?: RunOptions): Promise<AgentResult> {
    return this.provider.run(prompt, options);
  }

  async close(): Promise<void> {
    return this.provider.close();
  }
}
