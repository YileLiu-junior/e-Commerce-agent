// 契约冒烟：有 key 时向决策 API 发最小真实请求，验证 answers 形态并落 fixture。
// 无 key 时打印 BLOCKED 并以非 0 退出（CI/流程闸门）。
// 用法: node scripts/contract-check.mjs
import { writeFile } from "fs/promises";

const key = process.env.STARTLUX_API_KEY || process.env.BAMBOO_API_KEY;
const base = (process.env.STARTLUX_BASE_URL || "https://api.bamboonode.dev").replace(/\/$/, "");
const model = process.env.STARTLUX_DECISION_MODEL || "startlux-decision-27b-autothink";

if (!key) {
  console.log("BLOCKED: 未配置 STARTLUX_API_KEY（.env.local）。请到 bamboonode.dev/register 注册后填入，再重跑本脚本。");
  process.exit(1);
}

const body = {
  model,
  state: { ticket: "I was charged twice for order #4411 and the app still shows it as unpaid." },
  questions: {
    team: { type: "choice", instructions: "Which team should handle this ticket?", criteria: { billing: "Payments and refunds", shipping: "Delivery", technical: "App and login" } },
    urgent: { type: "noul", instructions: "Should this ticket be answered today?" },
    severity: { type: "score", instructions: "How severe is the impact?", criteria: ["cosmetic", "annoying", "blocks the customer"] }
  },
  think_mode: "auto",
  gate: 0.9
};

const started = Date.now();
const res = await fetch(`${base}/v1/decisions`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
const text = await res.text();
if (!res.ok) {
  console.log(`FAIL: 决策 API ${res.status}: ${text.slice(0, 300)}`);
  process.exit(1);
}
const data = JSON.parse(text);
const latency = Date.now() - started;
const fixture = { capturedAt: new Date().toISOString(), model, latencyMs: latency, request: { questions: body.questions, think_mode: body.think_mode, gate: body.gate }, response: data, notes: "已脱敏（无 PII），用于 lib/decision.ts 类型守卫比对" };
await writeFile("docs/startlux-contract-fixture.json", JSON.stringify(fixture, null, 2));
console.log(`OK: HTTP 200，${latency}ms`);
console.log(`answers 形态: ${JSON.stringify(Object.fromEntries(Object.entries(data.answers || {}).map(([k, v]) => [k, v.type || typeof v])))}`);
console.log(`usage: ${JSON.stringify(data.usage)}`);
console.log("已写入 docs/startlux-contract-fixture.json — 请人工核对 noul 形态与字段名后更新 docs/startlux-contract.md");
