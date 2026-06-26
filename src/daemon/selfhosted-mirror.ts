/**
 * selfhosted-mirror —— daemon 驻留订阅器，把关键里程碑状态回传给外部系统。
 *
 * 设计要点：
 * - 仅对 source='reqgenie' 且 callback_url 非空的需求生效（其余需求零开销）
 * - 里程碑集合：queued / awaiting_review / done / failed（过程态不回传）
 * - 回传是 best-effort：fetch 失败只 warn，不阻塞主流程
 * - 防重复：内存 Map 记录「已发送的 reqId+status」，daemon 重启自然清零（acceptable）
 * - HMAC-SHA256 签名：对 JSON body 算，放 header X-Reqgenie-Signature
 */

import { createHmac } from "crypto";
import { onEvent, offEvent } from "../core/event-bus";
import type { AutopilotEvent } from "../core/events";
import { getRequirementById } from "../core/requirements";
import { listSubPrs } from "../core/requirements/sub-prs";
import { createLogger } from "../core/logger";

const log = createLogger("selfhosted-mirror");

/** 里程碑状态集合（过程态不回传） */
const MILESTONE_STATUSES = new Set(["queued", "awaiting_review", "done", "failed"]);

/** 防重复缓存：key = `${reqId}:${status}` */
const _sent = new Map<string, true>();

/** 计算 HMAC-SHA256 签名（hex），对 UTF-8 encoded JSON body 算 */
function computeSignature(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

/**
 * 从需求的 sub_prs 或 pr_url 列取第一条 PR URL。
 * awaiting_review / done 时调用；取不到返回 undefined。
 */
function resolvePrUrl(reqId: string, reqPrUrl: string | null): string | undefined {
  // sub_prs 优先（多库场景下 pr_url 可能是第一库的，sub_prs 是全集）
  const subPrs = listSubPrs(reqId);
  const first = subPrs.find((sp) => sp.pr_url);
  if (first) return first.pr_url;
  return reqPrUrl ?? undefined;
}

/** 实际发送回调（async，调用方不 await） */
async function sendCallback(
  callbackUrl: string,
  secret: string | null,
  linkId: string,
  autopilotReqId: string,
  status: string,
  prUrl: string | undefined,
): Promise<void> {
  const payload: Record<string, string | undefined> = {
    link_id: linkId,
    autopilot_req_id: autopilotReqId,
    status,
    pr_url: prUrl,
  };
  // 去掉 undefined 字段，保持 JSON 干净
  const body = JSON.stringify(Object.fromEntries(Object.entries(payload).filter(([, v]) => v !== undefined)));

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (secret) {
    headers["X-Reqgenie-Signature"] = computeSignature(body, secret);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const resp = await fetch(callbackUrl, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    if (!resp.ok) {
      log.warn(
        "回传失败 link_id=%s status=%s → HTTP %d %s",
        linkId, status, resp.status, resp.statusText,
      );
    } else {
      log.info("回传成功 link_id=%s status=%s", linkId, status);
    }
  } catch (e: unknown) {
    log.warn(
      "回传异常 link_id=%s status=%s: %s",
      linkId, status, e instanceof Error ? e.message : String(e),
    );
  } finally {
    clearTimeout(timer);
  }
}

// ── 事件 handler ──────────────────────────────

function onReqStatusChanged(event: AutopilotEvent): void {
  if (event.type !== "requirement:status-changed") return;
  const { id, to } = event.payload;

  // 非里程碑状态直接跳过
  if (!MILESTONE_STATUSES.has(to)) return;

  // 防重复
  const dedupeKey = `${id}:${to}`;
  if (_sent.has(dedupeKey)) return;

  const req = getRequirementById(id);
  if (!req) return;

  // 仅 reqgenie 来源且有 callback_url 的需求才回传
  if (req.source !== "reqgenie" || !req.callback_url || !req.external_ref) return;

  // 标记已发（先占坑，防止 async 期间重复触发）
  _sent.set(dedupeKey, true);

  // PR URL（awaiting_review / done 时尝试取）
  let prUrl: string | undefined;
  if (to === "awaiting_review" || to === "done") {
    prUrl = resolvePrUrl(id, req.pr_url);
  }

  // best-effort，不 await，失败只 warn
  sendCallback(req.callback_url, req.callback_secret, req.external_ref, id, to, prUrl).catch(
    (e: unknown) => {
      // sendCallback 内部已 try/catch，这里是兜底——理论上不会走到
      log.warn(
        "sendCallback 意外抛出 link_id=%s: %s",
        req.external_ref, e instanceof Error ? e.message : String(e),
      );
    },
  );
}

// ── 生命周期 ──────────────────────────────

const SUBSCRIPTIONS: Array<[string, (e: AutopilotEvent) => void]> = [
  ["requirement:status-changed", onReqStatusChanged],
];

export function initSelfhostedMirror(): () => void {
  for (const [type, handler] of SUBSCRIPTIONS) onEvent(type, handler);
  log.info("selfhosted-mirror 已启动（订阅需求里程碑回传）");

  return () => {
    for (const [type, handler] of SUBSCRIPTIONS) offEvent(type, handler);
    _sent.clear();
  };
}
