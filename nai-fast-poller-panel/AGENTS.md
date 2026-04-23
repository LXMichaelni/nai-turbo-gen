# AI 代理系统指令与项目上下文 (Agent Instructions)

你现在正在协助开发和维护 "NAI FAST POLLER" 控制面板项目。在进行二次开发、后端对接、或者功能扩写时，请**务必**严格遵循以下规范和现有的接口说明。

## 🤖 供 AI 加载的核心路由与资源
你在接手新任务时，你应该首先读取以下文件：

1. **统一 API 规范档 (OpenAPI 3.0)**: `/public/openapi.yaml`
   - 这是机器可读（Machine-readable）的绝对真理（Source of Truth）。
   - 所有的 `path`, `requestBody`, 和 `responses` 结构都以此表为准。当增加新的交互接口时，你必须同步更新该 YAML 文件。
2. **人类可读说明文档**: `/API_DOCS.md`
   - 介绍了整体接口设计哲学和三层架构（控制引擎、遥测轮询、持久化配置）。
3. **前端状态容器与集成**: `/src/App.tsx`
   - 目前的前端状态（如 `logs`, `counts`, `isRunning` 等）都是本地态。当进行真实的后端对接二次开发时，应使用 Axios 或 Fetch 去请求上述定义的端点，以真实数据替换目前的静态 Mock 轮询。

## ⚡ 接口暴露方式
- HTTP 静态暴露: 外部爬虫或外部 AI Agent 访问托管地址下 `/openapi.yaml` 或 `/llms.txt` 即可直接拉取 API 的原始形态，无需解析复杂的 DOM 结构。
- 内部视图暴露: 前端已完整挂载 SwaggerUI。

## ⚠️ 样式与交互防劣化规约
- 当前界面采用复古工业硬核大屏风 (High-density Bento Grid) 结构。
- 白天模式 (`.theme-light`) 经过了精密的色阶映射降级，切勿直接使用简单的全屏 `invert` 翻转。
- 任何新增的布局都不能破坏整体的响应式安全界限（严禁出现横向滚动条，保证 `break-all` 和 `overflow-y-auto` 的运用）。
