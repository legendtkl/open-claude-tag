# multi-agent-scheduling — 验收标准与测试 case

> 方案:**a(后端委派 / backend delegation)**。owner 已确认不做 (b)「飞书群对等讨论」。
> 设计来源:multi-agent-scheduling 设计提案(已通过严格校验)。
> 角色:实现 @Developer-CodeX,review @Reviewer-CodeX,测试 @QA-admin-CodeX,架构 @Architect-CC。

## 测试 case

人类在群里发送:`@R2D2 @性能成本小助手 你俩讨论一下中国高考`(R2D2 与 性能成本小助手 均为 agent)。

**方案 a 下的预期行为(关键:这是"主从委派 + 结果回流",不是两个 agent 自由多轮对等讨论)**:
- 被路由到的 coordinator agent 启动后,通过 backend delegation 把子问题委派给另一个 agent;
- 被委派 agent 只拿到 bounded task package(目标/约束/上下文摘要),拿不到 coordinator 的 SDK 历史;
- 子任务完成后结果回流,coordinator 被 exactly-once 唤醒,综合双方观点回复人类。
- **不期望**出现 bot 自动唤醒 bot 的对等群聊(D7 保持);若要真对等讨论需另立 (b) change。

## 验收标准(依据线程内与 @legendtkl 的讨论)

### A. 路由与触发(现状边界)
- [ ] 多 @ 场景:若两个都是绑定 bot → 各自 app 收事件、各自路由、各建 task(各答各的);若含虚拟 handle → 仅解析出一个 agent。该现状行为被文档化、可解释。
- [ ] "真正讨论"仅通过 coordinator 的 backend delegation 达成,不依赖 bot-to-bot 自动唤醒。

### B. 调度 / 准入(D1)
- [ ] per-agent 并发不超过 `AGENT_MAX_CONCURRENCY`;一个 agent 的积压不饿死其他 agent。
- [ ] 冷启动 slot 与运行 slot **分离**:start slot 在首个 runtime event/启动失败即释放,不等整轮结束。
- [ ] 冷启动并发 ≤ `MAX_CONCURRENT_AGENT_STARTS`,不同 agent 错峰 ≥ `AGENT_START_INTERVAL_MS`。
- [ ] 超额任务走 `admission_leases` + 延迟 rescheduler 重排;**绝不在 active singleton job 内自重入队**;无任务停在 queued 却无后续 job。
- [ ] 同一 `(agentId, taskId)` 重复 dequeue 被幂等跳过。
- [ ] 默认配置下单 agent 吞吐与现状一致(回归)。

### C. 委派(D3/D4/D5)
- [ ] depth 上限 + 调用链环检测(callee ∈ chain 拒绝);默认 `MAX_DELEGATION_DEPTH=1` 行为与现状一致。
- [ ] tree 预算 `DELEGATION_MAX_FANOUT` / `DELEGATION_MAX_TOTAL_TASKS` 原子生效;并发兄弟不超额。
- [ ] 子任务用**独立真实 child sessions 行**(UUID,稳定 sessionKey),不挂 chat active 指针、不污染人类会话;parent session 在子运行期间空闲。
- [ ] 父任务进入 `WAITING_DELEGATION`,被 startup-recovery / Feishu 卡片投影 / `/session clean` 清理正确排除,不被误回收。
- [ ] barrier:所有兄弟终态后 **exactly-once** 唤醒父任务 resume;无永久挂起、无重复唤醒;子失败也能让 barrier 完成、父可解释/恢复。

### D. 韧性(R6/D2)
- [ ] `resume()` 可取消(接收 taskId/executionId);看门狗能 cancel 卡死的 resume turn。
- [ ] 进度停滞 `RUNTIME_PROGRESS_STALE_MS` → 优雅 cancel → 超时 SIGTERM;健康任务不被误杀;启动超时生效。

### E. 作用域与配置
- [ ] 明确单 worker 作用域;多 worker 走 DB lease + advisory lock(文档化,若未实现则明确不支持多 worker)。
- [ ] 全部阈值 env 可配;`MAX_DELEGATION_DEPTH=1` + 高 per-agent 上限 = 回退到现状。

### F. 质量门禁
- [ ] `pnpm build` / `pnpm typecheck` / `pnpm lint` 通过。
- [ ] 单测覆盖 B/C/D 关键路径;E2E 覆盖:多 agent 公平、两跳委派 + barrier 综合、运行中 stale 恢复、上面的高考 case。
