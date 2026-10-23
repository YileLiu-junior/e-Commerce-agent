// 顺序运行评测用例:node scripts/run-eval.mjs <caseId...>
// 默认地址 http://localhost:3199,可用 EVAL_BASE 覆盖。
const BASE = process.env.EVAL_BASE || "http://localhost:3199";
const caseIds = process.argv.slice(2);
if (!caseIds.length) { console.error("用法: node scripts/run-eval.mjs <caseId...>"); process.exit(1); }

for (const caseId of caseIds) {
  const started = Date.now();
  try {
    const res = await fetch(`${BASE}/api/evaluations`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ caseId })
    });
    const data = await res.json();
    if (!res.ok) { console.log(`${caseId}  HTTP ${res.status}  ${data.error || ""}`); continue; }
    const r = data.result;
    console.log([
      caseId.padEnd(28),
      r.passed ? "passed" : "FAILED",
      `score=${r.score}`,
      `latency=${r.latencyMs}ms`,
      `wall=${Date.now() - started}ms`,
      r.executionError ? `ERROR: ${r.executionError}` : (r.issues[0] ? `issue: ${r.issues[0]}` : "")
    ].join("  "));
  } catch (error) {
    console.log(`${caseId}  请求异常: ${error.message}`);
  }
}
