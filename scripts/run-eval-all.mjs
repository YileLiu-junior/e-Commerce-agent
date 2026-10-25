// 全量评测：枚举 /api/evaluations 的全部 caseId（79 种子 + 自定义）并逐条 POST。
// 用法: node scripts/run-eval-all.mjs [--tag off] [--only seed-安全] [--skip N]
// 组开始前自动把当前 data/eval-results.json 归档到 data/archive/（cap 300 保护，spec §4.2）。
import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";

const base = process.env.EVAL_BASE || "http://localhost:3199";
const args = process.argv.slice(2);
const tagIdx = args.indexOf("--tag");
const tag = tagIdx >= 0 ? args[tagIdx + 1] : "run";
const onlyIdx = args.indexOf("--only");
const only = onlyIdx >= 0 ? args[onlyIdx + 1] : null;

const archiveDir = "data/archive";
if (!existsSync(archiveDir)) await mkdir(archiveDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const resultsPath = "data/eval-results.json";
if (existsSync(resultsPath)) {
  const snapshot = await readFile(resultsPath, "utf8");
  const archivePath = `${archiveDir}/eval-results-${stamp}-${tag}.json`;
  await writeFile(archivePath, snapshot);
  console.log(`已归档当前结果 → ${archivePath}`);
}

const list = await fetch(`${base}/api/evaluations`).then(r => r.json());
const cases = (list.cases || []).filter(c => c.enabled !== false).filter(c => !only || c.id.includes(only));
console.log(`共 ${cases.length} 条用例（tag=${tag}），开始顺序执行…`);

let done = 0;
const startedAt = new Date().toISOString();
for (const item of cases) {
  try {
    const res = await fetch(`${base}/api/evaluations`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ caseId: item.id }) });
    const data = await res.json();
    const result = data.result || data;
    const gate = result.gateStatus ? ` [gate:${result.gateStatus}${result.gateAction ? "/" + result.gateAction : ""}]` : "";
    console.log(`${result.passed === true ? "PASS" : "FAIL"} ${result.score ?? "-"} ${item.id}${gate}${result.issues?.length ? ` :: ${result.issues[0]}` : ""}`);
  } catch (error) {
    console.log(`ERROR ${item.id} :: ${error.message}`);
  }
  done += 1;
  if (done % 20 === 0) console.log(`--- ${done}/${cases.length} ---`);
}
console.log(`\n完成 ${done} 条，开始时间 ${startedAt}。汇总: node scripts/eval-summary.mjs "${startedAt}"${tag === "off" ? "" : " --gate"}`);
