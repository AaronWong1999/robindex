# Persona 更新与评测成本事故审计（2026-07-01）

## 事故摘要

2026-07-01 18:00（北京时间），Cloudflare 的月度 Cron 自动为全部公开 KOL 创建全量
Persona map/reduce/eval 任务。分钟 Cron 随后持续推进任务，导致 OpenRouter 在约两小时内产生
大量 DeepSeek V4 Pro 和 Flash 请求。

这不是用户聊天流量。根因是后台自动更新、过宽的失败重试以及高放大的旧评测设计叠加。

## 已确认根因

1. `0 10 1 * *` 按 UTC 执行，对应北京时间每月 1 日 18:00，并自动重建全部公开 KOL。
2. 分钟 Cron 会把所有 `failed AND retries < 8` 的旧任务重新置为运行态，使历史失败任务复活。
3. 旧评测每位 KOL 有 39 题。每两题包含两次回答、最多两次 reranker、voice/stance/citation
   三种裁判，单个 KOL 可放大到百余次 Flash 请求。
4. 非流式 DeepSeek 调用未关闭 reasoning，部分 `max_tokens=700` 请求仍产生数千个计费推理 token。
5. `knowledge_chunks` 检索未排除 `persona_backup`/`persona_snapshot`，且没有长度上限。一次回答可同时
   塞入当前 Persona 和多份 15K 字符左右的旧 Persona，输入膨胀到 40K–50K token，并污染评测。
6. Eval 只保存分数，不保存回答、引用和裁判原文，导致发布决策无法复核。
7. 发布门禁只看均值，不看单题通过率，也没有把平均 stance 纳入发布条件。Qin 只有 6/39 题完整
   通过仍被发布。
8. Regression baseline 没有严格绑定“当前线上 Persona + 同一批问题”，`regressed=0` 不能证明未退化。
9. 真实题集按高互动推文生成，混入电影、安乐死、笔记软件和泛书单等非金融问题。
10. 质量失败会自动重新执行 final reduce 并完整重评一次，成本翻倍但没有使用失败原因做定向修复。
11. Alea 的历史 map JSON 中 `evidence` 可能为字符串，代码直接 `.filter()` 导致任务失败。
12. 旧 KV distill cursor 可以脱离 D1 生命周期继续执行，形成不可见的幽灵任务风险。

## 已实施修复

- 删除自动周更和月度 Persona Cron；每日抓取仍保留，且只执行 X 数据抓取和原文 FTS，不调用 LLM。
- 分钟 Cron 只推进显式创建且处于运行态的 D1 任务；失败任务只能显式 retry。
- 删除非 D1 的孤立 KV distill cursor，不再兼容执行幽灵任务。
- 每个 distill job 最多 120 个 Worker 步骤；map 最多 96 个 chunk，超限失败并保持私有。
- 所有非流式后台 completion 显式设置 `reasoning.enabled=false`。
- RAG 永久排除 Persona backup/snapshot；单知识块最多 2,500 字符，总知识上下文最多 6,000 字符。
- Eval 默认改为 8 道金融原帖题 + 4 道金融跟随者题，并仅从金融相关语料生成。
- Eval 使用确定性检索，不调用 LLM reranker。
- voice、stance、relevance、entailment 合并为一次裁判调用；裁判最多重试一次。
- Eval 保存问题、完整回答、引用 JSON、裁判分数/理由/原始输出和输入字符数。
- 候选发布要求：
  - 单题完整通过率不低于 65%；
  - citation、voice、relevance、entailment 均达到门槛；
  - 有 stance 时平均 stance 不低于 0.6；
  - DRAM 专项同时检查 citation、voice、relevance、entailment。
- Quality/coverage 失败直接拒绝并保持旧 Persona；不再随机重做 final reduce 或整轮评测。
- Profile 和 Airwallex provisioning 延后到 Eval 通过后，避免失败候选产生额外调用或外部资源。
- Baseline 只有在“当前线上 Persona、同一题目、完整可审计结果”都存在时才参与 regression 判断。
- 修复 Alea `evidence` 非数组导致的 map 崩溃。

## Qin 处置

7 月 1 日候选的综合均值约 0.677，但仅 6/39 题完整通过；真实语料题仅 1/24 通过，DRAM
专项 Voice 为 0。其评测还受旧 Persona backup 混入上下文影响，因此发布结论无效。

线上已回滚到发布前备份 `v2-mapreduce-inc-2026-06-28`。新候选保留为 rejected 审计记录。

## 成本边界

自动日常任务不再调用 LLM。只有以下显式动作会消耗模型：

- 用户实际聊天；
- 用户通过隐藏页提交一个新的 KOL；
- 管理员显式发起 Persona 重建或重试。

新 KOL 的全量 map/reduce 本身仍是有成本的必要工作，但已设置 chunk 和 Worker-step 硬上限。
超限、质量失败或技术失败不会公开，也不会无限重试。

## 仍需长期关注

- LLM judge 仍具有随机性；完整原文现已保存，可人工复核或离线重新评分。
- 首次新增全新账号的生产全流程仍需要一个受控 canary 验证，不能用重复提交已上线 KOL 代替。
- GetXAPI/Apify 的“全量”受公开可检索范围和供应商限制。
- ETF holdings 仍依赖第三方页面解析，需要后续增加 last-known-good 和第二数据源。
- 隐藏邀请 URL 仍是 bearer credential，没有账号所有权验证、内容审核和主体删除流程。
- 大语料 map 仍需要真实成本；预算上限会让极大账号失败，而不是无上限烧费。

## 运维原则

1. 线上 Persona 只能由 candidate-first 流程切换。
2. 质量失败绝不自动重试；技术失败必须有限次、指数退避并记录原因。
3. 每次评测必须保存问题、回答、来源、裁判原文和版本。
4. 任何自动 Cron 默认不得调用付费模型。
5. 新的定时模型任务必须有显式开关、单任务预算和全局预算后才能上线。

## 模型路由边界

- 用户发起：聊天、query planner、在线 reranker、追问建议、用户选择模型和 BYOK 统一走
  Cloudflare AI Gateway → OpenRouter。
- 系统发起：KOL map/reduce、Persona 生成/更新、profile、eval 和离线标签统一走
  Cloudflare Worker → DeepSeek 官方 API。
- DeepSeek key 只保存在 Worker secret `DEEPSEEK_API_KEY`；仓库不保存密钥。
- 系统调用固定使用 `deepseek-v4-flash` / `deepseek-v4-pro`，默认关闭 thinking；质量与费用不再受
  OpenRouter 上游供应商漂移影响。
