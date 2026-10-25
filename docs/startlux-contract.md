# StartLux-Decision API 契约记录

> 状态：**live 已验证**（2026-10-24，`npm run contract:check` HTTP 200，fixture 落盘 docs/startlux-contract-fixture.json）。
> 来源：bamboonode.dev 官方文档（/docs/ai-model/decisions/startlux + /reference）+ 实测。

## 已验证事实（live）

- 端点 `POST https://api.bamboonode.dev/v1/decisions`，Bearer 认证（推理密钥 sk- 开头，非网站登录令牌）。
- **模型 ID：`startlux-decision-27b-autothink`**——网关默认值（可省略），也是文档列出的唯一 ID。**"omission selects StartLux"**。
- 响应形态与 README 一致：
  - choice: `{type, choice, confidence, none_probability, probabilities}`
  - noul: `{type, noul}`（noul = yes 的概率；请求可用 bool 作别名）
  - score: `{type, score, confidence?, legend?, probabilities}`（criteria 2-10 档）
  - usage: `{input_tokens, output_tokens}`（免费期也返回真实用量）
- **本部署（A800）`allow_none` 默认 true**：choice 可能返回 null。本项目显式传 `allow_none: false` 强制从列出的 rubric 中选择（合同确定性）；代码中 choice 缺失仍按 blocked 兜底。
- `none_probability` 官方定位是"未校准的警告信号"（非精确概率），建议 ≥0.2 视为"没有合适选项"。本项目 action.noneProbability 阈值默认 0.5（可在 STARTLUX_THRESHOLDS_JSON 调整），live 校准后复核。

## 关键实测决策：think_mode

| 模式 | 实测结果 |
|---|---|
| `auto` + gate 0.9 | 一次前向读出**严重失准**：好回复 no_fabrication=0.30、action 置信 0.29；且思考触发时 >6s |
| `always`（不传 gate） | 单次思考后校准优秀：0.993 / 0.85，代价思考 ~400-600ms/问 |

**决策：回复闸门与 intent 闸门均用 `think_mode: "always"`，不传 gate 参数**（默认 0.6，always 下不参与判定）。README 的"规则类任务建议 gate 0.9"是基准测试口径，在本问题集上实测相反。

## 延迟与超时（live 实测）

- 5 问（4 noul + 1 choice）：2.2-8.4s，p99 可超 12s（服务端负载波动）。
- `STARTLUX_GATE_TIMEOUT_MS` 默认 **15000**（e2e 最坏 10s LLM 链 + 15s 闸门 = 25s，低于 eval maxLatencyMs 35000）。
- 熔断：连续 3 次上游错误/超时 → 5 分钟 skip + half-open；确定性价格预检与诈骗关键词兜底不受熔断影响。

## 错误码

200 / 401（认证）/ 422（请求校验，本项目映射 contract）/ 429（限流，按 Retry-After 退避）/ 5xx。

## 免费额度与限制

测试推广期免费（零余额新账户可用，无需充值）；/models 页需登录控制台查看；未公布明确 RPM 限制——批量评测前先 10 次 burst 探测。
