// Replay 实验（spec §4.2，Round 2 N5）：对 off 组落盘的固定回复重放闸门，消除生成方差。
// 用法: node scripts/replay-gate.mjs --since "2026-10-24Txx:xx:xx" [--tag mock]
// 前置: dev server 以 STARTLUX_GATE_MODE=mock|live + ALLOW_DECISION_PROBE=1 启动。
// 输入: data/eval-results.json 中 --since 之后的 off 组结果（finalReply + trace）；
//       userInput 从 GET /api/evaluations 的用例清单按 caseId 取回。
// 输出: data/gate-replay-<tag>.json —— 每条的闸门判定 + 汇总（误拦/拦截/跳过分布）。
import { readFile, writeFile } from "fs/promises";

const base = process.env.EVAL_BASE || "http://localhost:3199";
const args = process.argv.slice(2);
const sinceIdx = args.indexOf("--since");
const since = sinceIdx >= 0 ? new Date(args[sinceIdx + 1]) : new Date(0);
const tag = args.includes("--tag") ? args[args.indexOf("--tag") + 1] : "replay";
const FRAUD_KEYWORD = /中奖|保证金|验证码|刷单|解冻|转账|汇款|手续费/;

const list = await fetch(`${base}/api/evaluations`).then(r => r.json());
const caseInputs = new Map((list.cases || []).map(c => [c.id, c.input]));
const all = JSON.parse(await readFile("data/eval-results.json", "utf8"));
const offResults = all.filter(r => new Date(r.createdAt) >= since && r.finalReply && r.capabilityPath?.length);
console.log(`off 组结果 ${offResults.length} 条（since=${since.toISOString()}），开始重放…`);

// 从 trace 重建 verifiedFacts（与 lib/decision.ts buildVerifiedFacts 同构，输入来自 EvaluationResult.trace）
function factsFromTrace(trace = []) {
  const facts = {};
  const put = (capability, value) => {
    if (value === undefined || value === null) return;
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (text.trim()) facts[capability] = text.slice(0, 600);
  };
  let price, need, selectedIds;
  for (const step of trace) {
    if (step.type === "tool") put(step.capability, step.output);
    if (step.type === "skill" && !["need-extraction", "recommendation-decision", "recommendation-reason", "response-generator", "risk-check"].includes(step.capability)) put(step.capability, step.output);
    if (step.capability === "calculate_price") price = step.output;
    if (step.capability === "need-extraction") need = step.output;
    if (step.capability === "recommendation-decision") selectedIds = step.output?.recommended_product_ids;
    if (step.capability === "query_products" && selectedIds?.length) put("selected_products", (step.output?.products || []).filter(p => selectedIds.includes(p.id)).map(p => ({ id: p.id, name: p.name, price: p.price })));
  }
  if (price) put("calculate_price", price);
  if (need) put("need-extraction", { taste: need.taste, categories: need.categories, constraints: need.constraints, budget: need.budget });
  return { facts, need, price };
}

const records = [];
for (const r of offResults) {
  const userInput = caseInputs.get(r.caseId) || "";
  const { facts, need, price } = factsFromTrace(r.trace);
  try {
    const res = await fetch(`${base}/api/decision/probe`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userInput, candidateReply: r.finalReply, need, verifiedFacts: facts, price }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.status);
    const v = data.verdict;
    records.push({ caseId: r.caseId, evalPassed: r.passed, gateStatus: v.status, gateAction: v.action, blockedBy: v.blockedBy, skipReason: v.skipReason, fraudKeyword: FRAUD_KEYWORD.test(userInput), latencyMs: v.latencyMs });
    console.log(`${v.status.padEnd(7)} ${r.caseId}${v.blockedBy ? ` (${v.blockedBy})` : ""}`);
  } catch (error) {
    records.push({ caseId: r.caseId, error: String(error.message) });
    console.log(`ERROR    ${r.caseId} :: ${error.message}`);
  }
}

const valid = records.filter(r => !r.error);
const summary = {
  total: valid.length,
  passed: valid.filter(r => r.gateStatus === "passed").length,
  blocked: valid.filter(r => r.gateStatus === "blocked").length,
  skipped: valid.filter(r => r.gateStatus === "skipped").length,
  error: valid.filter(r => r.gateStatus === "error").length,
  blockedList: valid.filter(r => r.gateStatus === "blocked").map(r => ({ caseId: r.caseId, blockedBy: r.blockedBy }))
};
await writeFile(`data/gate-replay-${tag}.json`, JSON.stringify({ capturedAt: new Date().toISOString(), since: since.toISOString(), summary, records }, null, 2));
console.log(`\n重放汇总: passed=${summary.passed} blocked=${summary.blocked} skipped=${summary.skipped} error=${summary.error}`);
if (summary.blockedList.length) console.log("拦截明细:", JSON.stringify(summary.blockedList, null, 1).slice(0, 800));
console.log(`已写入 data/gate-replay-${tag}.json`);
