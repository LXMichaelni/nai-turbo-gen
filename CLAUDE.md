<!-- vbm:start -->
## Vibe Memory

先遵守现有用户规则和项目规则。
本区块只补充记忆工作流，不覆盖已有规则。

1. 每次任务开始时，先读取：
   - `.ai/project/overview.md`
   - `.ai/project/config-map.md`
   - `.ai/memory/handoff.md`
   - `.ai/memory/known-risks.md`

2. 修改代码前，先搜索相关记忆：
   - `.ai/memory/bugs/`
   - `.ai/memory/decisions/`
   - `.ai/project/business-rules.md`

3. 如果项目记忆中已经存在配置位置、业务规则或历史行为说明，禁止凭猜测回答，必须先检索。

4. 每轮任务结束时，优先自动执行会话收尾流程：
   - 更新 `.ai/memory/handoff.md`
   - 有代码变更时优先生成候选记忆
   - 只有内容已验证时，才正式写入 `.ai/memory/bugs/` 或 `.ai/memory/decisions/`
   - 最后重建 `.ai/index/`

5. 只允许写回已验证、可复用、与项目相关的知识：
   - 稳定事实
   - 业务规则
   - 问题根因
   - 回归风险
   - 实现决策

6. 禁止把密码、令牌、私钥或完整连接串写入记忆文件。

7. 项目记忆优先级高于全局偏好；新的已验证记录优先级高于旧记录。

8. 只更新本受控区块和本协议创建的 `.ai/` 文件，禁止覆盖用户自行编写的其他规则内容。

9. 默认不需要点名 `vbm`；只要当前任务属于项目开发且已启用本协议，就应自动读取、自动整理、自动更新交接记忆。

10. 当用户明确说“使用vbm记下来刚刚的事情”、“使用 vbm 记下来刚刚的事情”或相近表达时，优先更新 `.ai/memory/handoff.md`。

11. 当用户明确说“使用vbm记住这个 bug”、“使用 vbm 记住这个 bug”、“使用vbm记录这次决策”或“使用 vbm 记录这次决策”时，优先写入正式记忆。
<!-- vbm:end -->

<!-- project-rules:start -->
## 项目阅读优先级

- 触发：用户要求 熟悉 / 了解 / 读取项目（"看一下项目"、"熟悉项目"、"读下背景"、"了解一下这个项目"、"对项目做 X"）
- 必须：优先读 `.ai/README.md`
- 顺序：1. `.ai/README.md` · 2. `.ai/project/overview.md` · 3. `.ai/project/business-rules.md` · 4. `.ai/memory/handoff.md` · 5. `.ai/memory/known-risks.md` · 6. 按需 `.ai/memory/decisions/` + `docs/*.md`
- 跳过：单点问题（如"这个函数干什么"、拼写修复类）
- 强制回到本流程：任务涉及 项目定位 / 架构 / token / probe / queue / 跨模块决策

## 阅读协议（索引优先）

默认（访问 `.ai/` 或 `docs/` 时）：

1. 先读索引：`.ai/README.md` §3 / `docs/README.md` / `/task/index.md`（若 /task 活跃）
2. 在索引定位目标文件
3. 只读目标；避免全量拉 `.ai/memory/**` 或 `docs/**`
4. 索引未命中且任务必要 → 兜底广读（`Grep` / 目录枚举 / 批量 `Read`）

例外（跳过步骤 3，直接批量读）：用户显式说 "深度读取 / 通读 / 全量读 / 读整个项目" 等。

## 文档管理

- `.ai/`：agent 专用，无人类说明；增 / 删 / 改任一文档 → 必须同步 `.ai/README.md` §3 索引
- `/docs/`：人类向 A 版；用语遵循 `.ai/README.md` §6 / §7
- 编码：所有文本 UTF-8 无 BOM
- 命名：代码标识符英文；路径英文优先；正文 / 注释 / 日志见 `<!-- communication -->`

## A/B 纪律（详见 `.ai/README.md` §4.3）

- 必须：先改 B（`.ai/*`）→ 再派生 A（`README.md` / `docs/*`）
- 应当：同轮同步完；否则 `.ai/memory/handoff.md` 记 `A 版待同步`，下轮优先
- 严禁：A 先于 B
<!-- project-rules:end -->

<!-- principles:start -->
## 第一性原理

- 使用第一性原理思考：从原始需求与问题出发；保持审慎
- 不假设用户已完全明确目标与路径
- 动机 / 目标不清晰 → 停下与用户讨论

## 代码质量与设计哲学

- 克制与复用：只改必要部分；优先复用成熟代码
- 自然逻辑优先：边界情况融入主逻辑，不靠 if-else 补丁堆砌；拒绝过度设计
- 物理限制：单文件原则上 ≤1000 行，超出按功能拆分；自动生成 / vendored（如 `.ai/skill/vbm/`）豁免
- 极简维护：严禁保留废弃代码或引入无用混淆项
- 注释：业务复杂处 / 非直观边界 / 外部协议权限决策点 必须写简明中文注释；显而易见处不写

## 编码实践规范

- 可读性优先：命名表意；分段合理；避免过度抽象或单行堆叠逻辑
- 审慎拆分：除非 ≥2 处复用（含 API 导出），否则不拆细碎私有方法；同作用域内用分段 / 局部变量 / 注释表达
- 环境适配：已有项目严格遵循现有目录 / 风格 / 测试 / 提交规范；引入新依赖（库 / 测试框架 / 工具链）前，除非用户明确要求，否则先确认

## 测试与验证

- 交付标准：所有变更必须通过 lint / format / test；严禁带伤提交；严禁依赖后续修复补救当前疏忽
- 覆盖率：新增 / 变更功能必须同步补充单元或集成测试
- 尊重习惯：除非用户明确要求，否则不为项目引入新测试框架

## 方案规范（修改或重构方案必须符合）

- 不允许给出兼容性或补丁性方案
- 不允许过度设计；最短路径实现且不违反第一条
- 不允许超出用户需求自行扩展（如兜底 / 降级等），可能导致业务逻辑偏移
- 必须：逻辑正确；经过全链路逻辑验证
<!-- principles:end -->

<!-- communication:start -->
## 沟通与冲突处理

- 语言：沟通 / 文档 / 注释均用中文；专业英文术语首次出现附中文注释
- 优先级：用户明确要求 > 本 CLAUDE.md 规则 > 仓库规范文件（`.editorconfig` / `.gitignore` / `CONTRIBUTING.md` 等）> 外部标准协议
- 透明反馈：冲突任务执行前必须说明冲突原因，获许可后再执行
<!-- communication:end -->

<!-- task-flow:start -->
## 任务生命周期管理（/task 流程）

### 触发（狭义）

- 启用：仅当用户显式要求规划（"先计划后执行"、"先规划一下"、"plan 一下"、"走 /task 流程"，或直接提 `/task` / `task-flow`）
- 不启用：即使任务复杂，未显式要求 → 按常规流程

### 目录结构

```
/task/
├─ index.md                       # 所有任务 ID / 路径 / 状态，不记细节
└─ [YYYYMMDD]_[任务简称]_DOING/
   ├─ original_plan.txt           # 冻结原始方案（不改）
   ├─ task_track.csv              # 子项拆解
   └─ work_mode_plan.md           # AI 执行手册
```

- 后缀：进行中 `_DOING` / 已完成 `_COMPLETED`
- CSV 字段：ID | 任务内容 | 进度(0-100%) | 状态(Todo / Doing / Done) | 验收标准 | 交付物路径

### 三阶段

1. 方案固化：生成 3 文件 + 贴 `_DOING` + `/task/index.md` 追加一行
2. 执行与追踪：启动时声明 "当前正基于 task_track.csv 进行开发"；每完成子项立即更新 CSV
3. 归档：全部验收通过 → 重命名 `_COMPLETED` → 更新 `/task/index.md`

### 与 handoff.md 协作

- `.ai/memory/handoff.md` "当前活跃任务" 字段 → 指向 `/task/<folder>_DOING/`
- 分工：CSV = 子项细粒度；handoff = 会话级焦点；不互相替代
- 归档时：清空或改指向下一任务

### Git 策略

- `_DOING` 期间 CSV 更新 → 不单独 commit（留工作区）
- 归档 `_COMPLETED` → 一次 commit；message：`task: [ID] <任务简称> complete`
- 进行中 task 文件夹：视为有效交付物，随代码入仓
<!-- task-flow:end -->
