// 决策闸门 probe 路由：fixture 精度测试与 replay 实验的专用入口（spec §4.1）。
// 护栏：production 404 + ALLOW_DECISION_PROBE=1 显式开关 + 仅 localhost + body ≤32KB。
import { NextResponse } from "next/server";
import { checkPriceAmounts, gateMode, gateThresholds, gateRuntimeStatus, runReplyGate, selfTestRedaction } from "@/lib/decision";

export const runtime = "nodejs";

export async function GET() {
  if (process.env.NODE_ENV === "production") return NextResponse.json({ error: "Not Found" }, { status: 404 });
  if (process.env.ALLOW_DECISION_PROBE !== "1") return NextResponse.json({ error: "需要设置 ALLOW_DECISION_PROBE=1" }, { status: 403 });
  return NextResponse.json({ mode: gateMode(), thresholds: gateThresholds(), runtime: gateRuntimeStatus() });
}

export async function POST(req: Request) {
  if (process.env.NODE_ENV === "production") return NextResponse.json({ error: "Not Found" }, { status: 404 });
  if (process.env.ALLOW_DECISION_PROBE !== "1") return NextResponse.json({ error: "需要设置 ALLOW_DECISION_PROBE=1" }, { status: 403 });
  const host = new URL(req.url).hostname;
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "[::1]") return NextResponse.json({ error: "probe 仅允许 localhost" }, { status: 403 });
  const raw = await req.text();
  if (raw.length > 32 * 1024) return NextResponse.json({ error: "payload 超过 32KB" }, { status: 413 });
  let body: any;
  try { body = JSON.parse(raw); } catch { return NextResponse.json({ error: "payload 不是合法 JSON" }, { status: 400 }); }
  if (body?.selfTest) return NextResponse.json(selfTestRedaction());
  if (typeof body?.userInput !== "string" || typeof body?.candidateReply !== "string") {
    return NextResponse.json({ error: "缺少 userInput / candidateReply" }, { status: 400 });
  }
  // priceCheck 由服务端统一计算（单一真源）：传 price 即启用确定性价格预检（replay 归因用）。
  const priceCheck = body.price ? checkPriceAmounts(body.candidateReply, body.price, body.need) : undefined;
  const verdict = await runReplyGate({
    userInput: body.userInput,
    candidateReply: body.candidateReply,
    history: Array.isArray(body.history) ? body.history : [],
    need: body.need,
    verifiedFacts: body.verifiedFacts,
    priceCheck,
    thresholdsOverride: body.thresholds
  });
  return NextResponse.json({ verdict, thresholds: verdict.thresholds, priceCheck });
}
