# 核心前端与业务交互接口梳理 (NAI FAST POLLER)

基于当前系统架构与前端交互链路，我们将系统分解为三大类核心接口方案：**系统状态轮询 (Telemetry & Logs)**、**主业务流程控制 (Engine Control)** 与 **应用级配置管理 (Configuration & Archiving)**。

## 一、 系统业务控制接口 (Engine Control)
控制底层生成线程和任务调度的核心端点。

### 1.1 启动生成任务
*   **端点**: `POST /api/v1/task/start`
*   **用途**: 将当前参数（并发量、目标、退避策略）递交给后端，开启生图指令发送轮询。
*   **请求体 (JSON)**:
    *   `config`: 包含 `limit` (Burst Count), `batchSize` (Items/Batch), `target` (system/character), `slot` (替换位), `pool` (替换词池数组) 等配置。
    *   `preferences`: 包含 `loop` (是否无限循环), `nfsfStealth` 等。
*   **响应流**: `200 OK` (返回 assigned `taskId` 标识此次批量生图任务)

### 1.2 强制终止任务
*   **端点**: `POST /api/v1/task/stop`
*   **用途**: 向后端发送终止/打断信号，释放长连接资源。
*   **请求参数**: `taskId` (可选，若为空则中止当前用户的所有下达任务)
*   **响应**: `200 OK` (确认已停止)

## 二、 数据/遥测轮询接口 (Telemetry & Logs)
由前端周期性短轮询（或者使用 WebSocket / Server-Sent Events 流式连接）。

### 2.1 任务遥测与流式日志下发
*   **端点**: `GET /api/v1/task/status`
*   **用途**: 返回当前生图进度、状态机的相位信息以及增量日志流。
*   **Query参数**: 
    *   `lastLogId`: (String) 前端已持有的最新日志ID，用于后端计算差分并仅返回新日志。
*   **响应 (JSON)**:
    *   `phase`: `IDLE` | `GENERATING`  | `COOLDOWN`
    *   `counts`: `{ success, c403, c429, c503, dom, err }` 实时统计数据
    *   `logs`: `[{ id, time, type, message }]` 增量的系统日志数组

## 三、 持续与交互接口 (Configuration)
用于参数的持久化方案。

### 3.1 存档最新生成配置
*   **端点**: `POST /api/v1/config/save`
*   **用途**: 对应前端“存档配置 (Archive)”按钮，将当前用户的面板参数快照存入持久化数据库。
*   **请求体 (JSON)**: `{ polling: {...}, engine: {...}, overrides: {...} }`
*   **响应**: `200 OK`

### 3.2 载入初始配置
*   **端点**: `GET /api/v1/config`
*   **用途**: 页面首次 `mount` 阶段拉取用户的上次存档。

---

*OpenAPI 规范 (Swagger) 已同步部署至根目录及内置系统面板。*
