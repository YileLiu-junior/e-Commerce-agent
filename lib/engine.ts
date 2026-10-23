import type { AnnotationRecord, Conversation, EvaluationCase, JsonSchema, Plan, PlannerConfig, PromptExperiment, RunResult, Skill, ToolConfig, TraceItem } from "./types";
import { appendMetric, getConversation, getEvaluationSettings, getExperiments, getMcpServers, getPlanner, getSkills, getTools, readData, saveConversation } from "./store";
import { callMcpTool } from "./mcp";

type Json = Record<string, any>;
type Product = { id: string; name: string; category: string; tags: string[]; price: number; stock: number; rating: number; description: string };
type Activity = { id: string; name: string; type: string; threshold?: number; discount?: number; category?: string; rate?: number; enabled: boolean; description: string };
type Coupon = { id: string; name: string; threshold: number; discount: number; category?: string; enabled: boolean; stackable: boolean };

function apiConfig() {
  const key = process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY;
  const base = process.env.AI_BASE_URL || process.env.OPENAI_BASE_URL || (process.env.DEEPSEEK_API_KEY ? "https://api.deepseek.com/v1" : "https://api.openai.com/v1");
  return { key, base: base.replace(/\/$/, ""), model: process.env.AI_MODEL || process.env.OPENAI_MODEL || (process.env.DEEPSEEK_API_KEY ? "deepseek-chat" : "gpt-4o-mini") };
}

function parseJson(text: string): Json {
  const clean = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try { return JSON.parse(clean); } catch {
    const match = clean.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("模型未返回有效 JSON");
    return JSON.parse(match[0]);
  }
}

async function callModel(skill: Skill, input: unknown): Promise<Json> {
  const cfg = apiConfig();
  if (!cfg.key) throw new Error("未配置模型 API Key，请在 .env.local 中设置 OPENAI_API_KEY 或 DEEPSEEK_API_KEY。");
  const res = await fetch(`${cfg.base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.key}` },
    body: JSON.stringify({
      model: skill.model && skill.model !== "default" ? skill.model : cfg.model,
      temperature: skill.temperature,
      max_tokens: skill.maxTokens,
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: skill.prompt }, { role: "user", content: JSON.stringify(input) }]
    })
  });
  if (!res.ok) throw new Error(`模型 API ${res.status}: ${(await res.text()).slice(0, 180)}`);
  const data = await res.json();
  return parseJson(data.choices?.[0]?.message?.content || "");
}

function toStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(toStringList);
  if (typeof value !== "string") return [];
  return value.split(/[,，、;；|/]+/).map(item => item.trim()).filter(Boolean);
}

function normalizeNeed(value: unknown): Json {
  const need = value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
  const budget = typeof need.budget === "number" ? need.budget : Number.parseFloat(String(need.budget ?? ""));
  const quantity = typeof need.quantity === "number" ? need.quantity : Number.parseInt(String(need.quantity ?? ""), 10);
  return {
    ...need,
    taste: toStringList(need.taste),
    categories: toStringList(need.categories),
    constraints: toStringList(need.constraints),
    budget: Number.isFinite(budget) && budget > 0 ? budget : null,
    quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1,
    needs_price: need.needs_price === true || need.needs_price === "true"
  };
}

function validateSchema(value: unknown, schema: JsonSchema | undefined, label: string) {
  if (!schema) return;
  if (schema.type === "object" && (!value || typeof value !== "object" || Array.isArray(value))) throw new Error(`${label} 必须是 JSON object`);
  const object = value as Record<string, unknown>;
  for (const key of schema.required || []) if (object?.[key] === undefined) throw new Error(`${label} 缺少字段：${key}`);
  for (const [key, rule] of Object.entries(schema.properties || {})) {
    const item = object?.[key]; if (item === undefined || item === null || !rule.type) continue;
    const actual = Array.isArray(item) ? "array" : typeof item;
    if (actual !== rule.type) throw new Error(`${label}.${key} 类型应为 ${rule.type}，实际为 ${actual}`);
  }
}

function needsPrice(input: string) { return /价格|多少钱|付多少|总价|优惠|券|满减|预算|便宜|划算|别太贵|不太贵|省钱|实惠|性价比/.test(input); }
const coreSkillIds = new Set(["need-extraction", "recommendation-decision", "recommendation-reason", "response-generator", "risk-check"]);

function internalSkill(id: string, prompt: string): Skill {
  return { id, name: id, description: prompt, prompt, model: apiConfig().model, temperature: 0, maxTokens: 900, enabled: true };
}

async function prepareMcpArguments(tool: ToolConfig, userInput: string, ctx: Json) {
  const result = await callModel(internalSkill("mcp_argument_builder", "你是 MCP Tool 参数生成器。严格按照 inputSchema，从用户原话和已有执行上下文生成参数。不得虚构用户未提供的敏感信息。只输出符合 schema 的参数 JSON 对象。"), {
    tool: { name: tool.remoteName, description: tool.description, inputSchema: tool.inputSchema },
    userInput,
    context: { need: ctx.need, products: ctx.products, price: ctx.price, mcpResults: ctx.mcpResults }
  });
  return result;
}

function plannerAsSkill(planner: PlannerConfig): Skill {
  return { id: planner.id, name: planner.name, description: planner.description, prompt: planner.prompt, model: planner.model, temperature: planner.temperature, maxTokens: planner.maxTokens, enabled: planner.enabled };
}

async function buildPlan(userInput: string, skills: Skill[], tools: ToolConfig[], planner: PlannerConfig, history: Conversation["messages"] = []): Promise<Plan> {
  if (!planner.enabled) throw new Error("Planner 已停用，无法生成执行计划。");
  const enabled = new Set(skills.filter(s => s.enabled).map(s => s.id));
  const enabledTools = new Set(tools.filter(tool => tool.enabled).map(tool => tool.id));
  const priceIntent = needsPrice(userInput);
  const decisionTrace: Plan["decisionTrace"] = [
    { stage: "intent", title: "识别任务特征", detail: priceIntent ? "检测到价格、预算或优惠意图，需要启用确定性计价规则。" : "未检测到价格或优惠意图，使用基础商品查询规则。", data: { priceIntent } },
    { stage: "availability", title: "读取可用能力", detail: `当前有 ${enabled.size} 个启用 Skill、${enabledTools.size} 个启用 Tool。`, data: { enabledSkills: [...enabled], enabledTools: [...enabledTools] } }
  ];
  if (!enabled.has("risk-check")) throw new Error("risk-check 已停用：按平台规则，无法生成未经风控的最终回复。");
  const requiredSkills = [...new Set([...planner.requiredSkills.filter(id => id !== "risk-check"), "risk-check"])];
  const missingSkills = requiredSkills.filter(id => !enabled.has(id));
  if (missingSkills.length) throw new Error(`必经 Skill 不存在或已停用：${missingSkills.join("、")}`);
  const requiredTools = [...new Set([...planner.baseTools, ...(priceIntent ? planner.priceTools : [])])];
  const missingTools = requiredTools.filter(id => !enabledTools.has(id));
  if (missingTools.length) throw new Error(`必需 Tool 已停用：${missingTools.join("、")}。请在 Tool 管理中启用后重试。`);
  decisionTrace.push({ stage: "policy", title: "注入强制规则", detail: `锁定 ${requiredSkills.length} 个必经 Skill 和 ${requiredTools.length} 个规则 Tool；risk-check 固定为最后一步。`, data: { requiredSkills, requiredTools } });
  const proposed = await callModel(plannerAsSkill(planner), {
    userInput, conversation_history: history.slice(-8),
    available_skills: skills.filter(skill => skill.enabled).map(skill => ({ id: skill.id, name: skill.name, description: skill.description })),
    available_tools: tools.filter(tool => tool.enabled).map(tool => ({ id: tool.id, name: tool.name, description: tool.description, mode: tool.implementation })),
    mandatory_capabilities: { skills: requiredSkills, tools: requiredTools, risk_check_must_be_last: true }
  });
  const proposedSteps = Array.isArray(proposed.steps) ? proposed.steps : [];
  decisionTrace.push({ stage: "model", title: "模型生成候选计划", detail: `Planner 返回 ${proposedSteps.length} 个候选步骤。`, data: { proposedCapabilities: proposedSteps.map(step => String(step?.capability || "").replace(/^\$/, "")) } });
  const mandatory = new Set([...requiredSkills, ...requiredTools]);
  const dynamic: Array<[string, "skill" | "tool", string]> = [];
  const seen = new Set<string>();
  const rejected: string[] = [];
  for (const raw of proposedSteps) {
    const capability = String(raw?.capability || "").replace(/^\$/, "");
    const type = raw?.type === "skill" ? "skill" : raw?.type === "tool" ? "tool" : null;
    if (!type || mandatory.has(capability) || seen.has(capability)) { if (capability && !mandatory.has(capability)) rejected.push(capability); continue; }
    if ((type === "skill" && enabled.has(capability)) || (type === "tool" && enabledTools.has(capability))) {
      dynamic.push([capability, type, String(raw?.purpose || `调用 ${capability}`)]); seen.add(capability);
    } else rejected.push(capability);
  }
  decisionTrace.push({ stage: "validation", title: "能力白名单校验", detail: `接受 ${dynamic.length} 个动态能力，过滤 ${rejected.length} 个无效或重复建议。`, data: { accepted: dynamic.map(([id]) => id), rejected } });
  const nonRiskSkills = requiredSkills.filter(id => id !== "risk-check");
  const firstSkill = nonRiskSkills[0];
  const trailingSkills = nonRiskSkills.slice(1);
  const calculationTools = requiredTools.filter(id => id === "calculate_price");
  const lookupTools = requiredTools.filter(id => id !== "calculate_price");
  const trailingWithCalculation = trailingSkills.flatMap(id => [
    [id, "skill", `必经 Skill · $${id}`] as [string, "skill" | "tool", string],
    ...(id === "recommendation-decision" ? calculationTools.map(toolId => [toolId, "tool", `推荐完成后确定性计价 · ${toolId}`] as [string, "skill" | "tool", string]) : [])
  ]);
  const wanted: Array<[string, "skill" | "tool", string]> = [
    ...(firstSkill ? [[firstSkill, "skill", `必经 Skill · $${firstSkill}`] as [string, "skill", string]] : []),
    ...lookupTools.map(id => [id, "tool", `规则要求 · ${id}`] as [string, "tool", string]),
    ...dynamic,
    ...trailingWithCalculation,
    ["risk-check", "skill", "强制最终风控审核"]
  ];
  const steps = wanted.map(([capability, type, purpose], i) => ({ id: `step_${i + 1}`, capability, type, purpose }));
  decisionTrace.push({ stage: "assembly", title: "组装最终计划", detail: `形成 ${steps.length} 个可执行步骤，并将风控置于末尾。`, data: { finalCapabilities: steps.map(step => step.capability) } });
  return { goal: typeof proposed.goal === "string" ? proposed.goal : "生成准确、安全的零食客服回复", reasoning: typeof proposed.reasoning === "string" ? proposed.reasoning : "Planner 已按启用能力和强制规则生成计划。", decisionTrace, steps };
}

async function executeLocalTool(id: string, ctx: Json): Promise<Json> {
  if (id === "query_order_logistics") {
    const orders = await readData<Array<{ orderId: string; [key: string]: unknown }>>("orders.json");
    const orderId = String(ctx.userInput || "").match(/(?:订单(?:号)?[\s：:]*)?([A-Za-z]{0,3}\d{5,})/i)?.[1];
    if (!orderId) return { found: false, reason: "未在客户消息中识别到订单号", requiredField: "orderId" };
    const order = orders.find(item => item.orderId.toLowerCase() === orderId.toLowerCase());
    return order ? { found: true, order } : { found: false, orderId, reason: "未查询到该订单" };
  }
  if (id === "query_return_policy") return { policy: await readData<Json>("return-policies.json") };
  if (id === "query_products") {
    const products = await readData<Product[]>("products.json");
    // Tool 边界不信任模型的 JSON 形状：字符串、数组和空值先统一归一化。
    const n = normalizeNeed(ctx.need);
    const filtered = products.filter(p => p.stock > 0 && (!n.budget || p.price <= n.budget) && (!n.categories.length || n.categories.some((c: string) => p.category.includes(c) || p.name.includes(c))) && (!n.taste.length || n.taste.some((t: string) => p.tags.some(tag => tag.includes(t)) || p.name.includes(t))));
    return { products: (filtered.length ? filtered : products).sort((a, b) => b.rating - a.rating).slice(0, 5), filterFallback: filtered.length === 0 };
  }
  if (id === "query_activities") return { activities: (await readData<Activity[]>("activities.json")).filter(a => a.enabled) };
  if (id === "query_coupons") {
    const coupons = (await readData<Coupon[]>("coupons.json")).filter(c => c.enabled);
    return { coupons };
  }
  if (id === "calculate_price") {
    const products: Product[] = ctx.selectedProducts || ctx.products || [];
    const subtotal = Number(products.reduce((s, p) => s + p.price, 0).toFixed(2));
    let afterActivity = subtotal; let activityApplied: Json | null = null;
    for (const a of (ctx.activities || []) as Activity[]) {
      const candidate = a.type === "threshold_reduction" && subtotal >= (a.threshold || Infinity) ? subtotal - (a.discount || 0) : a.type === "category_discount" && products.some(p => p.category === a.category) ? subtotal - products.filter(p => p.category === a.category).reduce((s, p) => s + p.price * (1 - (a.rate || 1)), 0) : subtotal;
      if (candidate < afterActivity) { afterActivity = candidate; activityApplied = a; }
    }
    const eligible = ((ctx.coupons || []) as Coupon[]).filter(c => afterActivity >= c.threshold && (!c.category || products.some(p => p.category === c.category))).sort((a, b) => b.discount - a.discount);
    const coupon = eligible[0] || null;
    const finalPrice = Math.max(0, afterActivity - (coupon?.discount || 0));
    return { subtotal, activityApplied: activityApplied ? { id: activityApplied.id, name: activityApplied.name } : null, couponApplied: coupon ? { id: coupon.id, name: coupon.name, discount: coupon.discount } : null, savings: Number((subtotal - finalPrice).toFixed(2)), finalPrice: Number(finalPrice.toFixed(2)), note: "按推荐商品各 1 件试算，不含运费" };
  }
  throw new Error(`未知 Tool: ${id}`);
}

function skillInput(id: string, userInput: string, ctx: Json): Json {
  if (id === "need-extraction") return { userInput, conversation_history: ctx.history };
  if (id === "recommendation-decision") return { userInput, conversation_history: ctx.history, need: ctx.need, products: ctx.products, toolResults: ctx.toolResults, mcpResults: ctx.mcpResults, skillResults: ctx.skillResults };
  if (id === "recommendation-reason") return { conversation_history: ctx.history, need: ctx.need, products: ctx.selectedProducts, mcpResults: ctx.mcpResults, skillResults: ctx.skillResults };
  if (id === "response-generator") return { userInput, conversation_history: ctx.history, need: ctx.need, products: ctx.selectedProducts, reasons: ctx.reasons, price: ctx.price, toolResults: ctx.toolResults, mcpResults: ctx.mcpResults, skillResults: ctx.skillResults };
  if (id === "risk-check") return { userInput, conversation_history: ctx.history, reply: ctx.reply, products: ctx.selectedProducts, price: ctx.price, toolResults: ctx.toolResults, mcpResults: ctx.mcpResults, skillResults: ctx.skillResults };
  return { userInput, context: ctx };
}

export type RunOptions = { sessionId?: string; persistConversation?: boolean; recordMetric?: boolean; retryLimit?: number };

export async function runAgent(userInput: string, options: RunOptions = {}): Promise<RunResult> {
  const requestId = crypto.randomUUID(); const runStarted = Date.now();
  const persistConversation = options.persistConversation !== false; const recordMetric = options.recordMetric !== false;
  const sessionId = options.sessionId || crypto.randomUUID();
  const existingConversation = options.sessionId ? await getConversation(options.sessionId) : undefined;
  const conversation: Conversation = existingConversation || { id: sessionId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messages: [] };
  const [skills, tools, mcpServers, planner, experiments] = await Promise.all([getSkills(), getTools(), getMcpServers(), getPlanner(), getExperiments()]);
  const skillMap = new Map(skills.map(s => [s.id, s]));
  const toolMap = new Map(tools.map(tool => [tool.id, tool]));
  const serverMap = new Map(mcpServers.map(server => [server.id, server]));
  let plan: Plan;
  try { plan = await buildPlan(userInput, skills, tools, planner, conversation.messages); }
  catch (error) {
    if (recordMetric) await appendMetric({ id: crypto.randomUUID(), requestId, createdAt: new Date().toISOString(), success: false, latencyMs: Date.now() - runStarted, stepCount: 0, failedStep: "planner", sessionId });
    throw error;
  }
  const trace: TraceItem[] = []; const ctx: Json = { userInput, toolResults: [], mcpResults: [], skillResults: [], history: conversation.messages.slice(-8), experiments: [] };
  for (const step of plan.steps) {
    const started = Date.now(); let input: Json = step.type === "tool" ? { userInput, need: ctx.need, products: ctx.selectedProducts || ctx.products, activities: ctx.activities, coupons: ctx.coupons } : skillInput(step.capability, userInput, ctx);
    let attempts = 0; const retryLimit = options.retryLimit ?? 1;
    while (attempts <= retryLimit) try {
      attempts += 1;
      let output: Json;
      if (step.type === "tool") {
        const tool = toolMap.get(step.capability);
        if (!tool) throw new Error(`Tool 配置不存在：${step.capability}`);
        if (tool.implementation === "mcp") {
          const server = tool.serverId ? serverMap.get(tool.serverId) : undefined;
          if (!server) throw new Error(`MCP Server 配置不存在：${tool.serverId || "未设置"}`);
          input = await prepareMcpArguments(tool, userInput, ctx);
          validateSchema(input, tool.inputSchema as JsonSchema | undefined, `${tool.id} input`);
          output = await callMcpTool(server, tool.remoteName!, input);
          ctx.mcpResults.push({ toolId: tool.id, toolName: tool.name, output });
        } else output = await executeLocalTool(step.capability, ctx);
      }
      else {
        const skill = skillMap.get(step.capability)!;
        validateSchema(input, skill.inputSchema, `$${skill.id} input`);
        const experiment = experiments.find(item => item.enabled && item.skillId === skill.id);
        const useVariant = Boolean(experiment && Math.random() * 100 < experiment.trafficPercent);
        const activeSkill = useVariant ? { ...skill, prompt: `${skill.prompt}\n\n## Experiment Variant\n${experiment!.variantPrompt}` } : skill;
        output = await callModel(activeSkill, input);
        if (step.capability === "need-extraction") output = normalizeNeed(output);
        validateSchema(output, skill.outputSchema, `$${skill.id} output`);
        if (experiment) ctx.experiments.push({ skillId: skill.id, variant: useVariant ? "variant" : "control" });
      }
      if (step.capability === "need-extraction") {
        ctx.need = output;
      }
      if (step.capability === "query_products") ctx.products = output.products;
      if (step.capability === "query_activities") ctx.activities = output.activities;
      if (step.capability === "query_coupons") ctx.coupons = output.coupons;
      if (step.capability === "calculate_price") ctx.price = output;
      if (step.type === "tool") ctx.toolResults.push({ toolId: step.capability, output });
      if (step.capability === "recommendation-decision") { ctx.decision = output; ctx.selectedProducts = (ctx.products || []).filter((p: Product) => (output.recommended_product_ids || []).includes(p.id)); }
      if (step.capability === "recommendation-reason") ctx.reasons = output.reasons;
      if (step.capability === "response-generator") ctx.reply = output.reply;
      if (step.capability === "risk-check") ctx.risk = output;
      if (step.capability === "human-handoff-decision") ctx.handoffDecision = output;
      if (step.type === "skill" && !coreSkillIds.has(step.capability)) ctx.skillResults.push({ skillId: step.capability, output });
      trace.push({ ...step, status: "success", input, output, startedAt: new Date(started).toISOString(), durationMs: Date.now() - started, attempts });
      break;
    } catch (error) {
      if (attempts <= retryLimit) continue;
      trace.push({ ...step, status: "failed", input, output: { error: error instanceof Error ? error.message : String(error) }, startedAt: new Date(started).toISOString(), durationMs: Date.now() - started, attempts });
      if (recordMetric) await appendMetric({ id: crypto.randomUUID(), requestId, createdAt: new Date().toISOString(), success: false, latencyMs: Date.now() - runStarted, stepCount: trace.length, failedStep: step.capability, sessionId, experiments: ctx.experiments });
      throw Object.assign(new Error(`步骤 ${step.capability} 执行失败（已重试 ${attempts - 1} 次）`), { trace, cause: error, sessionId });
    }
  }
  const risk = ctx.risk || { passed: false, risk_level: "high", issues: ["风控未执行"] };
  const finalReply = risk.passed ? ctx.reply : risk.safe_reply || "抱歉，回复未通过风控审核。";
  const handoffDecision = ctx.handoffDecision as Json | undefined;
  const handoff = {
    required: handoffDecision?.required === true || risk.risk_level === "high" || !risk.passed,
    reason: handoffDecision?.reasons?.join("；") || risk.issues?.join("；") || undefined
  };
  if (persistConversation) {
    conversation.updatedAt = new Date().toISOString(); conversation.messages.push({ role: "user", content: userInput, at: new Date().toISOString() }, { role: "assistant", content: finalReply, at: new Date().toISOString() });
    await saveConversation(conversation);
  }
  if (recordMetric) await appendMetric({ id: crypto.randomUUID(), requestId, createdAt: new Date().toISOString(), success: true, latencyMs: Date.now() - runStarted, stepCount: trace.length, riskLevel: risk.risk_level, sessionId, experiments: ctx.experiments });
  return { requestId, mode: "ai", userInput, plan, executionTrace: trace, finalReply, risk, sessionId, handoff, experiments: ctx.experiments };
}

export async function testSkill(skill: Skill, input: string) {
  const parsed = (() => { try { return JSON.parse(input); } catch { return { userInput: input, reply: input }; } })();
  const started = Date.now();
  const output = await callModel(skill, parsed);
  return { mode: "ai", output, durationMs: Date.now() - started };
}

export async function generateSkillDraft(request: string): Promise<Skill> {
  if (!request.trim()) throw new Error("请描述希望创建的 Skill 能力");
  const existing = await getSkills();
  const creator: Skill = {
    id: "create-skill",
    name: "Create Skill",
    description: "Generate a standard agent Skill draft.",
    prompt: "你是 Create Skill 设计器。把用户的自然语言需求转换为简洁、可复用的标准 Agent Skill。名称必须使用64字符以内的英文小写连字符格式，并避免 existing_skill_ids；description 必须同时说明能力和触发场景；instructions 使用命令式语言，包含工作流、事实边界、失败处理和明确 JSON 输出约定，不要包含 YAML frontmatter，不要创建 README 或无关文件。输出 JSON：id、display_name、description、instructions、temperature、max_tokens。",
    model: "default",
    temperature: 0.2,
    maxTokens: 1800,
    enabled: true
  };
  const result = await callModel(creator, { request, existing_skill_ids: existing.map(skill => skill.id), platform: "零食电商客服 Plan + Skill 执行平台" });
  const rawId = String(result.id || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-").slice(0, 64);
  const id = rawId || `custom-skill-${Date.now().toString(36)}`;
  const temperature = Number(result.temperature);
  const maxTokens = Number(result.max_tokens);
  return {
    id,
    name: String(result.display_name || id),
    description: String(result.description || request).slice(0, 1024).replace(/[<>]/g, ""),
    prompt: String(result.instructions || "# Skill Instructions\n\nProcess the request and return one JSON object."),
    model: "default",
    temperature: Number.isFinite(temperature) ? Math.min(1, Math.max(0, temperature)) : 0.2,
    maxTokens: Number.isFinite(maxTokens) ? Math.min(4000, Math.max(100, Math.round(maxTokens))) : 800,
    enabled: true
  };
}

export async function generatePromptSuggestion(payload: unknown) {
  const skill: Skill = {
    id: "prompt-improvement-advisor",
    name: "Prompt 改进建议生成器",
    description: "Generate Prompt improvement suggestions from annotations and quality signals.",
    prompt: "你是零食电商客服 Agent 的 Prompt 优化顾问。根据输入中的改进建议、六维质量低分、Bad Case 和标注样本，输出可复制的 Prompt 修改建议。不要编造不存在的数据。输出 JSON：summary、target_skills（数组）、planner_rules（数组）、skill_prompt_patches（数组，每项含 skill_id、reason、patch_text）、eval_followups（数组）。",
    model: "default",
    temperature: 0.2,
    maxTokens: 1800,
    enabled: true
  };
  return callModel(skill, payload);
}

export async function generateSkillDraftFromAnnotation(record: AnnotationRecord): Promise<Skill> {
  const dimensions = Object.entries(record.qualityDimensions || {}).map(([key, value]) => `${key}:${value.score}/5 ${value.note || ""}`).join("；");
  return generateSkillDraft(`基于这条人工标注生成一个可复用 Skill 草案。客户问题：${record.input}\n模型当时回复：${record.modelResponse}\n人工期望回复：${record.expectedResponse}\n意图：${record.intentLabel}\n风险等级：${record.riskLevel}\n质量标签：${record.qualityLabel}\n六维质量：${dimensions}\n必经能力：${record.requiredCapabilities.join(",")}\n期望事实：${record.expectedFacts.join(",")}\n禁用表述：${record.forbiddenPhrases.join(",")}\n备注：${record.notes}`);
}

export async function explainArtifact(type: "agent" | "planner", payload: unknown) {
  const explainer: Skill = {
    id: "execution-explainer",
    name: "执行解释器",
    description: "Explain auditable Agent and Planner artifacts.",
    prompt: type === "agent"
      ? "你是 Agent 执行解释器。仅根据输入中的 plan、executionTrace、risk 和 finalReply，用清晰中文解释：任务目标、为何调用主要 Skill/Tool、价格与优惠的数据来源、是否发生重试、风控结果和用户可以如何核验。不要补造事实，不输出隐藏思维链。输出 JSON：summary、sections（title、content 数组）、verification_tips。"
      : "你是 Planner 配置解释器。仅根据输入中的 Planner 配置、decisionTrace 和 plan，用清晰中文解释：规划目标、必经能力、价格规则、模型候选、白名单过滤和最终顺序。指出安全兜底，但不要输出隐藏思维链。输出 JSON：summary、sections（title、content 数组）、verification_tips。",
    model: "default", temperature: 0.2, maxTokens: 1200, enabled: true
  };
  return callModel(explainer, payload);
}

export async function judgeEvaluation(item: EvaluationCase, run: RunResult) {
  if (!item.judgeCriteria.trim()) return undefined;
  const settings = await getEvaluationSettings();
  const judge = internalSkill("eval-response-judge", settings.judgePrompt);
  const toolEvidence = run.executionTrace.filter(step => step.type === "tool").map(step => ({ capability: step.capability, output: step.output }));
  const output = await callModel(judge, { userInput: item.input, finalReply: run.finalReply, criteria: item.judgeCriteria, toolEvidence });
  const score = Math.max(0, Math.min(100, Math.round(Number(output.score) || 0)));
  return { score, issues: Array.isArray(output.issues) ? output.issues.map(String).slice(0, 8) : [] };
}

export async function testPlanner(planner: PlannerConfig, userInput: string) {
  const [skills, tools] = await Promise.all([getSkills(), getTools()]);
  return buildPlan(userInput, skills, tools, planner);
}

export function getAiStatus() { const cfg = apiConfig(); return { configured: Boolean(cfg.key), mode: cfg.key ? "ai" : "unconfigured", model: cfg.model, baseUrl: cfg.base }; }
