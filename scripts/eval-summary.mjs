// 按时间窗汇总评测结果为四态统计:node scripts/eval-summary.mjs [sinceISO] [--gate]
// 四态规则:ERROR = 执行失败或 capabilityPath 为空;FAIL = passed:false;
// REVIEW = passed:true 但 score<95 或 judge 有 issue;PASS = 其余。
// --gate: 增加闸门列（gateMode/gateStatus/gateAction），并单列"预期拦截"与"闸门上游跳过"。
import { readFile } from "fs/promises";

const args = process.argv.slice(2);
const sinceArg = args.find(a => !a.startsWith("--"));
const showGate = args.includes("--gate");
const since = sinceArg ? new Date(sinceArg) : new Date(0);
const results = JSON.parse(await readFile("data/eval-results.json", "utf8"))
  .filter(r => new Date(r.createdAt) >= since)
  .sort((a, b) => a.createdAt < b.createdAt ? -1 : 1);

const UPSTREAM_SKIP = new Set(["timeout", "rate_limited", "network", "upstream", "contract", "circuit_open", "auth"]);
const stateOf = r => {
  if (!r.capabilityPath?.length || r.issues?.[0]?.startsWith("执行失败")) return "ERROR";
  if (!r.passed) return "FAIL";
  if (r.score < 95 || r.judge?.issues?.length) return "REVIEW";
  return "PASS";
};
const order = ["PASS", "REVIEW", "FAIL", "ERROR"];
const counts = Object.fromEntries(order.map(s => [s, 0]));
results.forEach(r => counts[stateOf(r)]++);

console.log(`时间窗: ${since.toISOString()} 起,共 ${results.length} 条\n`);
console.log(order.map(s => `${s} ${counts[s]}`).join(" | "));

if (showGate) {
  const gateGroups = {};
  results.forEach(r => { const key = `${r.gateMode || "n/a"}:${r.gateStatus || "n/a"}`; gateGroups[key] = (gateGroups[key] || 0) + 1; });
  console.log(`\n闸门分布 (gateMode:gateStatus):`);
  Object.entries(gateGroups).sort().forEach(([key, count]) => console.log(`  ${key}  ${count}`));
  const upstreamSkips = results.filter(r => r.gateStatus === "skipped" && UPSTREAM_SKIP.has(r.gateSkipReason || ""));
  const errors = results.filter(r => r.gateStatus === "error");
  if (upstreamSkips.length || errors.length) {
    console.log(`\n⚠ 闸门上游跳过 ${upstreamSkips.length} 条 / error ${errors.length} 条 — live 组若出现应整组标 INVALID:`);
    [...upstreamSkips, ...errors].slice(0, 10).forEach(r => console.log(`  ${r.caseId}: ${r.gateSkipReason || r.gateStatus}`));
  }
  console.log(`\n| # | 时间 | 用例 | 状态 | 闸门 | 总分 | planner/skills/tools/response/risk/perf | 延迟 |`);
  console.log(`|---|---|---|---|---|---|---|---|`);
  results.forEach((r, i) => {
    const L = r.layerScores || {};
    const layers = [L.planner, L.skills, L.tools, L.response, L.risk, L.performance].map(v => v ?? "-").join("/");
    const gate = `${r.gateStatus || "-"}${r.gateAction ? `(${r.gateAction})` : ""}`;
    console.log(`| ${i + 1} | ${r.createdAt.slice(11, 19)} | ${r.caseId} | ${stateOf(r)} | ${gate} | ${r.score} | ${layers} | ${r.latencyMs}ms |`);
  });
} else {
  console.log(`\n| # | 时间 | 用例 | 状态 | 总分 | planner/skills/tools/response/risk/perf | 延迟 |`);
  console.log(`|---|---|---|---|---|---|---|`);
  results.forEach((r, i) => {
    const L = r.layerScores || {};
    const layers = [L.planner, L.skills, L.tools, L.response, L.risk, L.performance].map(v => v ?? "-").join("/");
    console.log(`| ${i + 1} | ${r.createdAt.slice(11, 19)} | ${r.caseId} | ${stateOf(r)} | ${r.score} | ${layers} | ${r.latencyMs}ms |`);
  });
}
const risky = results.filter(r => stateOf(r) === "FAIL" && (r.layerScores?.risk === 0 || (r.issues || []).some(x => /禁用表述|风控/.test(x))));
if (risky.length) console.log(`\n高风险 FAIL(${risky.length}): ${risky.map(r => r.caseId).join(", ")}`);
const issues = results.filter(r => r.issues?.length);
if (issues.length) {
  console.log("\n问题明细:");
  issues.forEach(r => console.log(`  ${r.caseId}: ${r.issues.join(";").slice(0, 200)}`));
}
