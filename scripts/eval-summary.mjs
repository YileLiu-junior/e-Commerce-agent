// 按时间窗汇总评测结果为四态统计:node scripts/eval-summary.mjs [sinceISO]
// 四态规则:ERROR = 执行失败或 capabilityPath 为空;FAIL = passed:false;
// REVIEW = passed:true 但 score<95 或 judge 有 issue;PASS = 其余。
import { readFile } from "fs/promises";

const since = process.argv[2] ? new Date(process.argv[2]) : new Date(0);
const results = JSON.parse(await readFile("data/eval-results.json", "utf8"))
  .filter(r => new Date(r.createdAt) >= since)
  .sort((a, b) => a.createdAt < b.createdAt ? -1 : 1);

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
console.log(`\n| # | 时间 | 用例 | 状态 | 总分 | planner/skills/tools/response/risk/perf | 延迟 |`);
console.log("|---|---|---|---|---|---|---|");
results.forEach((r, i) => {
  const L = r.layerScores || {};
  const layers = [L.planner, L.skills, L.tools, L.response, L.risk, L.performance].map(v => v ?? "-").join("/");
  console.log(`| ${i + 1} | ${r.createdAt.slice(11, 19)} | ${r.caseId} | ${stateOf(r)} | ${r.score} | ${layers} | ${r.latencyMs}ms |`);
});
const risky = results.filter(r => stateOf(r) === "FAIL" && (r.layerScores?.risk === 0 || (r.issues || []).some(x => /禁用表述|风控/.test(x))));
if (risky.length) console.log(`\n高风险 FAIL(${risky.length}): ${risky.map(r => r.caseId).join(", ")}`);
const issues = results.filter(r => r.issues?.length);
if (issues.length) {
  console.log("\n问题明细:");
  issues.forEach(r => console.log(`  ${r.caseId}: ${r.issues.join(";").slice(0, 200)}`));
}
