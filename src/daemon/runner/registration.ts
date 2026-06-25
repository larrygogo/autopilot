import { HttpRunnerBackend, type FetchLike } from "./backend";
import { saveCredentials, loadCredentials } from "./credentials";
import type { RunnerCredentials } from "./types";

export interface RegisterInput {
  /** reqgenie 控制平面 URL。 */
  url: string;
  /** runner 展示名（machine name）。 */
  name: string;
  /** 一次性注册 token 的读取器（CLI 接 stdin，避免进 shell history）。 */
  readToken: () => Promise<string>;
  /** 测试注入。 */
  fetchFn?: FetchLike;
}

/**
 * 注册流程（§7.1）：读注册 token → 换长期凭证 → 落盘（ACL 收紧）。
 * 已有凭证时拒绝覆盖（先 remove）——避免误覆盖正在用的 runner 身份。
 */
export async function registerRunner(input: RegisterInput): Promise<RunnerCredentials> {
  if (loadCredentials()) {
    throw new Error("本机已注册 runner；先运行 `autopilot runner remove` 再重新注册。");
  }
  const token = (await input.readToken()).trim();
  if (!token) throw new Error("注册 token 为空。");
  const { runner_id, secret } = await HttpRunnerBackend.register(
    input.url,
    token,
    input.name,
    input.fetchFn ?? fetch,
  );
  const creds: RunnerCredentials = {
    control_plane_url: input.url.replace(/\/+$/, ""),
    runner_id,
    secret,
  };
  saveCredentials(creds);
  return creds;
}
