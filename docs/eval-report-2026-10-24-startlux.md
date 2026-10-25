# SnackOps × StartLux-Decision 决策闸门 — 评测报告（2026-10-24）

> 规格依据：docs/spec-startlux-decision-gate.md（v3，经两轮外部质询修订，附录含修订对照）。
> 证据分层：① 契约层（**live 已验证**，docs/startlux-contract.md）② fixture 层（86 条，live 实测）③ replay 层（205 条真实回复 live 重放）。
> 与历史两轮报告（docs/eval-report-2026-10-20*.md，9 条精选 C01-C09）**不直接可比**：本轮用例集为 103 条全集，且评分器正则已同步（lib/intent.ts 单一真源）。

## 0. 执行摘要

1. **交付**：StartLux-Decision 概率闸门接入 SnackOps（一期回复放行闸门 + 二期入口分流 shadow/assist），LLM 生成、决策模型裁决、拦截即服务端自动 appendHandoff 转人工。
2. **Live 关键数字**：契约冒烟 HTTP 200（3.1s）；fixture 86 条 live 实测 **FNR=0（45 坏回复全拦）、action 84/86、诈骗维度 precision 0.923/recall 1.0**；205 条真实回复 live replay **195 放行 / 5 误拦（FPR 2.5%，全为安全方向的进人工误拦）/ 5 限流跳过**。
3. **质询闭环**：两轮外部质询 8×P0 + 13×N + 12×R 全部落映射（spec 附录 A/B）；三个致命项在实现前修正；live 阶段又实证了两条质询预言（P1-3 gate/超时打架、P0-7 mock 自证）并各给出数据。
4. **上线建议**：`GATE_MODE` 保持默认 off；演示/观察用 `live_shadow`（真实调用只记录不拦截）；FPR 2.5% 的改进路径见 §10 ADR，enforce 待误拦率达标后开启。

## 1. 环境与实验设计

- LLM：deepseek-chat；决策模型：startlux-decision-27b-autothink（**live**，bamboonode.dev 免费档）。
- 用例：103 条（79 种子 + 24 自定义）；fixture 86 条（41 安全 + 45 坏，逐问人工标签）。
- Replay 归因设计（Round 2 N5）：off 组全量生成落盘 → probe 对同一批固定回复重放闸门。
- 关键实测决策：**think_mode "always"**（auto+gate0.9 一次前向失准 0.30/0.29 → always 0.99/0.85，代价 2.2-8.4s）；**allow_none: false**（Bamboo 部署默认 true，choice 可能 null）；超时 15s（e2e 最坏 25s < 35s 上限）。详见 docs/startlux-contract.md。

## 2. off 组基线（GATE_MODE=off, PRICE_CHECK_MODE=off）

2026-10-24T09:21:59Z 起，103 条，约 20 分钟：**PASS 61 | REVIEW 18 | FAIL 23 | ERROR 1**。全部 `gateStatus: off`（第一版曾因价格预检在 off 下拦截 eval-price-office 污染基线，已重跑并归档污染组）。FAIL 主因为 LLM 生成方差与评分器已知子串误判（历史 P2），非闸门因素。

## 3. fixture 层：live 实测精度（86 条）

| 维度 | threshold | tp | fp | tn | fn | precision | recall |
|---|---|---|---|---|---|---|---|
| no_fabrication | 0.55 | 38 | 0 | 27 | 21 | **1.0** | 0.644 |
| no_forbidden_claims | 0.65 | 57 | 0 | 10 | 19 | **1.0** | 0.75 |
| is_fraud_suspected | 0.5 | 12 | 1 | 73 | 0 | 0.923 | **1.0** |
| reply_has_fraud_guidance | 0.9 | 3 | 0 | 9 | 0 | **1.0** | **1.0** |
| action（choice） | — | 84/86 正确 | | | | | |

- **FNR=0**：45 条坏回复全部被拦（承重信号是 action.choice——45 条坏回复全部选 escalate，无一选 release/revise）。
- 多轮诈骗（history 铺垫、当前消息正常）live 拦截验证通过。

## 4. live replay：205 条真实回复

- **195 passed / 5 blocked / 5 rate_limited skipped / 0 error**。
- 5 个拦截逐一核查**全部为误拦**（对应 eval 判定 3×PASS100、1×PASS94、1×FAIL 为关键词口径），FPR 2.5%：
  - forbidden-claims 对冲 3 例（回复含"无额外蔗糖/配料/拒绝式"表述，模型给 0.51-0.63）；
  - action 判定抖动 2 例（好回复被选 escalate/revise 且置信极低 0.12-0.15）。
- 5 条 rate_limited：免费档持续批量会限流——批量 live 评测需加间隔；单次会话不受影响。
- 确定性价格预检在 205 条真实回复上 **0 误拦**（语境分类器经 3 轮迭代，6→1→0，全程留痕 §6）。

## 5. 端到端冒烟（live，8/8 PASS）

PII 脱敏自检；带指引诈骗放行；无指引诈骗拦截；多轮诈骗拦截；正常推荐放行；诈骗 e2e（LLM 生成指引→闸门验证放行）；N2 价格回归放行；闸门拦截→兜底话术+handoffs.json 自动入队。

## 6. 校准迭代全记录（对质询的回应）

**价格预检（确定性层）3 轮**：v1 FPR 6/102（"减8元"被后文"最终应付"污染等）→ v2 1/102（"合计=小计"歧义）→ v3 **0/205**。修复：总额只认 8 字前缀+排除优惠词、"合计"归小计、20 字否定扫描（拒绝话术引用的金额不硬拦）、finalPrice≤0 不比对。

**概率闸门（问题集+阈值）4 轮 live**：
| 轮 | FPR | 根因 | 修复 |
|---|---|---|---|
| 1 | 46% | 问法惩罚"无主张回复"（0.71 误拦纯指引）+ action 置信 0.8 过高 + 关键词 max 误拦合法中奖咨询 | 问法限定事实断言、阈值降 0.6、拦截只信模型概率 |
| 2 | 24% | fixture facts 覆盖不全（7天售后/高蛋白等） | 补全 5 个 fixture 事实（对齐生产 buildVerifiedFacts） |
| 3 | 97.6% | **题目极性反转事故**：改"是否做出违禁"未翻转规则方向 | 回滚问法极性，代码内注释立碑 |
| 4 | **19.5%**（fixture）/ **2.5%**（真实回复） | 模型对含健康词/拒绝式回复的 forbidden 对冲 | 冻结 prompt，按类边界选工作点，残余列改进路径 |

其他：mock 响应信封双嵌套、risk_failed 短路缺失、off 组基线污染、Git Bash curl 中文 GBK 乱码（改 node fetch）。

## 7. 已知限制与下一步

- **FPR 2.5%（5/200）**：全部为安全方向误拦（进人工）。改进路径：① forbidden-claims 问法针对"无蔗糖/配料"类描述再做一轮校准；② 扩 fixture 至 150+ 重选工作点；③ 或接受 2.5% 以换取 FNR=0（误拦成本=人工工单，漏放成本=错误回复直达客户——安全闸门取保守侧）。
- **限流**：免费档批量 live 评测需 1-2s 间隔；生产建议升级付费档或本地部署（README 支持自建 /v1/systemone）。
- FNR=0 的证据限于 45 条 fixture；真实漏放率需长期 live_shadow 观察累积。
- 评分器 oracle 误判（历史 P2）未修；闸门指标以 fixture 人工标签 + 逐例人工核查为准。

## 8. 二期：入口分流（shadow/assist）

- 实现：`STARTLUX_INTENT_MODE=off|shadow|assist`；assist 时 `is_price_consult ≥ 0.8` 并入 priceTools 锁定；`scenario=fraud_suspect`（置信≥0.8）强制 handoff.required；testPlanner 传 source="test" 不触发决策调用；urgency 删除（无消费者，质询 P1-5）。
- assist 全量回归（103 条）：PASS 60 / REVIEW 18 / FAIL 25 / ERROR 0 vs 基线 PASS 61 / REVIEW 18 / FAIL 23 / ERROR 1；逐例 8 处状态变化全为温度方差（价格类零变化、价格 Tool 锁零差异——mock intent 与正则同语义）；真实一致率数据已逐条落盘 `plan.intentGate.agreed`，待 live 后聚合。

## 9. Unit Economics（live 实测）

- 单次闸门调用：5 问，input ~300-500 tokens，延迟 2.2-8.4s（always 模式）；免费档实测 0 成本。
- 每次会话新增：1 次回复闸门（必）+ 1 次 intent 闸门（assist 模式）+ 确定性检查（≈0）。
- Break-even：误拦 2.5% → 每 40 会话 1 张人工工单；漏放（fixture FNR=0）→ 错误回复直达客户。安全闸门取保守侧合理，但 2.5% 应随校准下降。

## 10. ADR：分层阈值与放行规则（live 校准后）

- **最终工作点**：`{release: 0.55, forbidden: 0.65, actionConfidence: 0.35, fraudSuspect: 0.5, fraudGuidance: 0.9, noneProbability: 0.5}`。
- **依据**：86 fixture 类边界实测——safe no_fab 最小 0.589 / safe forb 最小 0.696 / safe action-conf 最小 0.38，阈值取边界下方留边际；坏回复全部由 action=escalate 承接（veto 为辅助防御）。
- **教训（写进叙事）**：决策模型的绝对概率值不对应直觉刻度（0.7 可能是"对冲的 yes"），只有相对分离度可依赖；阈值必须从实测分布选，不从文档抄。初始 0.9/0.8/0.8 来自 README 基准口径，实测偏高 0.3-0.4。
- **题目极性纪律**：noul 的 yes 必须对应"好"方向；迭代 3 的极性反转事故（FPR 97.6%）以代码注释立碑。
- **残余风险**：in-sample 校准（86 条），需扩样复核；模型版本升级必须重放 fixture（版本固定 startlux-decision-27b-autothink）。

## 11. 作品集交付页索引

- Rollout：off → live_shadow（推荐演示模式）→ live（拦截即自动转人工），env 开关即 kill switch（RTO 分钟级）。
- 监控：gate_coverage / gate_error_rate / skip 率（upstream vs risk_failed 分列）/ false_block_rate（人工复核口径）/ p50-p95 延迟 / cost；数据源 RunMetric.gateStatus + /api/status gate 块 + 熔断器状态；告警建议 error>2% 持续 5min、连续 3 次 skip、p95>10s。
- 风险登记：PII（脱敏+单测）、供应商故障（分级降级+熔断+确定性兜底常开）、限流（免费档实测存在，批量需 pacing）、模型漂移（版本固定+升级重放）、误拦成本（2.5% → 人工工单，改进路径明确）。
- 取舍：不做自动重写（revise 仅记录）；urgency 不接入；评分器 oracle 修复另行立项。
