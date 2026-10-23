# SnackOps — 零食电商客服 Agent MVP

## 运行

```bash
npm install
cp .env.example .env.local
npm run dev
```

打开 `http://localhost:3000`。必须在 `.env.local` 填写 OpenAI 或兼容 API 配置，5 个 Skill 始终调用真实模型；未配置或调用失败时会直接返回错误，不生成模拟结果。

## 数据与规则

- `skills/<skill-name>/SKILL.md`：标准 Skill 触发描述与执行指令
- `skills/<skill-name>/agents/openai.yaml`：Skill 的 UI metadata
- `data/skills.json`：模型参数与启用状态，不再保存 Prompt
- `data/planner.json`：Planner Prompt、模型参数与强制执行规则
- `data/tools.json`：后台可编辑的 Tool 名称、描述与启用状态
- `data/mcp-servers.json`：远程 MCP Server 配置（只保存 Token 环境变量名，不保存密钥）
- `data/products.json`、`activities.json`、`coupons.json`：本地模拟数据
- 商品过滤、活动和优惠券匹配、价格计算均在 `lib/engine.ts` 中用代码执行
- Planner 只从已启用 Skill 和 Tool 组装计划
- `$risk-check` 是最终强制步骤，停用后前台会拒绝生成未经审核的回复
- Skill 配置中心支持查看原始 `SKILL.md`，以及创建可被 Planner 动态选择的新标准 Skill
- 新增 Skill 支持 AI Create Skill 模式：自然语言描述能力、生成标准草稿、人工确认后落盘
- Planner 管理中心支持编辑规划 Prompt、必经 Skill、规则 Tool，并调用真实模型预览 Plan JSON
- 配置保存自动生成版本快照，可在运营中心回滚
- 评测中心支持真实 Agent 用例运行、关键词检查、风控与延迟评分
- Agent 执行页支持多轮会话、步骤自动重试与人工接管
- Skill 支持 Input/Output JSON Schema，执行前后自动校验
- Planner 支持可视化排序必经 Skill
- Prompt A/B 实验按流量选择变体，并记录到运行指标
- 数据中心可视化管理商品、活动与优惠券
- 运行监控统计成功率、耗时、失败步骤与人工接管率

## MCP 模式

在「Tool 管理」中填写 MCP Server 的 Streamable HTTP URL，点击“连接并导入”。平台会通过 `tools/list` 发现工具并加入 `available_tools`；Planner 按用户问题选择需要的 MCP Tool，Executor 根据 `inputSchema` 生成参数并通过 `tools/call` 执行，参数和结果都会写入 `execution_trace`。

如服务需要 Bearer Token，只在 `.env.local` 保存 Token，并在管理页填写对应环境变量名（例如 `MCP_API_TOKEN`）。MVP 不在页面中保存明文 Token，也不开放 stdio 命令执行。
