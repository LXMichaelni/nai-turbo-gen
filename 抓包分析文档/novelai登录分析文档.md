以下是基于所给网络日志、存储变化与上下文线索，对 **novelai.net** 本次用户操作的结构化协议分析报告。

---

# NovelAI 协议分析报告

## 1. 场景识别

### 主场景
本次会话的核心业务场景是：

1. **用户在 NovelAI Image 页面访问并初始化**
2. **通过账号密码 + reCAPTCHA 完成登录**
3. **获取用户订阅/权限数据**
4. **在图像生成功能中输入 prompt，并触发标签建议**
5. **发起 AI 图片生成请求**
6. **先尝试流式图片生成接口 `generate-image-stream`，因并发锁失败**
7. **切换/回退到非流式图片生成接口 `generate-image` 并连续生成多张图片**
8. **下载历史生成图片**
9. **期间伴随埋点、风控、性能监控、同意管理、广告追踪**

### 非主场景
还检测到以下辅助业务：

- **订阅/账户能力拉取**：确认用户为已订阅用户，tier=3，具备 imageGeneration / unlimitedImageGeneration 权限。
- **提示词宏/用户对象拉取**：`/user/objects/promptmacros`
- **客户端设置写回**：`/user/clientsettings`
- **匿名用量关联**：`text.novelai.net/usage/link`
- **Google 登录按钮初始化**：仅页面集成，不代表实际使用 Google 登录
- **支付相关 SDK 加载**：Chargebee 加载，但本次未实际进入支付流程

### 结论
**这是一次“已注册用户通过常规账号登录后，在 NovelAI 图像生成功能中进行多次 AI 图片生成与下载”的完整会话。**

---

## 2. 交互流程概述

按时间顺序梳理如下：

### 阶段 A：页面加载与基础初始化
1. 访问 `https://novelai.net/image`
2. 拉取版本热更新配置：
   - `GET /updateReload.json`
3. 初始化各类埋点/监控：
   - PostHog `ph-fwd.novelai.net`
   - Cloudflare RUM
   - Google Ads / GTM / Conversion
   - Plausible
   - Reddit pixel
   - Osano consent
4. 加载第三方组件：
   - Chargebee
   - Google Sign-In button
   - reCAPTCHA enterprise anchor

### 阶段 B：风控准备与登录前置
1. 加载 invisible reCAPTCHA：
   - `GET /recaptcha/enterprise/anchor`
   - 页面返回隐藏 `recaptcha-token`
2. 上报 `clr`：
   - `POST /recaptcha/enterprise/clr`
   - 用于 reCAPTCHA 校验/清理链路

### 阶段 C：账号登录
1. 预检：
   - `OPTIONS https://image.novelai.net/user/login`
2. 登录：
   - `POST https://image.novelai.net/user/login`
   - 请求体包含：
     - `key`: 登录凭据（应为前端已处理后的账号密码派生值/登录密钥）
     - `recaptcha`: reCAPTCHA token
3. 登录成功返回：
   - `201`
   - JSON：
     ```json
     {"accessToken":"<JWT>"}
     ```

### 阶段 D：登录后用户态初始化
登录拿到 Bearer Token 后，前端立即并行拉取多组用户数据：

1. `GET https://api.novelai.net/user/data`
   - 返回优先级、订阅、支付处理器信息、perks 等
2. `GET https://image.novelai.net/user/objects/promptmacros`
   - 返回用户 prompt 宏对象
3. `POST https://text.novelai.net/usage/link`
   - 将匿名用户 ID 与登录账号关联
4. 周期/重复获取：
   - `GET https://api.novelai.net/user/subscription`
   - `GET https://text.novelai.net/ai/trial-status`（日志中实际成功记录体现在 localStorage requestLog 中）

### 阶段 E：前端状态落地
登录后前端将认证态和生成参数写入本地存储：

- `localStorage.session` 写入：
  - `auth_token`
  - `encryption_key`
- 保存图像生成参数：
  - `imagegen-params-nai-diffusion-4-5-curated`
  - `imagegen-prompt`
  - `imagegen-character-prompts`
- 保存用户请求日志：
  - `requestLog_<userId>`

### 阶段 F：Prompt 编辑与提示建议
用户在图像生成页面输入提示词，触发 suggest-tags 预检：

- `OPTIONS /ai/generate-image/suggest-tags?model=nai-diffusion-4-5-curated&prompt=girl`
- `OPTIONS ... prompt=room`
- `OPTIONS ... prompt=misaka`

虽然这里只有 OPTIONS，没有看到后续 GET/POST 实际建议结果，但可确定前端具备“输入联想/标签建议”能力。

### 阶段 G：首次生成尝试（流式）
1. 预检：
   - `OPTIONS /ai/generate-image-stream`
2. 发起流式生成：
   - `POST /ai/generate-image-stream`
   - `multipart/form-data`
   - 内部 `request` 字段为 JSON
3. 请求关键字段：
   - `input`: 正向 prompt
   - `model`: `nai-diffusion-4-5-curated`
   - `action`: `generate`
   - `parameters`: 宽高、steps、sampler、scale、negative_prompt、characterPrompts 等
   - `stream: "msgpack"`
   - `recaptcha_token`
4. 返回：
   - `429 {"message":"Concurrent generation is locked"}`
5. 前端上报 Sentry 错误

### 阶段 H：再次流式尝试成功
1. 再次 `POST /ai/generate-image-stream`
2. 返回 `200`
3. 响应体不是 JSON，而是**二进制流/分块内容**，日志中可见：
   - `event_type`
   - `intermediate`
   - `step_ix`
   - `gen_id`
   - JPEG 片段
4. 说明该接口支持**服务端持续推送中间采样/进度/最终图像数据**

### 阶段 I：切换到非流式生成
随后客户端更新设置：

- `PUT https://api.novelai.net/user/clientsettings`
  ```json
  {
    "streamImageGeneration": false
  }
  ```

之后生成改走：

- `POST https://image.novelai.net/ai/generate-image`

该接口返回：
- `200`
- `PK...image_0.png...`
- 即 ZIP/打包二进制结果，里面包含 `image_0.png`

### 阶段 J：连续批量生成
用户之后重复多次调用 `POST /ai/generate-image`，每次参数基本一致，仅种子 `seed` 不同，表示用户在做连续重采样/多次出图。

中间一次再次触发：
- `429 Concurrent generation is locked`

但总体大多数请求成功返回 PNG 文件包。

### 阶段 K：下载历史
最后有埋点：
- `POST https://plausible.io/api/event`
  - event: `ImageGenHistoryDownload`
  - `{"images":"8"}`

说明用户进行了**历史生成图片下载**，下载数量为 8。

---

## 3. API 端点清单

以下只列关键业务 API。

## 3.1 认证与账户

### 1) 登录
- **方法**: `POST`
- **端点**: `https://image.novelai.net/user/login`
- **用途**: 用户登录，获取访问令牌
- **请求体**:
  ```json
  {
    "key": "<登录密钥>",
    "recaptcha": "<recaptcha token>"
  }
  ```
- **响应**:
  ```json
  {
    "accessToken": "<JWT>"
  }
  ```

### 2) 用户综合数据
- **方法**: `GET`
- **端点**: `https://api.novelai.net/user/data`
- **用途**: 获取用户优先级、订阅、权益、支付状态等

### 3) 用户订阅信息
- **方法**: `GET`
- **端点**: `https://api.novelai.net/user/subscription`
- **用途**: 获取订阅等级、是否激活、权益与续费信息

### 4) 用户礼品码
- **方法**: `GET`
- **端点**: `https://api.novelai.net/user/giftkeys`
- **用途**: 查询 gift key 列表

### 5) 用户客户端设置
- **方法**: `PUT`
- **端点**: `https://api.novelai.net/user/clientsettings`
- **用途**: 保存前端偏好设置
- **关键字段**:
  - `streamImageGeneration`
  - `imageTutorialSeen`
  - `uiLanguage`
  - `model`

---

## 3.2 图像生成相关

### 6) Prompt 宏对象
- **方法**: `GET`
- **端点**: `https://image.novelai.net/user/objects/promptmacros`
- **用途**: 获取用户保存的 prompt 宏

### 7) 图像标签建议
- **方法**: 推测主请求应为 `GET` 或 `POST`，本日志仅见 `OPTIONS`
- **端点**: `https://image.novelai.net/ai/generate-image/suggest-tags`
- **用途**: prompt/tag 自动补全
- **查询参数**:
  - `model`
  - `prompt`

### 8) 流式图像生成
- **方法**: `POST`
- **端点**: `https://image.novelai.net/ai/generate-image-stream`
- **用途**: 以流式方式返回中间采样和最终结果
- **Content-Type**: `multipart/form-data`
- **关键字段**:
  - `input`
  - `model`
  - `action`
  - `parameters.stream = "msgpack"`
  - `recaptcha_token`

### 9) 非流式图像生成
- **方法**: `POST`
- **端点**: `https://image.novelai.net/ai/generate-image`
- **用途**: 直接返回完整图片包
- **Content-Type**: `multipart/form-data`
- **响应**: ZIP/二进制，包含 `image_0.png`

---

## 3.3 文本/试用/匿名关联

### 10) 匿名用量关联
- **方法**: `POST`
- **端点**: `https://text.novelai.net/usage/link`
- **用途**: 将匿名用户 ID 与登录账号关联

### 11) 试用状态
- **方法**: `GET`（日志中成功记录见 localStorage requestLog）
- **端点**: `https://text.novelai.net/ai/trial-status`
- **用途**: 查询 trial/shared trial 状态

---

## 3.4 风控与验证

### 12) reCAPTCHA 锚点
- **方法**: `GET`
- **端点**: `https://www.google.com/recaptcha/enterprise/anchor`
- **用途**: 获取 enterprise reCAPTCHA token

### 13) reCAPTCHA clr
- **方法**: `POST`
- **端点**: `https://www.google.com/recaptcha/enterprise/clr`
- **用途**: token 校验/清理链路的一部分

---

## 4. 鉴权机制分析

## 4.1 认证方式
主要采用：

- **登录态获取**：用户名/密码派生 `key` + reCAPTCHA
- **会话访问**：JWT Bearer Token
- **传递方式**：`Authorization: Bearer <token>`

## 4.2 凭据获取流程
### 第一步：获取 reCAPTCHA token
通过 enterprise anchor 返回隐藏 token，随后 clr 上报。

### 第二步：提交登录请求
`POST /user/login`
- `key`: 不是明文密码，表现为高熵字符串，推断为前端派生或加密后的登录密钥
- `recaptcha`: reCAPTCHA token

### 第三步：服务端返回 accessToken
返回 JWT：

```json
{"accessToken":"eyJhbGciOiJIUzI1NiIs..."}
```

JWT payload 可见字段：
- `exp`
- `iat`
- `id`
- `nc`

## 4.3 凭据传递方式
后续 API 均使用：
```http
Authorization: Bearer <JWT>
```

涉及：
- `/user/data`
- `/user/subscription`
- `/user/giftkeys`
- `/user/clientsettings`
- `/user/objects/promptmacros`
- `/usage/link`
- `/ai/generate-image`
- `/ai/generate-image-stream`

## 4.4 本地存储凭据
`localStorage.session` 中保存：
```json
{
  "auth_token":"<JWT>",
  "encryption_key":"<high entropy key>"
}
```

这说明前端会话并不依赖 HttpOnly Cookie，而是**前端持有 token 并自行附带 Authorization 头**。

## 4.5 鉴权特征总结
- **非 Cookie Session 主导**
- **Bearer Token 主导**
- **登录受 reCAPTCHA 保护**
- **图片生成也携带独立 `recaptcha_token` 字段**
- **图像生成存在服务端并发锁**

---

## 5. 流式通信分析

用户给出的“流式通信”栏目写明无独立流式记录，但从实际 HTTP 内容看，**存在基于普通 HTTP POST 的流式/分块响应**。

## 5.1 协议类型
不是 WebSocket，也未明确为 SSE 标准文本流。更像是：

- **HTTP 分块响应**
- 响应体承载**msgpack/二进制混合事件流**
- 用于图像生成中间步骤推送

## 5.2 端点
- `POST https://image.novelai.net/ai/generate-image-stream`

## 5.3 请求格式
- `multipart/form-data`
- part 名为 `request`
- 内容为 JSON blob

关键字段：
```json
{
  "input": "...",
  "model": "nai-diffusion-4-5-curated",
  "action": "generate",
  "parameters": {
    "stream": "msgpack",
    ...
  },
  "recaptcha_token": "..."
}
```

## 5.4 响应格式
日志中响应体包含：
- `event_type`
- `intermediate`
- `samp_ix`
- `step_ix`
- `gen_id`
- `sigma`
- 二进制 JPEG 数据片段

这表明响应内容不是一次性 JSON，而是**逐步返回中间图像采样数据和状态信息**。

## 5.5 异常情况
- 返回 `429 Concurrent generation is locked`
- 表示服务端对同一用户/会话存在并发生成限制

---

## 6. 存储使用分析

## 6.1 Cookie

### 已知关键 Cookie
- `osano_consentmanager_uuid`
- `osano_consentmanager`
  - 同意管理
- `_gcl_au`
  - Google Ads
- `g_state`
  - Google Sign-In 状态
- `_rdt_uuid`
  - Reddit tracking

### 特征
本次**主认证态并未放入 Cookie**，Cookie 多为：
- 同意管理
- 广告追踪
- 第三方登录辅助
- 分析/归因

---

## 6.2 localStorage

### 关键项 1：认证会话
```json
session = {
  "auth_token": "<JWT>",
  "encryption_key": "<key>"
}
```
用途：
- 保存登录态
- 供后续 API 使用
- `encryption_key` 可能用于本地数据加密/对象加解密

### 关键项 2：图像生成参数
- `imagegen-params-nai-diffusion-4-5-curated`
- `imagegen-prompt`
- `imagegen-character-prompts`

说明前端会将最近一次生成参数持久化，便于刷新恢复。

### 关键项 3：请求日志
- `requestLog_gcDmc-UUvJENuj-ps_6e1`
- 记录 correlationId、URL、method、status、httpStatus、开始/结束时间

说明前端具备**客户端请求审计/诊断日志**。

### 关键项 4：匿名/试用关联
- `auid=anon-...`
- `localTrialState2`
- 用于试用或匿名 usage 关联

### 关键项 5：埋点状态
- `ph_phc_*_posthog`
  - 包含：
    - `distinct_id`
    - `$user_id`
    - `tier`
    - `subscriptionActive`
    - `emailVerified`
    - `language`

说明登录成功后，埋点 SDK 识别到用户并写入用户属性。

---

## 6.3 sessionStorage

关键项：
- `signUpModalShown=true`
- `paymentDueModalDisabled=true`
- PostHog 当前窗口标记
- 一个可疑随机键值项

用途主要是：
- 当前标签页会话级 UI 状态
- 埋点窗口协同

---

## 7. 关键依赖关系

## 7.1 登录依赖链
```text
reCAPTCHA anchor -> recaptcha token -> POST /user/login -> accessToken
```

没有 reCAPTCHA token，登录请求大概率无法通过。

## 7.2 用户态初始化依赖链
```text
POST /user/login 成功
  -> 保存 auth_token 到 localStorage.session
  -> Authorization: Bearer <token>
  -> GET /user/data
  -> GET /user/subscription
  -> GET /user/objects/promptmacros
  -> POST /usage/link
```

## 7.3 图片生成依赖链
```text
登录成功 + 拥有订阅权限 + reCAPTCHA token
  -> 组装生成参数
  -> POST /ai/generate-image-stream 或 /ai/generate-image
```

依赖条件包括：
- Bearer token
- 生成模型参数
- reCAPTCHA token
- 用户有 imageGeneration 权限

## 7.4 流式与非流式切换关系
```text
先尝试 /ai/generate-image-stream
  -> 429 并发锁 or 流式异常
  -> 修改 clientsettings: streamImageGeneration=false
  -> 回退到 /ai/generate-image
```

## 7.5 并发锁依赖
同一时间若已有生成任务未完成，再次请求：
- 返回 `429 Concurrent generation is locked`

说明服务端存在用户维度的互斥锁/单任务并发控制。

## 7.6 下载行为依赖
图片下载并未直接看到下载 API，但埋点显示：
- `ImageGenHistoryDownload`
- `images=8`

说明下载动作依赖于前面已生成出的历史图片集合。

---

## 8. 复现建议

以下为协议级复现的伪逻辑，不包含真实绕过风控实现。

## 8.1 总体伪流程

```python
# 1. 获取 reCAPTCHA token（浏览器环境中完成）
recaptcha_token = get_recaptcha_enterprise_token(site_key, page_url)

# 2. 构造登录请求
login_body = {
    "key": login_key,          # 前端派生后的登录密钥，不是明文密码
    "recaptcha": recaptcha_token
}

resp = POST("https://image.novelai.net/user/login", json=login_body)
access_token = resp["accessToken"]

# 3. 保存会话
local_storage["session"] = {
    "auth_token": access_token,
    "encryption_key": generated_or_server_known_key
}

headers = {
    "Authorization": f"Bearer {access_token}"
}

# 4. 拉取用户数据
GET("https://api.novelai.net/user/data", headers=headers)
GET("https://api.novelai.net/user/subscription", headers=headers)
GET("https://image.novelai.net/user/objects/promptmacros", headers=headers)

# 5. 关联匿名用量
POST("https://text.novelai.net/usage/link",
     headers=headers,
     json={"anonymous_user_id": anon_id})

# 6. 保存图像参数
params = {
    "params_version": 3,
    "width": 832,
    "height": 1216,
    "scale": 5.6,
    "sampler": "k_euler_ancestral",
    "steps": 28,
    "n_samples": 1,
    "qualityToggle": True,
    "noise_schedule": "karras",
    "characterPrompts": [
        {
            "prompt": "misaka",
            "uc": "",
            "center": {"x": 0.5, "y": 0.5},
            "enabled": True
        }
    ],
    "negative_prompt": "...",
    "image_format": "png"
}

# 7. 获取/刷新生成用 recaptcha token
gen_recaptcha_token = get_recaptcha_enterprise_token(site_key, page_url)

# 8A. 尝试流式生成
request_json = {
    "input": "girl, room, very aesthetic, masterpiece, no text, -0.8::feet::, rating:general",
    "model": "nai-diffusion-4-5-curated",
    "action": "generate",
    "parameters": {
        **params,
        "seed": random_seed(),
        "stream": "msgpack"
    },
    "use_new_shared_trial": True,
    "recaptcha_token": gen_recaptcha_token
}

resp = multipart_post("https://image.novelai.net/ai/generate-image-stream",
                      headers=headers,
                      file_part_name="request",
                      json_blob=request_json)

if resp.status == 429:
    # 并发锁，等待或回退
    wait_until_generation_done()

# 8B. 或直接用非流式接口
request_json = {
    "input": "...",
    "model": "nai-diffusion-4-5-curated",
    "action": "generate",
    "parameters": {
        **params,
        "seed": random_seed()
    },
    "use_new_shared_trial": True,
    "recaptcha_token": gen_recaptcha_token
}

zip_bin = multipart_post("https://image.novelai.net/ai/generate-image",
                         headers=headers,
                         file_part_name="request",
                         json_blob=request_json)

# 9. 解压得到 image_0.png
extract(zip_bin)

# 10. 如需切换前端设置
PUT("https://api.novelai.net/user/clientsettings",
    headers=headers,
    json={
        "settingsVersion": 16,
        "streamImageGeneration": False,
        ...
    })
```

---

## 8.2 multipart 请求结构示意

### `POST /ai/generate-image`
```http
Content-Type: multipart/form-data; boundary=...

--boundary
Content-Disposition: form-data; name="request"; filename="blob"
Content-Type: application/json

{
  "input": "...",
  "model": "nai-diffusion-4-5-curated",
  "action": "generate",
  "parameters": {...},
  "use_new_shared_trial": true,
  "recaptcha_token": "..."
}
--boundary--
```

---

## 8.3 复现关键点
1. **必须有有效 JWT**
2. **必须有有效 reCAPTCHA token**
3. **登录时 `key` 不是明文密码**
4. **生成接口使用 multipart，而不是纯 JSON**
5. **流式接口可能返回二进制事件流**
6. **并发请求容易触发 429**
7. **成功响应通常是 ZIP 包，不是 JSON**

---

## 9. 关键字段画像

## 9.1 登录字段
- `key`: 高熵认证凭据，推测为前端派生
- `recaptcha`: 登录验证码 token

## 9.2 生成字段
- `input`: 主 prompt
- `model`: `nai-diffusion-4-5-curated`
- `action`: `generate`
- `parameters.width/height`
- `scale`
- `sampler`
- `steps`
- `seed`
- `characterPrompts`
- `negative_prompt`
- `image_format`
- `stream`
- `recaptcha_token`

## 9.3 订阅字段
- `tier: 3`
- `active: true`
- `imageGeneration: true`
- `unlimitedImageGeneration: true`

这些字段直接解释了用户为何可持续触发多次图片生成。

---

## 10. 风险与实现特征总结

## 10.1 产品实现特征
- 前后端分域：
  - `novelai.net` 前端站点
  - `image.novelai.net` 图像服务
  - `api.novelai.net` 账户/订阅服务
  - `text.novelai.net` 文本/试用/usage 服务
- JWT 无状态鉴权
- 前端本地存储会话
- 图像生成需要额外风控 token
- 支持流式与非流式双路径生成

## 10.2 协议重点
- **登录与生成均受 reCAPTCHA 保护**
- **AI 图片生成接口是真正核心业务接口**
- **并发锁是服务端重要限流/互斥机制**
- **前端保留详细 requestLog 便于审计**
- **clientsettings 可控制是否启用流式生成**

---

# 最终结论

本次会话可明确识别为：

> **用户在 NovelAI 图像页面使用常规账号登录，通过 reCAPTCHA 完成身份验证，拿到 JWT 后拉取账户与订阅信息，编辑 prompt，并多次调用 `image.novelai.net` 的 AI 图片生成接口进行图片生成；期间先尝试流式生成，因并发锁部分失败，后切换/回退为非流式生成，最终连续出图并下载历史图片。**

如果你需要，我还可以继续输出一版更适合工程落地的：

1. **Mermaid 时序图版**
2. **OpenAPI 风格接口表**
3. **Python/Node.js 复现脚本骨架**
4. **鉴权链与状态机图**