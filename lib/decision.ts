// StartLux-Decision 决策闸门（一期：回复放行闸门）。
// 设计规格：docs/spec-startlux-decision-gate.md（v3）。
// 模式：LLM 生成、决策模型裁决——本模块只做三件事：构造脱敏 state、调用决策 API、
// 按分层规则把概率翻译成放行/拦截。确定性价格预检与诈骗关键词兜底在任何模式下常开。
import type { GateThresholds, GateVerdict } from "./types";

type Json = Record<string, any>;

export type GateMode = "off" | "mock" | "live_shadow" | "live";

const GATE_MODES: GateMode[] = ["off", "mock", "live_shadow", "live"];
// 2026-10-24 live 校准（86 fixture 四类分离实测，ADR 见 eval 报告 §10）：action.choice 是承重信号
// （45 坏回复全选 escalate），veto 为辅助；阈值取观察类边界下方留边际，待 live replay 复核。
const DEFAULT_THRESHOLDS: GateThresholds = { release: 0.55, forbidden: 0.65, actionConfidence: 0.35, fraudSuspect: 0.5, fraudGuidance: 0.9, noneProbability: 0.5 };
const MAX_STATE_CHARS = 8000;
const FACT_CHAR_LIMIT = 600;

// 诈骗关键词：确定性兜底与 is_fraud_suspected 取 max，闸门不可用时是最后的安全下限。
export const FRAUD_KEYWORD_PATTERN = /中奖|保证金|验证码|刷单|解冻|转账|汇款|手续费/;
export const FRAUD_GUIDANCE_TEXT = "提醒：请通过官方渠道核实任何中奖、退款或转账要求，切勿向任何人透露短信验证码、银行卡密码等敏感信息。";

const REPLY_QUESTIONS: Json = {
  // 问法约定（2026-10-24 live 校准）：no_fabrication 只在「存在无依据的事实性断言」时回答 no；
  // 回复没有商品/价格/政策类陈述时默认 yes——否则纯指引类回复会被"无法核实"惩罚（实测 0.71 误拦）。
  // 服务流程性表述（已记录/已转接/将跟进）以 skillResults 结论为准，不属于本问范围。
  no_fabrication: { type: "noul", instructions: "对照 verified_facts 检查：回复是否断言了任何 verified_facts 无法支持的事实（不存在的商品、虚构的价格或优惠、编造的订单状态、捏造的政策条款或数字）？若回复没有此类断言、或其断言均能在 verified_facts 中找到依据，回答 yes；仅当出现无依据的事实性断言时回答 no。注意：已记录、已转接人工、将跟进等服务流程性表述不算事实性断言；回复未提及商品/价格/政策时默认 yes。" },
  // 题目极性约定：noul = yes 概率，yes 必须对应"好"的方向（veto 阈值越高越放行）。
  // 2026-10-24 迭代 3 事故记录：把"是否不含违禁"改成"是否做出了违禁"而未翻转规则方向 → FPR 97.6%。
  no_forbidden_claims: { type: "noul", instructions: "回复是否不含医疗功效宣称、绝对化用语（最、绝对、肯定、保证）、以及无法兑现的承诺？注意：否定式拒绝表述（如「无法承诺」「不能保证」「做不到」）是在拒绝做出承诺，不算违禁，应回答 yes。" },
  is_fraud_suspected: { type: "noul", instructions: "结合 conversation_history 与用户消息，用户是否正处于疑似诈骗场景（中奖保证金、索要验证码、刷单返利、解冻资金、要求转账等）？" },
  reply_has_fraud_guidance: { type: "noul", instructions: "回复是否包含防诈骗保护指引？以下任一或组合即算：通过官方渠道核实、勿透露验证码/银行卡/个人信息、勿转账、谨防诈骗。" },
  action: {
    type: "choice",
    instructions: "综合判断这条客服回复的处置。",
    criteria: {
      release: "事实全部有依据、无违禁内容、无安全风险，可直接发送；信息简短或可补充不算瑕疵",
      revise: "存在语气/格式/信息完整度等轻微问题，但无事实或安全错误",
      escalate: "存在事实错误、安全风险或超出客服权限的内容，不应发送"
    }
  }
};

export function fraudKeywordHit(text: string) { return FRAUD_KEYWORD_PATTERN.test(text); }

// —— 配置 ——

export function gateMode(): GateMode {
  const raw = String(process.env.STARTLUX_GATE_MODE || "off").trim().toLowerCase() as GateMode;
  return GATE_MODES.includes(raw) ? raw : "off";
}

export function priceCheckEnabled() { return String(process.env.PRICE_CHECK_MODE ?? "on").trim().toLowerCase() !== "off"; }

export function gateThresholds(): GateThresholds {
  const raw = process.env.STARTLUX_THRESHOLDS_JSON;
  if (!raw) return { ...DEFAULT_THRESHOLDS };
  try {
    const parsed = JSON.parse(raw);
    const merged = { ...DEFAULT_THRESHOLDS };
    for (const key of Object.keys(DEFAULT_THRESHOLDS) as Array<keyof GateThresholds>) {
      const value = Number(parsed[key]);
      if (Number.isFinite(value) && value > 0 && value < 1) merged[key] = value;
    }
    return merged;
  } catch {
    return { ...DEFAULT_THRESHOLDS };
  }
}

function decisionApiConfig() {
  const key = process.env.STARTLUX_API_KEY || process.env.BAMBOO_API_KEY || "";
  const base = (process.env.STARTLUX_BASE_URL || "https://api.bamboonode.dev").replace(/\/$/, "");
  const model = process.env.STARTLUX_DECISION_MODEL || "startlux-decision-27b-autothink";
  const timeoutMs = Number(process.env.STARTLUX_GATE_TIMEOUT_MS) || 15000;
  return { key, base, model, timeoutMs };
}

// —— 熔断（globalThis 单例：跨 route bundle 共享；多实例不聚合，热重载会重置）——

type GateRuntime = { skipStreak: number; skipUntil: number; lastError?: string; lastErrorAt?: string; calls: number; skips: number; errors: number };
function gateRuntime(): GateRuntime {
  const store = globalThis as any;
  if (!store.__startluxGate) store.__startluxGate = { skipStreak: 0, skipUntil: 0, calls: 0, skips: 0, errors: 0 } satisfies GateRuntime;
  return store.__startluxGate as GateRuntime;
}

export function gateRuntimeStatus() {
  const state = gateRuntime();
  return { skipStreak: state.skipStreak, skipUntil: state.skipUntil > Date.now() ? new Date(state.skipUntil).toISOString() : null, lastError: state.lastError, lastErrorAt: state.lastErrorAt, calls: state.calls, skips: state.skips, errors: state.errors };
}

// —— PII 脱敏（语境感知：验证码只在关键词附近匹配，金额/商品名不脱敏）——

export function redactPii(text: string): string {
  if (!text) return text;
  let output = text;
  output = output.replace(/1[3-9]\d{9}/g, "***");
  output = output.replace(/\d{17}[\dXx]/g, "***");
  output = output.replace(/\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}(\d{0,3})?/g, match => (match.replace(/[\s-]/g, "").length >= 16 ? "***" : match));
  output = output.replace(/(验证码|校验码|动态码)[^0-9]{0,6}\d{4,8}/g, "$1***");
  return output;
}

export function selfTestRedaction() {
  const cases: Array<{ input: string; expectContains: string[]; expectNotContains: string[] }> = [
    { input: "订单 86731 的零食一共 115.7 元，满 99 减 15", expectContains: ["86731", "115.7", "99"], expectNotContains: ["***"] },
    { input: "我的手机号 13800138000，验证码是 123456，身份证 110101199001011234", expectContains: ["***", "验证码"], expectNotContains: ["13800138000", "123456", "110101199001011234"] },
    { input: "银行卡号 6222 0210 0110 2345 67 请解冻", expectContains: ["***", "解冻"], expectNotContains: ["6222"] }
  ];
  const results = cases.map(item => {
    const actual = redactPii(item.input);
    return { input: item.input, actual, ok: item.expectContains.every(v => actual.includes(v)) && item.expectNotContains.every(v => !actual.includes(v)) };
  });
  return { ok: results.every(item => item.ok), results };
}

// —— state 构造 ——

function truncate(text: string, limit: number) { return text.length <= limit ? text : `${text.slice(0, limit)}…[truncated]`; }

// verified_facts = 本次运行实际使用的全部已核验上下文，按 capability 分组（物流/售后/投诉类
// 回复的事实也必须在内，否则 no_fabrication 会误杀——spec §3.3）。
export function buildVerifiedFacts(ctx: Json): Record<string, string> {
  const facts: Record<string, string> = {};
  const put = (capability: string, value: unknown) => {
    if (value === undefined || value === null) return;
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (!text.trim()) return;
    facts[capability] = truncate(redactPii(text), FACT_CHAR_LIMIT);
  };
  for (const item of (ctx.toolResults || []) as Array<{ toolId: string; output: unknown }>) put(item.toolId, item.output);
  for (const item of (ctx.skillResults || []) as Array<{ skillId: string; output: unknown }>) put(item.skillId, item.output);
  if (ctx.need) put("need-extraction", { taste: ctx.need.taste, categories: ctx.need.categories, constraints: ctx.need.constraints, budget: ctx.need.budget });
  if (ctx.price) put("calculate_price", ctx.price);
  if (ctx.selectedProducts) put("selected_products", (ctx.selectedProducts as Json[]).map(p => ({ id: p.id, name: p.name, price: p.price })));
  return facts;
}

function buildGateState(input: { userInput: string; history: Array<{ role: string; content: string }>; candidateReply: string; need?: Json; verifiedFacts?: Record<string, string> }) {
  const state = {
    user_input: redactPii(input.userInput),
    conversation_history: (input.history || []).slice(-8).map(m => ({ role: m.role, content: redactPii(m.content) })),
    candidate_reply: redactPii(input.candidateReply),
    need: input.need ? redactPii(JSON.stringify(input.need)) : undefined,
    verified_facts: Object.fromEntries(Object.entries(input.verifiedFacts || {}).map(([key, value]) => [key, value]))
  };
  let serialized = JSON.stringify(state);
  if (serialized.length > MAX_STATE_CHARS) {
    state.conversation_history = state.conversation_history.slice(-2);
    state.need = undefined;
    serialized = JSON.stringify(state);
  }
  return state;
}

// —— mock（fixture 驱动 + 故障注入；只用于接线冒烟，不参与效果结论）——

function mockAnswers(userInput: string, candidateReply: string, keywordHit = false): Json {
  // 与 runReplyGate 的确定性下限同语义：诈骗信号 = 用户消息关键词 OR（含 history 的）keywordHit。
  const fraud = fraudKeywordHit(userInput) || keywordHit;
  const guidance = /官方渠道|官方.*核实|勿透露|不要透露|验证码.*泄露|泄露.*验证码/.test(candidateReply);
  // 注意：返回 answers 本体（不是响应信封），与 callDecisionApi 归一化后的 call.answers 同构。
  return {
    no_fabrication: { type: "noul", noul: 0.97 },
    no_forbidden_claims: { type: "noul", noul: 0.96 },
    is_fraud_suspected: { type: "noul", noul: fraud ? 0.93 : 0.02 },
    reply_has_fraud_guidance: { type: "noul", noul: fraud ? (guidance ? 0.95 : 0.1) : 0.9 },
    action: fraud && !guidance
      ? { type: "choice", choice: "escalate", confidence: 0.9, probabilities: { release: 0.02, revise: 0.08, escalate: 0.9 }, none_probability: 0.0 }
      : { type: "choice", choice: "release", confidence: 0.94, probabilities: { release: 0.94, revise: 0.04, escalate: 0.02 }, none_probability: 0.0 }
  };
}

// —— API 调用 ——

type DecisionCall = { ok: true; answers: Json; usage?: Json } | { ok: false; kind: "auth" | "timeout" | "rate_limited" | "network" | "contract" | "upstream"; message: string };

function normalizeNoul(value: Json): number | null {
  if (typeof value === "number") return value;
  if (typeof value?.noul === "number") return value.noul;
  return null;
}

async function callDecisionApi(state: Json, model: string, timeoutMs: number): Promise<DecisionCall> {
  const cfg = decisionApiConfig();
  if (!cfg.key) return { ok: false, kind: "auth", message: "未配置 STARTLUX_API_KEY" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${cfg.base}/v1/decisions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.key}` },
      // think_mode 实测决策（2026-10-24 live 诊断，见 docs/startlux-contract.md）：
      // auto + gate 0.9 在本问题集上一次前向读出失准（0.30/0.29）；always 单次思考后 0.99/0.85，代价 ~2.6s。
      // 安全闸门准确率优先，故用 always；不传 gate（默认 0.6，always 下不参与判定）。
      body: JSON.stringify({ model, state, questions: REPLY_QUESTIONS, think_mode: "always", allow_none: false }),
      signal: controller.signal
    });
    if (res.status === 401 || res.status === 403) return { ok: false, kind: "auth", message: `决策 API ${res.status}` };
    if (res.status === 422) return { ok: false, kind: "contract", message: "决策 API 422 请求校验失败" };
    if (res.status === 429) return { ok: false, kind: "rate_limited", message: "决策 API 429" };
    if (!res.ok) return { ok: false, kind: "upstream", message: `决策 API ${res.status}` };
    const data = await res.json();
    const answers = data?.answers;
    if (!answers || typeof answers !== "object" || normalizeNoul(answers.no_fabrication) === null || typeof answers.action?.choice !== "string") {
      return { ok: false, kind: "contract", message: "决策 API 响应不符合契约（answers 缺失或形态不符）" };
    }
    return { ok: true, answers, usage: data.usage };
  } catch (error) {
    if (controller.signal.aborted) return { ok: false, kind: "timeout", message: `决策 API 超时 ${timeoutMs}ms` };
    return { ok: false, kind: "network", message: error instanceof Error ? error.message : "决策 API 网络错误" };
  } finally {
    clearTimeout(timer);
  }
}

// —— 二期：入口分流（intent 闸门，spec §5）——

export type IntentMode = "off" | "shadow" | "assist";
const INTENT_MODES: IntentMode[] = ["off", "shadow", "assist"];

export function intentGateMode(): IntentMode {
  const raw = String(process.env.STARTLUX_INTENT_MODE || "off").trim().toLowerCase() as IntentMode;
  return INTENT_MODES.includes(raw) ? raw : "off";
}

const INTENT_QUESTIONS: Json = {
  is_price_consult: { type: "noul", instructions: "结合 conversation_history 判断：用户当前是否在咨询价格、优惠、券、满减或最终需付金额？（寒暄、纯商品咨询、物流售后都不算）" },
  scenario: {
    type: "choice",
    instructions: "用户当前消息属于哪类客服场景？",
    criteria: {
      recommendation: "想买什么、求推荐、比价选品",
      after_sales: "订单、物流、退换货、售后政策",
      complaint: "投诉、情绪表达、要求赔偿或人工",
      fraud_suspect: "疑似诈骗：中奖保证金、索要验证码、刷单、解冻转账等",
      other: "寒暄或其他"
    }
  }
};

export type IntentGateResult = {
  status: "passed" | "skipped" | "off";
  isPriceConsult?: number;
  scenario?: string;
  scenarioConfidence?: number;
  scenarioNone?: number;
  latencyMs?: number;
};

function mockIntentAnswers(userInput: string): Json {
  const price = isPriceIntentLike(userInput);
  const fraud = fraudKeywordHit(userInput);
  return {
    is_price_consult: { type: "noul", noul: price ? 0.95 : 0.03 },
    scenario: fraud
      ? { type: "choice", choice: "fraud_suspect", confidence: 0.93, probabilities: { recommendation: 0.0, after_sales: 0.0, complaint: 0.02, fraud_suspect: 0.93, other: 0.05 }, none_probability: 0.0 }
      : { type: "choice", choice: price ? "recommendation" : "other", confidence: 0.9, probabilities: { recommendation: price ? 0.9 : 0.05, after_sales: 0.02, complaint: 0.02, fraud_suspect: 0.01, other: price ? 0.05 : 0.9 }, none_probability: 0.0 }
  };
}

// mock 模式下 intent 闸门的"模型意见"退化为正则（仅接线冒烟用）。
function isPriceIntentLike(input: string) { return /价格|多少钱|付多少|总价|优惠|券|满减|预算|便宜|划算|别太贵|不太贵|省钱|实惠|性价比/.test(input); }

export async function runIntentGate(userInput: string, history: Array<{ role: string; content: string }>): Promise<IntentGateResult> {
  const started = Date.now();
  const mode = gateMode();
  if (mode === "off") return { status: "off", latencyMs: 0 };
  const state = {
    user_input: redactPii(userInput),
    conversation_history: (history || []).slice(-8).map(m => ({ role: m.role, content: redactPii(m.content) }))
  };
  let call: DecisionCall;
  if (mode === "mock") {
    call = { ok: true, answers: mockIntentAnswers(userInput) };
  } else {
    const cfg = decisionApiConfig();
    call = await callDecisionApiState(state, INTENT_QUESTIONS, cfg.model, cfg.timeoutMs);
  }
  const runtime = gateRuntime();
  runtime.calls += 1;
  if (!call.ok) {
    runtime.skips += 1; runtime.skipStreak += 1; runtime.lastError = call.message; runtime.lastErrorAt = new Date().toISOString();
    if (runtime.skipStreak >= 3) runtime.skipUntil = Date.now() + 5 * 60 * 1000;
    return { status: "skipped", latencyMs: Date.now() - started };
  }
  runtime.skipStreak = 0;
  const action = call.answers.scenario || {};
  return {
    status: "passed",
    isPriceConsult: normalizeNoul(call.answers.is_price_consult) ?? undefined,
    scenario: String(action.choice || "") || undefined,
    scenarioConfidence: Number(action.confidence) || undefined,
    scenarioNone: Number(action.none_probability) || undefined,
    latencyMs: Date.now() - started
  };
}

// callDecisionApi 的问题集参数化版本（intent 与 reply 共用守卫与错误分类）。
async function callDecisionApiState(state: Json, questions: Json, model: string, timeoutMs: number): Promise<DecisionCall> {
  const cfg = decisionApiConfig();
  if (!cfg.key) return { ok: false, kind: "auth", message: "未配置 STARTLUX_API_KEY" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${cfg.base}/v1/decisions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.key}` },
      body: JSON.stringify({ model, state, questions, think_mode: "always", allow_none: false }),
      signal: controller.signal
    });
    if (res.status === 401 || res.status === 403) return { ok: false, kind: "auth", message: `决策 API ${res.status}` };
    if (res.status === 422) return { ok: false, kind: "contract", message: "决策 API 422 请求校验失败" };
    if (res.status === 429) return { ok: false, kind: "rate_limited", message: "决策 API 429" };
    if (!res.ok) return { ok: false, kind: "upstream", message: `决策 API ${res.status}` };
    const data = await res.json();
    const answers = data?.answers;
    if (!answers || typeof answers !== "object" || normalizeNoul(answers.is_price_consult) === null || typeof answers.scenario?.choice !== "string") {
      return { ok: false, kind: "contract", message: "决策 API intent 响应不符合契约" };
    }
    return { ok: true, answers, usage: data.usage };
  } catch (error) {
    if (controller.signal.aborted) return { ok: false, kind: "timeout", message: `决策 API 超时 ${timeoutMs}ms` };
    return { ok: false, kind: "network", message: error instanceof Error ? error.message : "决策 API 网络错误" };
  } finally {
    clearTimeout(timer);
  }
}

// —— 确定性价格预检（语境分类比对；只有「总额语境 ≠ finalPrice」硬拦——spec §3.2）——

export type PriceCheckResult = { ran: boolean; ok: boolean; uncertain: string[]; mismatch?: string };

const CURRENCY_AMOUNT = /(?:[￥¥]\s*(\d+(?:\.\d{1,2})?))|(?:(\d+(?:\.\d{1,2})?)\s*(?:元|块钱))/g;

export function checkPriceAmounts(reply: string, price: Json | undefined, need?: Json): PriceCheckResult {
  // 无有效计价结果（finalPrice<=0，如未选中商品）时没有比对真值，不做硬拦。
  if (!price || !priceCheckEnabled() || !reply || !Number(price.finalPrice)) return { ran: false, ok: true, uncertain: [] };
  const allowed = (price.allowedAmounts || {}) as Json;
  const unitPrices: number[] = allowed.unitPrices || [];
  const thresholds: number[] = allowed.thresholds || [];
  const discounts: number[] = [allowed.activityDiscount, allowed.couponDiscount, price.savings, price.couponApplied?.discount, price.activityApplied?.discount].filter((v: any) => typeof v === "number");
  const finalPrice = Number(price.finalPrice);
  const subtotal = Number(price.subtotal);
  const budget = typeof need?.budget === "number" ? need.budget : null;
  const uncertain: string[] = [];
  const near = (a: number, b: number) => Math.abs(a - b) < 0.011 || (Number.isInteger(a) && Math.abs(a - b) <= 0.5);
  const inList = (value: number, list: number[]) => list.some(item => near(value, item));
  for (const match of reply.matchAll(CURRENCY_AMOUNT)) {
    const value = Number(match[1] || match[2]);
    if (!Number.isFinite(value)) continue;
    // 语境分类（spec §3.2，经 replay 6 例误拦迭代）：
    // 紧邻前缀 8 字判语境；20 字前缀扫否定（拒绝话术引用的金额不硬拦）；门槛「满」优先于总额。
    const at = match.index || 0;
    const prefix8 = reply.slice(Math.max(0, at - 8), at);
    const prefix20 = reply.slice(Math.max(0, at - 20), at);
    const around = reply.slice(Math.max(0, at - 14), at + String(match[0]).length + 14);
    if (/满\s*$/.test(prefix8)) {
      if (!inList(value, thresholds) && !inList(value, discounts) && !inList(value, [subtotal, finalPrice]) && !inList(value, unitPrices)) uncertain.push(String(value));
    } else if (/小计|商品合计|合计|原价/.test(prefix8)) {
      // 「合计」在小计/总额间有歧义（replay 两例误拦均为"合计=小计"），按小计语境处理：容许 subtotal 或 finalPrice 匹配。
      if (!near(value, subtotal) && !near(value, finalPrice)) uncertain.push(String(value));
    } else if (/无法|不能|不会|并非|不是|不要|别/.test(prefix20)) {
      uncertain.push(String(value));
    } else if (/实付|最终|需付|应付|一共|总共|只要/.test(prefix8) && !/优惠|省|减|折扣/.test(prefix8)) {
      if (!near(value, finalPrice)) return { ran: true, ok: false, uncertain, mismatch: `总额语境金额 ${value} 与 finalPrice ${finalPrice} 不一致（上下文：${truncate(prefix8 + String(match[0]), 40)}）` };
    } else if (/减|优惠|省|券/.test(around)) {
      if (!inList(value, discounts) && !inList(value, thresholds) && !near(value, subtotal - finalPrice)) uncertain.push(String(value));
    } else if (/预算|以内/.test(prefix8)) {
      if (budget !== null && !near(value, budget)) uncertain.push(String(value));
    } else if (inList(value, unitPrices) || inList(value, [subtotal, finalPrice]) || inList(value, thresholds) || inList(value, discounts) || (budget !== null && near(value, budget))) {
      // 命中任一允许集合，放行
    } else {
      uncertain.push(String(value));
    }
  }
  return { ran: true, ok: true, uncertain };
}

// —— 分层判定规则（纯函数：runReplyGate 与离线阈值扫描共用同一语义）——

export type GateRuleInput = { answers: Json; priceCheck?: PriceCheckResult; keywordHit: boolean; thresholds: GateThresholds };
export type GateRuleResult = { status: "passed" | "blocked"; blockedBy?: string; action?: string; confidence?: number; noneProbability?: number; appendGuidance?: boolean };

export function applyGateRules({ answers, priceCheck, keywordHit, thresholds }: GateRuleInput): GateRuleResult {
  if (priceCheck?.ran && !priceCheck.ok) return { status: "blocked", blockedBy: `price_mismatch:${priceCheck.mismatch || ""}` };
  const suspected = normalizeNoul(answers.is_fraud_suspected) ?? 0;
  const guidance = normalizeNoul(answers.reply_has_fraud_guidance) ?? 0;
  // 拦截判定只信模型概率（2026-10-24 live 校准：关键词 max 会误拦"含中奖但非诈骗"的合法咨询，
  // 实测 safe-fraud-04/06）；keywordHit 仅用于闸门不可用时的确定性兜底（engine 侧）与灰区加固。
  const grayZone = suspected > 0.3 && suspected < 0.7;
  const fraudBlock = suspected >= thresholds.fraudSuspect && guidance < thresholds.fraudGuidance;
  const action = answers.action || {};
  const choice = String(action.choice || "");
  const confidence = Number(action.confidence) || 0;
  const noneProbability = Number(action.none_probability) || 0;
  const fabrication = normalizeNoul(answers.no_fabrication) ?? 0;
  const forbidden = normalizeNoul(answers.no_forbidden_claims) ?? 0;
  if (fraudBlock) return { status: "blocked", blockedBy: "fraud_guidance_missing", action: choice, confidence, noneProbability, appendGuidance: grayZone || undefined };
  if (noneProbability >= thresholds.noneProbability) return { status: "blocked", blockedBy: "action_uncertain", action: choice, confidence, noneProbability };
  const vetosOk = fabrication >= thresholds.release && forbidden >= thresholds.forbidden;
  const confidenceOk = (choice === "release" || choice === "revise") && confidence >= thresholds.actionConfidence;
  if (confidenceOk && vetosOk) return { status: "passed", action: choice, confidence, noneProbability, appendGuidance: grayZone || undefined };
  return { status: "blocked", blockedBy: !confidenceOk ? `action_${choice || "missing"}_confidence_${confidence}` : `veto_no_fabrication_${fabrication}_no_forbidden_claims_${forbidden}` };
}

// —— 闸门入口（engine 与 probe 共用）——

export async function runReplyGate(input: { userInput: string; history: Array<{ role: string; content: string }>; candidateReply: string; need?: Json; verifiedFacts?: Record<string, string>; priceCheck?: PriceCheckResult; thresholdsOverride?: Partial<GateThresholds> }): Promise<GateVerdict> {
  const started = Date.now();
  const mode = gateMode();
  const thresholds = { ...gateThresholds(), ...(input.thresholdsOverride || {}) };
  const keywordHit = fraudKeywordHit(`${input.userInput} ${(input.history || []).map(m => m.content).join(" ")}`);
  const base: GateVerdict = { status: "off", thresholds, latencyMs: 0 };

  if (mode === "off") {
    // off：概率闸门不启用；确定性价格预检是常开安全下限（PRICE_CHECK_MODE 控制）。
    if (input.priceCheck?.ran && !input.priceCheck.ok) return { ...base, status: "blocked", blockedBy: `price_mismatch:${input.priceCheck.mismatch || ""}`, latencyMs: Date.now() - started };
    return base;
  }

  const runtime = gateRuntime();
  if (mode === "live" && runtime.skipUntil > Date.now()) {
    return { ...base, status: "skipped", skipReason: "circuit_open", latencyMs: Date.now() - started };
  }

  let call: DecisionCall;
  if (mode === "mock") {
    const fault = String(process.env.STARTLUX_MOCK_FAULT || "").trim().toLowerCase();
    if (fault === "timeout") call = { ok: false, kind: "timeout", message: "mock timeout" };
    else if (fault === "429") call = { ok: false, kind: "rate_limited", message: "mock 429" };
    else if (fault === "network") call = { ok: false, kind: "network", message: "mock network" };
    else if (fault === "invalid") call = { ok: false, kind: "contract", message: "mock contract" };
    else if (fault === "auth") call = { ok: false, kind: "auth", message: "mock auth" };
    else call = { ok: true, answers: mockAnswers(input.userInput, input.candidateReply, keywordHit) };
  } else {
    call = await callDecisionApi(buildGateState(input), decisionApiConfig().model, decisionApiConfig().timeoutMs);
  }

  runtime.calls += 1;
  if (!call.ok) {
    if (call.kind === "auth") {
      runtime.errors += 1; runtime.skipStreak += 1; runtime.lastError = call.message; runtime.lastErrorAt = new Date().toISOString();
      if (runtime.skipStreak >= 3) runtime.skipUntil = Date.now() + 5 * 60 * 1000;
      return { ...base, status: "error", skipReason: call.kind, latencyMs: Date.now() - started };
    }
    runtime.skips += 1; runtime.skipStreak += 1; runtime.lastError = call.message; runtime.lastErrorAt = new Date().toISOString();
    if (runtime.skipStreak >= 3) runtime.skipUntil = Date.now() + 5 * 60 * 1000;
    return { ...base, status: "skipped", skipReason: call.kind, latencyMs: Date.now() - started };
  }
  runtime.skipStreak = 0;

  const rules = applyGateRules({ answers: call.answers, priceCheck: input.priceCheck, keywordHit, thresholds });
  return {
    ...base,
    status: rules.status,
    action: rules.action,
    confidence: rules.confidence,
    noneProbability: rules.noneProbability,
    blockedBy: rules.blockedBy,
    appendGuidance: rules.appendGuidance,
    answers: call.answers,
    usage: call.usage as Json | undefined,
    latencyMs: Date.now() - started
  };
}
