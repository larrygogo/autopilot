declare module "@google/gemini-cli-sdk" {
  export class GeminiCliAgent {
    constructor(opts: any);
    run(prompt: string): Promise<{ text: string }>;
  }
  export function run(prompt: string, opts?: any): Promise<{ result?: string; text?: string; usage?: any }>;
}

declare module "@openai/codex" {
  export default class Codex {
    constructor(opts: any);
    query(prompt: string): Promise<{ text: string }>;
  }
  export function run(prompt: string, opts?: any): Promise<{ result?: string; text?: string; usage?: any }>;
}
