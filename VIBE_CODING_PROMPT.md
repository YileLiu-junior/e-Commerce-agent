# SnackOps Vibe Coding Prompt

你是一个资深全栈产品工程师，请基于当前仓库继续开发一个「零食电商客服 Agent / Planner / Skill / Eval 运营平台」。

请像和产品负责人一起 vibe coding 一样工作：先理解现有架构，再小步实现、及时验证、保持 UI 简洁温暖。不要重写整个项目，优先在现有代码上增量改造。

## 项目定位

这是一个面向零食电商客服场景的 AI Agent MVP。它不是单纯聊天机器人，而是一套可配置、可审计、可评测、可运营改进的 Agent 执行平台。

核心目标：

- 用户输入客服问题。
- Planner 根据已启用的 Skill 和 Tool 生成执行计划。
- Executor 按计划调用 Skill / Tool。
- 每一步都记录输入、输出、耗时、状态和错误。
- 最终回复必须经过风控审核。
- 运营人员可以管理 Skill、Tool、Planner、Eval、数据标注、Bad Case、评分和改进建议。

## 技术栈

- Next.js 15 App Router
- TypeScript
- React 19
- Tailwind CSS 4
- 本地 JSON 文件模拟数据库
- OpenAI API 或兼容大模型 API
- 不需要真实登录
- 不需要真实电商接口

运行方式：

```bash
npm install
cp .env.example .env.local
npm run dev
```

校验方式：

```bash
npm run typecheck
npm run build
```

每次改完功能都必须至少跑 `npm run typecheck`，重要改动还要跑 `npm run build`。

## 当前项目结构

主要目录：

```text
app/
  page.tsx                       前台 Agent 执行页
  demo/page.tsx                  零食小助手聊天 Demo 页
  skills/page.tsx                Skill 管理页
  tools/page.tsx                 Tool 管理页
  planner/page.tsx               Planner 管理页
  ops/page.tsx                   运营中心
  catalog/page.tsx               数据中心
  api/                           所有本地 API

components/
  AnnotationWorkspace.tsx        数据标注
  ImprovementCenter.tsx          改进建议中心
  HumanReviewWorkspace.tsx       人工评估
  JudgePromptEditor.tsx          LLM-as-Judge Prompt 管理
  Header.tsx                     顶部导航

lib/
  engine.ts                      Planner / Executor / Skill / Tool 核心执行逻辑
  store.ts                       本地 JSON 存储
  types.ts                       全局类型
  mcp.ts                         MCP Streamable HTTP 工具调用
  eval-seeds.ts                  Eval 种子用例

data/
  skills.json                    Skill 运行参数与启用状态
  planner.json                   Planner Prompt、模型参数、规则
  tools.json                     Tool 配置
  products.json                  商品数据
  activities.json                活动数据
  coupons.json                   优惠券数据
  orders.json                    订单数据
  return-policies.json           售后政策数据
  conversations.json             会话记录
  service-ratings.json           用户服务评分
  annotations.json               标注数据
  eval-cases.json                评测集
  eval-results.json              评测结果
  eval-settings.json             LLM-as-Judge 配置
  experiments.json               Prompt A/B 实验
  versions.json                  配置版本快照
  mcp-servers.json               MCP Server 配置

skills/
  */SKILL.md                     标准 Skill 文件
  */agents/openai.yaml           Skill UI metadata
```

## 已有页面与功能

### 1. 前台 Agent 执行页 `/`

功能：

- 输入客服问题。
- 读取已启用 Skill 和 Tool。
- Planner 生成 Plan JSON。
- Executor 执行每一步。
- 展示：
  - 用户输入
  - Planner 计划
  - Planner 思考 / 决策过程
  - 每一步 Skill / Tool 调用
  - 每一步输入输出 JSON
  - 最终客服回复
  - 风控审核结果
  - 全链路 Trace
- 支持多轮会话。
- 支持步骤失败重试。
- 支持人工接管。
- Agent 和 Planner 都有解释说明能力。

### 2. Demo 聊天页 `/demo`

产品形态：

- 标题「零食小助手」
- 绿色在线状态点
- 顶部 3 个常见问题按钮
- 中间消息区，AI 靠左浅色气泡，用户靠右暖色气泡
- 底部输入框 + 圆形发送按钮
- 回车发送
- 发送后清空输入框
- 自动滚到底部
- 回复前显示「正在输入…」约 1 秒
- 实际回复连接 Agent 能力

服务结束判断：

- 不做结束按钮。
- Agent 判断沟通流程结束，或者 90 秒没有继续发言。
- 自动在聊天框里出现 1-5 分评分。
- 不出现建议框，只评分。
- 评分进入运营中心。
- 1 分进入 Bad Case / 改进队列。

### 3. Skill 管理页 `/skills`

功能：

- Skill 列表。
- 编辑 Skill 名称、描述、模型参数、启用状态。
- 测试单个 Skill。
- 查看 Skill 文件内容。
- 新增 Skill。
- AI Create Skill 模式：用自然语言描述能力，生成标准 Skill 草案。
- Skill 文件采用 `SKILL.md` Agent 标准 Skill 调用方式。
- Prompt 不再主要存储在 `data/skills.json`，而是来自 `skills/<skill-id>/SKILL.md`。

内置 Skill 包括但不限于：

- need-extraction：用户需求结构化
- recommendation-decision：商品推荐决策
- recommendation-reason：推荐理由生成
- response-generator：客服话术生成
- risk-check：风控审核
- allergy-risk-reminder：过敏风险提醒
- complaint-triage：投诉分流
- after-sales-classification：售后问题分类
- clarification-question：澄清问题生成
- conversation-summary：会话总结
- gift-scenario-advisor：送礼场景推荐
- human-handoff-decision：人工接管判断
- product-substitution：缺货替代推荐

### 4. Tool 管理页 `/tools`

功能：

- Tool 列表。
- 启用 / 停用 Tool。
- 编辑 Tool 名称、描述、数据源等配置。
- 查看 Tool 的代码或 JSON。
- 管理 MCP Server。
- 连接 MCP Server 并导入远程 Tool。

内置 Tool：

- query_products：查询 `products.json`
- query_activities：查询 `activities.json`
- query_coupons：查询 `coupons.json`
- calculate_price：代码计算满减、优惠券、最终价

扩展 Tool：

- 订单查询相关 Tool 可基于 `orders.json`
- 退换货政策 Tool 可基于 `return-policies.json`
- MCP Tool 使用 `implementation: "mcp"`

### 5. Planner 管理页 `/planner`

功能：

- 编辑 Planner Prompt。
- 编辑模型参数。
- 配置必经 Skill。
- 配置基础 Tool、价格相关 Tool。
- 预览 Planner 输出。
- 显示 Planner 思考 / 决策过程。
- 管理 Planner 设计逻辑。

Planner 规则：

- 只能调用 `available_skills` 和 `available_tools` 中存在且启用的能力。
- 涉及价格、活动、优惠券，不允许大模型编造，必须调用 Tool。
- 最终回复必须调用 `risk-check`。
- 如果 `risk-check` 被停用，前台不能生成未经风控的最终回复。
- 商品过滤、价格计算、优惠券匹配必须用代码实现。
- 大模型用于需求结构化、推荐决策、推荐理由、话术生成、风控审核。
- 每一步必须进入 `execution_trace`。

### 6. 运营中心 `/ops`

包含多个标签：

- 运行监控
- 改进建议
- 人工评估
- 服务评分
- 评测集
- 评测中心
- 数据标注
- 版本回滚
- Prompt A/B

#### 运行监控

- 成功率
- 平均耗时
- 失败步骤
- 人工接管率
- 风险等级统计

#### 服务评分

- 接收 Demo 和 Agent 的用户评分。
- 保存当时 QA 对。
- 1 分自动进入 Bad Case / 改进建议。

#### 评测集

可以看到每一条：

- 场景
- 用户输入
- 期望答案 / 关键词
- 评测维度
- 期望能力路径
- 禁用能力
- 风控要求

#### 评测中心

功能：

- 对评测集运行真实 Agent。
- 展示评测过程。
- 展示每条 case 的执行 trace。
- 展示 bad case。
- 展示评分方法：
  - 精准匹配 exact_match
  - 余弦相似度 cosine_similarity
  - LLM-as-Judge
  - 人工评估 human_review
- 展示 LLM-as-Judge Prompt。
- 允许修改 LLM-as-Judge Prompt。

#### 数据标注

功能：

- 标注用户问题、模型回复、期望回复。
- 设置意图、风险等级、质量标签。
- 设置必经能力、期望事实、禁止表述。
- 六维质量标注：
  - 正确性 correctness
  - 相关性 relevance
  - 完整性 completeness
  - 安全性 safety
  - 语气 tone
  - 整体质量 overall
- 状态流转：
  - pending
  - annotated
  - approved
  - rejected
- 已审核标注可以发布为 Eval。
- 已审核标注可以一键生成 Skill Prompt 草案。
- 标注数据可以导出 JSONL，用于未来 fine-tuning。

#### 改进建议中心

功能：

- 汇总 Bad Case。
- 汇总低评分 QA。
- 汇总低分六维标注。
- 自动生成改进建议。
- 自动生成 Prompt 修改建议。
- 展示弱项维度。
- 给出 Planner / Skill / Tool / Eval 后续改进方向。

### 7. 数据中心 `/catalog`

管理本地模拟数据：

- 商品
- 活动
- 优惠券
- 订单
- 售后政策

## 核心数据类型

重要类型在 `lib/types.ts`。

关键类型：

- `Skill`
- `SkillRuntimeConfig`
- `ToolConfig`
- `PlannerConfig`
- `Plan`
- `PlanStep`
- `PlannerDecisionEvent`
- `TraceItem`
- `RunResult`
- `EvaluationCase`
- `EvaluationResult`
- `EvaluationScoringMethod`
- `AnnotationRecord`
- `QualityDimensions`
- `ServiceRating`
- `PromptExperiment`
- `VersionSnapshot`
- `McpServerConfig`

修改类型时，必须同步检查相关 API、组件和 data JSON。

## 核心后端 API

常用 API：

```text
POST /api/run                              运行 Agent
POST /api/run/retry                       重试失败步骤
POST /api/explain                         解释 Agent / Planner 产物

GET/PUT /api/skills                       Skill 配置
GET/PUT /api/skills/[id]                  单个 Skill
POST /api/skills/test                     测试 Skill
POST /api/skills/generate                 AI 生成 Skill 草案

GET/PUT /api/tools                        Tool 配置
GET /api/tools/[id]/source                查看 Tool 源码或 JSON

GET/PUT /api/planner                      Planner 配置
POST /api/planner/test                    测试 Planner

GET/POST /api/evaluations                 Eval 运行
GET/PUT /api/evaluation-settings          LLM-as-Judge 设置

GET/PUT/POST /api/annotations             标注数据
GET /api/annotations/export               导出 JSONL

GET /api/improvement-suggestions          改进建议
POST /api/improvement-suggestions/generate-prompt 生成 Prompt 修改建议

GET/POST /api/human-reviews               人工评估
GET/POST /api/ratings                     用户服务评分

GET/PUT /api/experiments                  Prompt A/B
GET/POST /api/versions                    版本快照与回滚

GET/PUT /api/mcp/servers                  MCP Server 配置
POST /api/mcp/discover                    发现并导入 MCP Tool
```

## Agent 执行主链路

主逻辑在 `lib/engine.ts`。

大致流程：

1. 读取 Skill 配置、Tool 配置、Planner 配置。
2. 读取 `skills/<id>/SKILL.md` 作为 Skill Prompt。
3. Planner 基于用户输入、可用 Skill、可用 Tool 生成计划。
4. 校验 Plan：
   - 只能使用启用能力。
   - 涉及价格 / 优惠 / 活动必须走 Tool。
   - 最终必须有 risk-check。
5. Executor 按步骤执行：
   - Skill 调用真实模型。
   - 本地 Tool 用代码查询 JSON 或计算。
   - MCP Tool 通过 Streamable HTTP 调用。
6. 每一步记录 `executionTrace`。
7. 最终回复必须经过 `risk-check`。
8. 写入 metrics / conversations / ratings / eval results 等。

## 大模型调用原则

必须遵守：

- 真实 Skill 模式，不使用 mock Skill 结果。
- 未配置 API Key 或模型调用失败时，返回明确错误。
- 价格、优惠券、活动、库存、物流、退换货政策，不能让模型编造。
- 涉及上述事实，必须调用本地 Tool 或 MCP Tool。
- 模型可以做：
  - 需求结构化
  - 推荐决策
  - 推荐理由
  - 话术生成
  - 风控审核
  - Planner 规划
  - Prompt 改进建议
  - Skill 草案生成
- 模型输出 JSON 时必须做解析和兜底错误处理。

## UI 风格

整体风格：

- 暖色调
- 米色背景
- 橙棕点缀
- 深绿色主按钮
- 大圆角
- 留白
- 像微信客服一样亲切
- 不做重后台系统的冰冷风格

交互偏好：

- 页面文案中文。
- 操作结果要可见。
- 错误要告诉用户为什么失败，以及下一步该怎么做。
- 复杂对象用 JSON 卡片展示。
- Trace、Plan、Eval 过程都要可审计。

## 编码规范

请遵守：

- 不要引入数据库，继续使用 `data/*.json`。
- 不要引入登录系统。
- 不要接真实电商接口，除非明确要求。
- 不要破坏已有页面入口。
- 不要把密钥写进代码或 JSON。
- MCP Token 只保存环境变量名，不保存明文。
- 编辑 JSON 时保持合法格式。
- 修改本地文件读写逻辑时注意并发安全和旧数据兼容。
- 新增字段时要做 normalize，兼容老 JSON。
- 前端按钮禁用时要显示原因或至少能从状态判断原因。
- 所有关键执行过程必须可追踪。

## 新功能开发方式

当我要你新增功能时，请按这个方式做：

1. 先快速定位相关页面、API、类型、JSON 数据。
2. 判断是否需要新增类型。
3. 判断是否要兼容旧数据。
4. 修改 API。
5. 修改 UI。
6. 如果涉及 Agent 链路，修改 `lib/engine.ts`。
7. 如果涉及运营数据，更新 `data/*.json` 示例。
8. 跑 `npm run typecheck`。
9. 重要功能跑 `npm run build`。
10. 最后告诉我：
    - 改了什么
    - 入口在哪里
    - 如何验证
    - 有没有已知限制

## 优先级规则

如果功能之间冲突，优先级如下：

1. 风控和事实准确性
2. 可审计 execution_trace
3. Planner 只能使用启用能力
4. 价格 / 优惠 / 活动 / 物流 / 售后政策必须走 Tool
5. UI 清晰易用
6. 运营可配置
7. 评测和标注闭环

## 常见开发任务 Prompt 模板

### 新增一个 Skill

请新增一个标准 Skill：

- 在 `skills/<skill-id>/SKILL.md` 写触发描述和执行指令。
- 在 `skills/<skill-id>/agents/openai.yaml` 写 UI metadata。
- 在 `data/skills.json` 加运行参数和启用状态。
- 如果需要输入输出结构，补充 JSON Schema。
- 确保 Planner 可以在合适场景选择它。
- 在 Skill 管理页能看到、编辑、测试。
- 跑 typecheck。

### 新增一个 Tool

请新增一个 Tool：

- 在 `data/tools.json` 增加配置。
- 如果是本地 JSON 查询，补充对应 data 文件。
- 如果是代码计算，在 `lib/engine.ts` 实现。
- Tool 必须返回结构化 JSON。
- 每次调用必须进入 execution_trace。
- 在 Tool 管理页能看到配置，并能查看代码或 JSON。
- 如果 Planner 需要使用它，更新 Planner 规则。
- 跑 typecheck。

### 新增一个 Eval 能力

请扩展 Eval：

- 修改 `EvaluationCase` / `EvaluationResult` 类型。
- 更新 `data/eval-cases.json` 或种子数据。
- 更新 `/api/evaluations` 评分逻辑。
- 在运营中心评测集和评测中心可视化展示。
- 如果是评分方法，必须展示 evidence 和 details。
- 跑 typecheck 和 build。

### 新增一个运营闭环功能

请新增运营闭环能力：

- 数据来源可以是 ratings、annotations、eval-results、conversations、metrics。
- 低分或失败样本要能进入改进建议。
- 改进建议要能指出影响的 Skill / Tool / Planner。
- 如果可以生成 Prompt 或 Skill 草案，必须要求人工确认，不要自动覆盖生产配置。
- 跑 typecheck。

## 当前已经形成的闭环

当前系统已经具备以下闭环：

```text
用户对话
  → Agent 执行 Trace
  → 用户评分
  → Bad Case
  → 数据标注
  → 六维质量评分
  → Eval Case
  → Eval 运行
  → 改进建议
  → Prompt 修改建议 / Skill 草案
  → 人工确认
  → Skill / Planner 配置更新
  → 再次 Eval 验证
```

继续开发时，不要把这个闭环做断。

## 下一步可做的方向

如果我只说“继续优化”，可以优先考虑这些方向：

1. Skill 草案一键转正式 Skill，但必须有人审确认。
2. Prompt 修改建议一键生成 Planner / Skill Patch 预览。
3. Eval 对比不同版本配置的效果。
4. Bad Case 自动聚类。
5. 标注一致性检查。
6. 评分趋势图。
7. Agent 回复引用事实来源。
8. Tool 调用失败的降级策略。
9. MCP Tool 的测试面板。
10. 会话级满意度和任务完成率分析。

## 你现在要做什么

请基于以上上下文继续开发我提出的需求。

要求：

- 先理解现有代码再动手。
- 不要删除已有功能。
- 不要大规模重构，除非确实必要。
- 每次改动尽量小而完整。
- 保持中文 UI。
- 保持可运行。
- 最后给出清晰交付说明。

