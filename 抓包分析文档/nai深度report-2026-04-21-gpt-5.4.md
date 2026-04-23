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

---

## Follow-up Chat

**User**:

登录过程中有出现reCAPTCHA 验证吗，我怎么感觉是无感就登录进去了，并没有出现要手动验证的情况？

**AI**:

有，**协议层面明确出现了 reCAPTCHA**，但它看起来属于 **“无感/隐式”验证**，所以你主观上会觉得“没有弹验证码也登录了”。

## 结论先说
这次登录流程里，确实存在 Google **reCAPTCHA Enterprise**：

- 页面加载了：
  - `GET /recaptcha/enterprise/anchor`
  - `POST /recaptcha/enterprise/clr`
- 随后登录请求 `POST https://image.novelai.net/user/login` 的请求体中包含：
  - `recaptcha: "<token>"`

这说明 **登录接口不是裸登录**，而是带着 reCAPTCHA token 提交的。

## 为什么你感觉不到？
因为这类实现通常不是“点选红绿灯/图片”的交互式验证码，而是：

- **Invisible reCAPTCHA / Enterprise 风控模式**
- 前端静默向 Google 申请一个风险评估 token
- 服务端校验这个 token
- 风险低时直接放行
- 风险高时才可能升级为显式挑战

所以在正常设备、正常网络、正常行为轨迹下，用户体验上就是：

> 点登录 → 直接成功  
> 但底层其实已经做过一轮验证码风控校验

## 从这次抓包能确认什么？
能确认三点：

### 1）页面确实接入了 reCAPTCHA Enterprise
抓包摘要里已经有：
- `GET /recaptcha/enterprise/anchor`
- `POST /recaptcha/enterprise/clr`

这不是普通业务请求，而是 Google reCAPTCHA Enterprise 相关链路。

### 2）登录请求明确携带了 reCAPTCHA token
前面的分析里已经识别到登录体结构类似：

```json
{
  "key": "<登录密钥>",
  "recaptcha": "<recaptcha token>"
}
```

这基本可以直接证明：
**登录接口要求/接受 reCAPTCHA 校验结果。**

### 3）图片生成时也用了 reCAPTCHA
不仅登录，连图片生成请求里也有：

- `recaptcha_token`

说明 NovelAI 对高价值操作不只是登录校验，还把风控扩展到了生成接口。

## 这是否意味着“必须人工验证”？
**不一定。**

reCAPTCHA 的“验证”分两类理解：

### A. 协议意义上的验证
有 token、服务端校验 token、决定是否允许请求。  
**这次肯定有。**

### B. 用户可见的人工交互验证
比如弹出“我不是机器人”复选框或图片题。  
**这次看起来没有发生。**

也就是说：

> 有验证码风控机制 ≠ 一定会出现人工操作界面

## 更准确地描述这次登录
更准确的说法应该是：

> 登录过程中使用了 reCAPTCHA Enterprise 的无感校验，但没有触发用户可见的手动挑战。

## 为什么系统会这么设计？
这是现在很常见的登录风控方案：

- 默认无感评估，减少打扰
- 结合浏览器环境、IP、历史行为、设备指纹、请求上下文打分
- 风险低：直接发 token，用户无感
- 风险高：再升级挑战或拒绝

所以你“感觉没验证”，其实是因为：
**验证发生在后台，而不是在 UI 上。**

如果你愿意，我下一步可以进一步帮你做两件事之一：

1. **把登录请求和 reCAPTCHA 请求的对应关系再细化成时序图**
2. **如果你指定登录请求的序号，我可以直接去看完整请求详情，确认 `recaptcha` 字段是否就在该次登录包体里**

**User**:

分析下网页上有没有遥测，比如说生图速率过快会触发限流，风控等的

**AI**:

有，而且从这次抓包看，**NovelAI 前端同时存在“业务限流/并发控制”和“遥测/风控采集”两套东西**。  
但要先区分：

- **A. 真正阻止你生图的控制**：服务端并发锁、接口限流、reCAPTCHA 校验
- **B. 用来观测/评估的遥测**：埋点、性能监控、错误上报、匿名/账号关联、请求日志

你的问题是“网页上有没有遥测，比如生图速率过快会触发限流、风控等”，答案是：

> **有明显遥测，而且高概率会为风控/限流提供辅助信号；同时，抓包里已经直接看到服务端对生图并发做了硬限制。**

---

# 1. 已明确看到的“会影响生图”的控制

## 1.1 并发锁：已经真实触发
抓包里直接出现过：

- `POST /ai/generate-image-stream` → `429`
- 返回：
  ```json
  {"message":"Concurrent generation is locked"}
  ```

以及后续普通生成接口中也出现过类似 `429`。

这说明至少存在一种明确的服务端控制：

- **同一账号/会话/用户上下文下，不允许并发发起多个生成任务**
- 如果前一个任务还没释放锁，新的请求会被拒绝

这不是“遥测推测”，这是**已发生的硬限制**。

### 这更像什么？
更像：
- **单用户生成互斥锁**
- 或 **短时间内同类任务排他执行**
- 不一定是传统意义上的 QPS 限流，但效果上会限制“生图过快/重叠提交”

---

## 1.2 生成接口本身带 reCAPTCHA token
图像生成请求中带有：

- `recaptcha_token`

这点很关键。说明风控并不只在登录时使用，而是**生成行为本身也受风控校验**。

这意味着服务端理论上可以结合：

- 当前生成请求
- reCAPTCHA 风险评分
- 账号订阅等级
- 请求频率
- 行为模式
- 设备/浏览器环境

来决定：
- 正常放行
- 增加挑战
- 临时拒绝
- 返回限流/锁定类错误

所以如果“生图速率过快”，除了并发锁外，**也完全可能进入风控评分模型**。

---

# 2. 已观察到的遥测/监控组件

以下这些不是直接“限流器”，但它们是典型的遥测基础设施。

## 2.1 PostHog
抓包里有：
- `ph-fwd.novelai.net`

并且 localStorage 里有：
- `ph_phc_*_posthog`

记录了类似：
- `distinct_id`
- `$user_id`
- `tier`
- `subscriptionActive`
- `emailVerified`
- `language`

这说明前端启用了 **PostHog 用户行为分析**。

### 这类系统通常能记录什么？
通常包括：
- 页面访问
- 按钮点击
- 功能使用路径
- 用户属性
- 转化漏斗
- 实验分桶
- 某些关键业务事件

### 跟生图速率的关系
PostHog 本身更偏**产品分析**，不是主限流器。  
但它可以记录：
- 用户点击“生成”次数
- 使用哪个模型
- 是否报错
- 是否切到 stream/non-stream
- 是否下载历史图

这些数据可用于：
- 离线风控分析
- 滥用行为识别
- 产品策略调整

---

## 2.2 Plausible
抓包中有：
- `https://plausible.io/api/event`

而且已经看到具体事件：
- `ImageGenHistoryDownload`
- `{"images":"8"}`

说明前端会发送**业务事件埋点**。

### 意义
这表明：
- 页面上的关键操作会被上报
- “下载历史图片”被明确当作一个业务事件跟踪
- “点击生成”这类事件很可能也存在，只是摘要没全列出来

---

## 2.3 Sentry 错误上报
前面分析中提到，在 `generate-image-stream` 返回 429 后：
- 前端有 **Sentry 错误上报**

这说明页面具备：
- 错误捕获
- 异常上报
- 请求失败链路监控

### 跟风控的关系
Sentry 不直接做风控，但它帮助平台观察：
- 哪类用户频繁触发 429
- 哪种前端路径导致失败
- 是否有异常脚本/自动化行为

---

## 2.4 Cloudflare RUM / Web 性能监控
抓包摘要提到：
- Cloudflare RUM

这类遥测一般收集：
- 页面性能
- 资源加载
- 前端错误
- 页面交互延迟
- 网络质量

它通常不是生图风控核心，但可以作为设备/网络质量背景信号。

---

## 2.5 Google Ads / GTM / Reddit / Osano
这些更多是：
- 归因
- 广告追踪
- 同意管理

与生图风控的直接关系较弱，但说明整站确实有比较完整的前端观测体系。

---

# 3. 前端本地还有“请求日志”

这是一个非常重要的点。

抓包/存储分析里出现了：

- `localStorage.requestLog_<userId>`

里面保存的内容包括：
- `correlationId`
- `url`
- `method`
- `status`
- `httpStatus`
- 开始/结束时间

## 3.1 这说明什么？
说明前端自己维护了一份**请求级审计日志/诊断日志**。

这类日志通常用于：
- 页面内展示最近请求状态
- 故障排查
- 复现错误
- 上报失败上下文

## 3.2 跟“生图过快”有什么关系？
如果用户快速重复点击生成，前端至少可以观测到：

- 上一次生成是否未完成
- 短时间内发起了多少次请求
- 哪些请求被 429
- 哪些请求成功

这意味着前端**完全有能力**做本地节流，比如：
- 按钮置灰
- 队列化
- 防止重复提交

虽然从抓包里不能百分百证明它做了完整本地节流逻辑，但**它具备实现这种策略所需的数据基础**。

---

# 4. “生图速率过快会触发限流/风控”这件事，当前能确认到什么程度？

我给你分成“确定”、“高概率”、“暂不能证实”三层。

## 4.1 确定的
### 确定 1：存在服务端并发限制
已经看到：
- `429 Concurrent generation is locked`

所以如果你**连续过快点击，造成请求重叠**，会触发限制。

### 确定 2：生成请求受 reCAPTCHA 风控链保护
生成接口里有：
- `recaptcha_token`

说明生成行为会经过某种风险评估。

### 确定 3：前端存在行为遥测与请求级日志
- PostHog
- Plausible
- Sentry
- localStorage requestLog

---

## 4.2 高概率成立的
### 高概率 1：前端或服务端会统计生成频率
虽然摘要里没直接看到“rate_limit_remaining”这类响应头，但结合产品类型，几乎可以合理推断：
- 服务端会按账号/时间窗统计生成请求
- 至少会监控失败率、并发占用、短时重复请求

### 高概率 2：风控会结合行为模式而不是只看单次请求
因为生成接口不只是 Bearer Token，还要额外带：
- `recaptcha_token`

这通常意味着服务端不仅认证“你是谁”，还评估“这次行为像不像自动化/异常操作”。

### 高概率 3：订阅等级影响策略
用户数据里有：
- `tier: 3`
- `imageGeneration: true`
- `unlimitedImageGeneration: true`

这说明风控/限流策略大概率不是“一刀切”，而会结合：
- 订阅等级
- 是否有无限生图权益
- 当前额度状态

“unlimited”通常不等于“无限并发”，更多是额度维度放宽，不代表不会被并发锁或风控约束。

---

## 4.3 暂不能从当前摘要直接证实的
### 不能直接证实 1：存在精确的“每分钟最多几张”硬编码限速
当前摘要没有直接给出：
- `X-RateLimit-*` 响应头
- 明确的 quota API
- “too many requests per minute” 类返回

所以不能武断说它一定按固定 QPS 限制。

### 不能直接证实 2：前端采集了鼠标轨迹/键盘节奏等高级行为指纹
当前只看到 reCAPTCHA Enterprise 和常规埋点，  
但没直接看到某种专门的 bot-behavior SDK 明确采集：
- 鼠标轨迹
- 键盘动力学
- canvas 指纹上报包体

不过 reCAPTCHA/浏览器环境自身可能已经隐式利用了部分环境信号。

---

# 5. 从架构上看，哪些信号最可能参与“生图风控”？

如果站在协议分析角度，我认为最可能参与的是这几类：

## 5.1 账号态信号
来自：
- `Authorization: Bearer <JWT>`
- `/user/data`
- `/user/subscription`

可反映：
- 用户 ID
- tier
- 是否激活订阅
- 是否有 imageGeneration 权限
- 是否 unlimitedImageGeneration

---

## 5.2 请求频率/并发信号
来自服务端直接可见的：
- 同一 token 在单位时间内调用多少次 `/ai/generate-image`
- 当前是否已有未完成生成
- 最近失败/成功比例
- 是否短时间频繁改 seed 重复打接口

---

## 5.3 风控 token 信号
来自：
- `recaptcha_token`

服务端可用来判断：
- 本次请求风险分
- token 是否有效
- token 是否对应当前页面/动作
- 是否需要拦截或加严

---

## 5.4 前端事件遥测信号
来自：
- PostHog
- Plausible
- requestLog
- Sentry

这些更可能用于：
- 事后分析
- 策略优化
- 异常用户画像
- 发现自动化脚本模式

而不是每次都同步决定是否放行。

---

# 6. “遥测”和“限流”在这站点里更像怎么分工？

我倾向于这样理解：

## 第一层：前端遥测
负责“看见”用户在做什么：
- 页面打开
- 登录
- 点击生成
- 下载历史
- 请求成功/失败
- UI 设置变化（比如切换 streamImageGeneration）

## 第二层：服务端业务约束
负责“直接卡住”异常使用：
- 并发锁
- 订阅权限校验
- trial / usage 关联
- 请求合法性检查

## 第三层：风控系统
负责“判断这个请求像不像滥用”：
- reCAPTCHA Enterprise
- 账号行为模式
- 可能结合匿名 ID、登录态、设备环境

---

# 7. 对“生图太快会不会出事”的实际判断

基于这次数据，比较稳妥的判断是：

## 会触发的
### 1）重叠提交会触发并发锁
这是已经实锤的。

### 2）异常频繁请求有较大概率提高风控风险
因为生成接口带 `recaptcha_token`，说明请求不是纯业务接口，而是受风控覆盖。

### 3）平台有足够的遥测能力识别高频/异常行为
前端和服务端两边都具备观察条件。

---

# 8. 但不要把所有 429 都理解成“你被风控了”
这里要特别区分：

这次最明确的 429 文案是：
```json
{"message":"Concurrent generation is locked"}
```

它更像：
- **同一时刻已有生成任务**
- **锁未释放**
- **你又发了一个**

这更偏**资源互斥/任务排队失败**，不一定代表账号被风控惩罚。

也就是说：
- **快** → 可能先撞上并发锁
- **又快又异常** → 才更可能进一步进入风控判定

---

# 9. 总结

一句话总结：

> **网页上有明显遥测，且生图接口本身也受风控保护；从已捕获数据看，最明确的限制是服务端“并发生成锁”，而不是已明确曝光的固定频率限流。**

更细一点说：

- **有遥测**：
  - PostHog
  - Plausible
  - Sentry
  - Cloudflare RUM
  - 前端 localStorage requestLog
- **有风控**：
  - 登录 reCAPTCHA Enterprise
  - 生图请求也带 `recaptcha_token`
- **有限制**：
  - 已实锤 `429 Concurrent generation is locked`
- **高概率存在行为评估**：
  - 高频、重叠、自动化模式可能提高风控风险
- **但当前摘要还不能直接证明**：
  - 存在明确“每分钟 N 张”的公开硬限额

如果你愿意，我下一步可以继续帮你做两种更深入的分析：

1. **我帮你从 290 个请求里进一步定位“生图相关请求序号”，逐个检查响应头/响应体，看看有没有更隐蔽的 rate-limit 字段或风控返回**
2. **我帮你整理一份“NovelAI 前端遥测/风控信号矩阵”，把每种信号按“同步拦截 / 异步分析 / 产品埋点”分类**

**User**:

列出我使用浏览器做的所有操作的流程，以及交互到的所有组件和它的类型名字，按顺序来

**AI**:

下面按**时间顺序**，把你这次在浏览器里的可观察操作流程，以及每一步交互到的组件、类型、作用列出来。  
由于当前你给的是**抓包摘要**而不是每一条请求详情全文，所以我会基于已经确认的请求、存储变化和前面分析结果来还原；其中极少数“页面内部点击动作”属于**高置信推断**，我会标注。

---

# 一、按顺序的用户操作流程

---

## 0. 打开 NovelAI 图像页面
### 你的操作
- 在浏览器中进入 `https://novelai.net/image`

### 交互到的组件
1. **NovelAI Web 前端**
   - 类型：**主站 Web SPA / Next.js 前端应用**
   - 名字：`novelai.net`
   - 作用：页面渲染、登录、图像生成 UI、调用后端 API

2. **Next.js 静态资源系统**
   - 类型：**前端静态资源/CDN 资源**
   - 名字：`/_next/static/...`
   - 作用：加载页面 JS chunk、SVG、构建清单

3. **热更新版本检测**
   - 类型：**前端版本管理/热更新探测**
   - 名字：`/updateReload.json`
   - 作用：判断前端是否需要刷新或更新

### 证据
- 大量 `/_next/static/chunks/...js`
- `GET /updateReload.json`

---

## 1. 页面初始化，加载埋点、监控、同意管理、第三方 SDK
### 你的操作
- 这一步通常是“打开页面后自动发生”，不需要你手动点击

### 交互到的组件
1. **PostHog**
   - 类型：**产品行为埋点/用户分析**
   - 名字：`ph-fwd.novelai.net`
   - 作用：记录页面访问、用户行为、用户属性

2. **Plausible**
   - 类型：**轻量统计分析**
   - 名字：`plausible.io`
   - 作用：记录站点事件，如下载历史图片等

3. **Cloudflare RUM**
   - 类型：**前端性能监控 / Real User Monitoring**
   - 名字：Cloudflare RUM
   - 作用：采集页面性能、网络、用户真实访问体验

4. **Sentry**
   - 类型：**错误监控 / 异常上报**
   - 名字：Sentry（从错误上报行为推断）
   - 作用：记录接口错误、前端异常

5. **Osano Consent Manager**
   - 类型：**Cookie 同意管理**
   - 名字：Osano
   - 作用：管理隐私同意弹窗和 consent cookie

6. **Google Ads / Google Tag Manager**
   - 类型：**广告归因 / 标签管理**
   - 名字：Google Ads / GTM
   - 作用：营销归因、事件追踪

7. **Reddit Pixel**
   - 类型：**广告追踪**
   - 名字：Reddit tracking
   - 作用：广告转化/归因统计

8. **Plausible Vendor JS**
   - 类型：**统计脚本资源**
   - 名字：`/js/706c61757369626c65.vendor.js`
   - 作用：统计功能脚本

9. **Chargebee**
   - 类型：**订阅/支付 SDK**
   - 名字：Chargebee
   - 作用：支付、订阅页面能力加载（本次未实际付款）

10. **Google Sign-In Button**
    - 类型：**第三方登录 UI SDK**
    - 名字：Google Sign-In
    - 作用：渲染 Google 登录按钮（本次未实际使用）

### 你的可感知行为
- 页面刚打开自动加载
- 你可能看到页面 UI、登录入口、各种图标资源加载完成

---

## 2. 页面加载图像功能界面资源
### 你的操作
- 仍然属于页面加载过程

### 交互到的组件
1. **图像页面模块**
   - 类型：**前端业务模块**
   - 名字：`pages/image-*.js`
   - 作用：图像生成页面逻辑

2. **UI 图标与素材**
   - 类型：**静态媒体资源**
   - 名字示例：
     - `quick_start_gallery.svg`
     - `logout.svg`
     - `help.svg`
     - `text.svg`
     - `book-open.svg`
     - `dice.svg`
   - 作用：页面图标、功能按钮、帮助入口等

### 你可推断的页面状态
- 图像生成器界面已准备好
- 登录前或登录后 UI 已可交互

---

## 3. 浏览器静默执行 reCAPTCHA 初始化
### 你的操作
- 你没有手动做题；这是页面自动完成的

### 交互到的组件
1. **Google reCAPTCHA Enterprise Anchor**
   - 类型：**风控/验证码初始化**
   - 名字：`/recaptcha/enterprise/anchor`
   - 作用：生成 reCAPTCHA token，供登录或关键操作使用

2. **Google reCAPTCHA Enterprise CLR**
   - 类型：**风控校验链路**
   - 名字：`/recaptcha/enterprise/clr`
   - 作用：配合 token 校验流程

### 这一步说明什么
- 页面确实启用了 **无感验证码/风控**
- 但没有触发人工点击挑战，所以你体感是“无感登录”

---

## 4. 你执行“登录”
### 你的操作
- 输入账号信息并点击登录
- 或浏览器自动填充后你确认提交

### 交互到的组件
1. **登录表单组件**
   - 类型：**前端认证 UI**
   - 名字：NovelAI 登录表单
   - 作用：收集登录凭据

2. **NovelAI 图像后端登录接口**
   - 类型：**认证 API**
   - 名字：`POST https://image.novelai.net/user/login`
   - 作用：校验登录凭据并签发 token

3. **reCAPTCHA Enterprise Token**
   - 类型：**风控凭据**
   - 名字：`recaptcha`
   - 作用：作为登录请求字段一起提交

### 请求层关键点
登录体中包含：
- `key`
- `recaptcha`

### 返回结果
- 成功拿到 `accessToken`

---

## 5. 浏览器保存登录态
### 你的操作
- 这是登录成功后的自动处理

### 交互到的组件
1. **localStorage.session**
   - 类型：**浏览器本地存储**
   - 名字：`session`
   - 作用：保存登录态与加密相关数据

2. **JWT Access Token**
   - 类型：**认证令牌**
   - 名字：`auth_token`
   - 作用：后续调用 API 的 Bearer Token

3. **Encryption Key**
   - 类型：**本地密钥/前端会话辅助数据**
   - 名字：`encryption_key`
   - 作用：可能用于本地对象或用户数据加解密

### 表现
- 你登录后刷新页面通常仍保持登录
- 因为不是靠 Cookie 主导，而是本地 token

---

## 6. 登录后页面自动拉取账户与订阅信息
### 你的操作
- 你刚登录成功，页面自动初始化用户态

### 交互到的组件
1. **用户数据接口**
   - 类型：**账户 API**
   - 名字：`GET https://api.novelai.net/user/data`
   - 作用：获取用户资料、权益、tier、支付信息

2. **订阅信息接口**
   - 类型：**订阅 API**
   - 名字：`GET https://api.novelai.net/user/subscription`
   - 作用：获取订阅等级和是否激活

3. **Gift Keys 接口**
   - 类型：**账户附属 API**
   - 名字：`GET https://api.novelai.net/user/giftkeys`
   - 作用：查询礼品码（若页面需要）

### 你的页面表现
- 页面显示为已登录
- 图像生成功能可用
- 可判断你的账号权限是否支持生成

---

## 7. 登录后页面拉取你的 prompt 宏 / 用户对象
### 你的操作
- 自动发生，无需点击

### 交互到的组件
1. **Prompt Macros 接口**
   - 类型：**用户内容对象 API**
   - 名字：`GET https://image.novelai.net/user/objects/promptmacros`
   - 作用：获取你保存的 prompt 宏、预设对象

### 页面效果
- 若你之前保存过提示词模板，页面可以恢复或展示它们

---

## 8. 匿名用户与登录用户进行关联
### 你的操作
- 自动发生

### 交互到的组件
1. **Anonymous Usage Link**
   - 类型：**匿名/登录账户关联 API**
   - 名字：`POST https://text.novelai.net/usage/link`
   - 作用：把匿名访问期间的使用记录与登录账号关联

2. **匿名用户 ID**
   - 类型：**本地标识**
   - 名字：`auid=anon-...`
   - 作用：登录前匿名访问标识

### 意义
- 系统会把你未登录状态下的行为和登录后的账户串起来

---

## 9. 页面同步试用状态 / 使用状态
### 你的操作
- 自动发生

### 交互到的组件
1. **Trial Status 接口**
   - 类型：**试用/额度状态 API**
   - 名字：`GET https://text.novelai.net/ai/trial-status`
   - 作用：获取试用或共享试用状态

### 说明
- 即便你是订阅用户，前端也可能统一初始化这类状态

---

## 10. 页面恢复你的图像生成参数
### 你的操作
- 自动恢复，或者你看到上次输入内容还在

### 交互到的组件
1. **imagegen-params-nai-diffusion-4-5-curated**
   - 类型：**本地参数缓存**
   - 名字：图像参数存储项
   - 作用：保存模型参数、分辨率、采样器等

2. **imagegen-prompt**
   - 类型：**本地 prompt 缓存**
   - 名字：图像 prompt 存储项
   - 作用：保存主提示词

3. **imagegen-character-prompts**
   - 类型：**本地角色 prompt 缓存**
   - 名字：角色提示词存储项
   - 作用：保存角色定位/局部角色 prompt

### 页面表现
- 你可能看到上次使用的参数被自动填回表单

---

## 11. 你在 prompt 输入框里开始输入词
### 你的操作
- 输入了类似：
  - `girl`
  - `room`
  - `misaka`

### 交互到的组件
1. **Prompt 输入框**
   - 类型：**前端文本输入组件**
   - 名字：Image Prompt Editor
   - 作用：输入生成提示词

2. **Suggest Tags 接口**
   - 类型：**提示词联想/自动补全 API**
   - 名字：`/ai/generate-image/suggest-tags`
   - 作用：根据当前输入内容给出 tags 建议

### 已观察证据
有这些预检请求：
- `prompt=girl`
- `prompt=room`
- `prompt=misaka`

### 说明
- 你输入这些词时，前端尝试触发标签建议能力

---

## 12. 你设置或确认图像生成参数
### 你的操作
高置信度包括：
- 选择或沿用模型：`nai-diffusion-4-5-curated`
- 保留/设置画面尺寸
- 保留/设置采样器、步数、scale
- 使用角色 prompt `misaka`

### 交互到的组件
1. **模型选择器**
   - 类型：**前端表单控件**
   - 名字：Model Selector
   - 作用：选择生成模型

2. **参数面板**
   - 类型：**前端配置面板**
   - 名字：Image Generation Parameters Panel
   - 作用：设置 width、height、steps、sampler、scale 等

3. **Character Prompts 配置器**
   - 类型：**局部角色控制组件**
   - 名字：Character Prompt Editor
   - 作用：为某个角色区域附加 prompt

4. **Negative Prompt 配置器**
   - 类型：**反向提示词组件**
   - 名字：Negative Prompt Editor
   - 作用：限制不希望出现的内容

5. **骰子/随机种子控件**
   - 类型：**随机参数控件**
   - 名字：Dice / Seed Control
   - 作用：生成不同 seed

### 关键参数（抓包中出现过）
- `width`
- `height`
- `scale`
- `sampler`
- `steps`
- `seed`
- `characterPrompts`
- `negative_prompt`

---

## 13. 你第一次点击“生成图片”
### 你的操作
- 点击生成按钮

### 交互到的组件
1. **Generate Button**
   - 类型：**前端操作按钮**
   - 名字：Generate
   - 作用：触发生图

2. **流式生图接口**
   - 类型：**核心 AI 图像生成 API（流式）**
   - 名字：`POST https://image.novelai.net/ai/generate-image-stream`
   - 作用：边生成边回传中间结果/最终图

3. **multipart/form-data 请求封装器**
   - 类型：**HTTP 请求封装逻辑**
   - 名字：request blob multipart
   - 作用：把 JSON 参数打包成 multipart 请求

4. **reCAPTCHA token（生成场景）**
   - 类型：**风控凭据**
   - 名字：`recaptcha_token`
   - 作用：保护高价值的生成动作

### 结果
- 返回 `429`
- 文案：`Concurrent generation is locked`

### 说明
- 你这次生成触发了服务端并发锁/互斥控制

---

## 14. 页面记录/上报这次生图失败
### 你的操作
- 失败后你可能看到报错提示，或页面没有立即出图

### 交互到的组件
1. **前端请求日志**
   - 类型：**本地诊断日志**
   - 名字：`requestLog_<userId>`
   - 作用：记录这次请求失败和状态码

2. **Sentry**
   - 类型：**错误监控**
   - 名字：Sentry
   - 作用：上报生图失败或接口异常

3. **前端错误提示组件**
   - 类型：**UI 通知/Toast**
   - 名字：Error Notification
   - 作用：展示失败原因（高置信推断）

---

## 15. 你再次触发生图
### 你的操作
- 继续点击生成，或等待后再次生成

### 交互到的组件
1. **流式生图接口**
   - 类型：**AI 图像生成 API（流式）**
   - 名字：`POST /ai/generate-image-stream`

2. **流式响应解析器**
   - 类型：**流式消息解析组件**
   - 名字：MsgPack/Binary Stream Parser
   - 作用：解析 event_type、intermediate、step_ix、JPEG 片段

3. **生成进度展示组件**
   - 类型：**前端生成预览/进度 UI**
   - 名字：Generation Preview / Progress Viewer
   - 作用：展示中间采样结果（高置信推断）

### 结果
- 这次有成功返回流式内容
- 表明页面收到了中间图和进度事件

---

## 16. 你或页面关闭了“流式生成”偏好
### 你的操作
这个动作可能有两种可能：
1. 你手动关闭了流式生成选项
2. 前端在异常后自动改成非流式

### 交互到的组件
1. **Client Settings 接口**
   - 类型：**用户设置 API**
   - 名字：`PUT https://api.novelai.net/user/clientsettings`
   - 作用：写回客户端偏好设置

2. **streamImageGeneration**
   - 类型：**用户设置字段**
   - 名字：`streamImageGeneration: false`
   - 作用：关闭流式生图

3. **设置面板**
   - 类型：**前端设置 UI**
   - 名字：Client Settings / Preferences
   - 作用：管理生成体验偏好

### 结果
- 后续请求开始使用非流式接口

---

## 17. 你继续点击生成，改用非流式接口
### 你的操作
- 再次点击“生成”

### 交互到的组件
1. **非流式生图接口**
   - 类型：**核心 AI 图像生成 API（非流式）**
   - 名字：`POST https://image.novelai.net/ai/generate-image`
   - 作用：直接返回完整图片包

2. **ZIP 响应处理器**
   - 类型：**二进制结果解包逻辑**
   - 名字：ZIP/PNG Result Handler
   - 作用：从返回包中提取 `image_0.png`

3. **图像结果画廊**
   - 类型：**前端结果展示组件**
   - 名字：Image Result Gallery
   - 作用：展示生成好的图片

### 结果
- 返回 ZIP/PNG 成功
- 页面展示一张生成图

---

## 18. 你连续多次重新生成/抽卡
### 你的操作
- 连续多次点击生成
- 每次大致 prompt 相同，但 seed 不同

### 交互到的组件
1. **Generate Button**
   - 类型：**操作按钮**
   - 名字：Generate

2. **Seed Control**
   - 类型：**随机种子控制**
   - 名字：Seed / Dice
   - 作用：改变随机种子

3. **POST /ai/generate-image**
   - 类型：**非流式生成接口**
   - 名字：Image Generation API

4. **请求日志系统**
   - 类型：**本地请求审计**
   - 名字：requestLog

### 结果
- 多次成功返回图片
- 中间可能再次触发一次 `429` 并发锁

### 你的实际操作体验
- 更像在不断“再来一张 / 换个 seed 看结果”

---

## 19. 你查看或保留历史生成结果
### 你的操作
- 页面中应积累了多张历史图
- 你可能浏览了它们

### 交互到的组件
1. **历史记录/画廊组件**
   - 类型：**前端历史结果管理 UI**
   - 名字：Image History / Gallery
   - 作用：展示本轮或历史生成图片

2. **图片缓存/前端状态管理**
   - 类型：**前端状态容器**
   - 名字：Image History State
   - 作用：在页面上保留多张图片记录

---

## 20. 你下载了历史图片
### 你的操作
- 执行了“下载历史图片”之类的操作

### 交互到的组件
1. **下载按钮**
   - 类型：**前端操作控件**
   - 名字：Download History / Download Images
   - 作用：导出/下载已生成图片

2. **Plausible 事件上报**
   - 类型：**业务埋点**
   - 名字：`ImageGenHistoryDownload`
   - 作用：统计下载行为

### 已知证据
事件内容：
```json
{"images":"8"}
```

### 说明
- 你下载了 **8 张** 图片

---

# 二、按顺序列出“所有交互到的组件 + 类型 + 名字”

下面做成更清晰的顺序表。

| 顺序 | 组件名字 | 类型 | 作用 |
|---|---|---|---|
| 1 | `novelai.net` | 主站 Web 前端 / Next.js SPA | 页面承载与业务 UI |
| 2 | `/_next/static/...` | 静态资源/CDN | 加载 JS、SVG、构建资源 |
| 3 | `/updateReload.json` | 前端版本检测组件 | 热更新/刷新判断 |
| 4 | PostHog (`ph-fwd.novelai.net`) | 用户行为分析/埋点 | 记录用户行为和属性 |
| 5 | Plausible | 站点统计/事件分析 | 上报业务事件 |
| 6 | Cloudflare RUM | 性能遥测 | 采集页面性能 |
| 7 | Sentry | 错误监控 | 上报前端或接口异常 |
| 8 | Osano | Cookie 同意管理 | 管理 consent |
| 9 | Google Ads / GTM | 广告归因/标签管理 | 营销追踪 |
| 10 | Reddit Pixel | 广告追踪 | 转化归因 |
| 11 | Chargebee | 支付/订阅 SDK | 支付能力加载 |
| 12 | Google Sign-In | 第三方登录 SDK | Google 登录入口 |
| 13 | Google reCAPTCHA Enterprise Anchor | 风控/验证码 | 获取无感验证码 token |
| 14 | Google reCAPTCHA Enterprise CLR | 风控链路 | 配合 token 校验 |
| 15 | NovelAI 登录表单 | 认证 UI 组件 | 输入并提交登录信息 |
| 16 | `POST /user/login` | 认证 API | 登录并签发 JWT |
| 17 | `localStorage.session` | 浏览器本地存储 | 保存 auth_token |
| 18 | `GET /user/data` | 账户 API | 获取用户资料和权益 |
| 19 | `GET /user/subscription` | 订阅 API | 获取订阅状态 |
| 20 | `GET /user/giftkeys` | 附属账户 API | 获取礼品码 |
| 21 | `GET /user/objects/promptmacros` | 用户对象 API | 拉取 prompt 宏 |
| 22 | `POST /usage/link` | 匿名关联 API | 匿名访问与账号关联 |
| 23 | `GET /ai/trial-status` | 试用状态 API | 获取试用/共享状态 |
| 24 | `imagegen-params-*` | 本地参数缓存 | 保存生成参数 |
| 25 | `imagegen-prompt` | 本地 prompt 缓存 | 保存主提示词 |
| 26 | `imagegen-character-prompts` | 本地角色 prompt 缓存 | 保存角色提示 |
| 27 | Prompt Editor | 文本输入组件 | 输入主 prompt |
| 28 | `suggest-tags` | 提示词联想 API | 提供 tags 建议 |
| 29 | Model Selector | 模型选择组件 | 选择 `nai-diffusion-4-5-curated` |
| 30 | Parameters Panel | 参数面板 | 配置 steps/scale/size |
| 31 | Character Prompt Editor | 角色局部控制组件 | 管理 `misaka` 等角色提示 |
| 32 | Negative Prompt Editor | 负向提示组件 | 设置 negative prompt |
| 33 | Seed/Dice Control | 随机种子控件 | 控制 seed |
| 34 | Generate Button | 操作按钮 | 触发生图 |
| 35 | `POST /ai/generate-image-stream` | 流式生图 API | 返回中间采样与结果 |
| 36 | Stream Parser | 流式消息解析器 | 解析 msgpack/二进制事件 |
| 37 | Progress/Preview Viewer | 生成进度预览组件 | 展示中间图 |
| 38 | `429 Concurrent generation is locked` | 服务端并发锁机制 | 阻止重叠生成 |
| 39 | requestLog | 本地请求日志系统 | 记录请求结果 |
| 40 | `PUT /user/clientsettings` | 用户设置 API | 写回流式/非流式偏好 |
| 41 | `streamImageGeneration` | 设置字段 | 控制是否启用流式生成 |
| 42 | `POST /ai/generate-image` | 非流式生图 API | 直接返回完整结果 |
| 43 | ZIP/PNG Result Handler | 二进制结果处理组件 | 解包图片 |
| 44 | Image Result Gallery | 图片结果画廊 | 展示生成图片 |
| 45 | Image History / Gallery | 历史记录组件 | 展示历史出图 |
| 46 | Download History Button | 下载控件 | 下载历史图片 |
| 47 | `ImageGenHistoryDownload` | 业务埋点事件 | 上报下载行为 |

---

# 三、把你的实际浏览器操作翻译成“人话版顺序”

如果用更贴近用户视角的话，这次你大致做了这些事：

1. 打开 NovelAI 图像页面  
2. 页面自动加载各种脚本、图标、监控和埋点  
3. 页面静默完成 reCAPTCHA 风控初始化  
4. 你登录账号  
5. 登录成功后页面保存 token  
6. 页面自动拉取你的账户、订阅和 prompt 宏  
7. 页面恢复你之前的生图参数  
8. 你在 prompt 里输入词，例如 `girl`、`room`、`misaka`  
9. 页面尝试做 tags 联想  
10. 你确认模型和生图参数  
11. 你第一次点击生成  
12. 第一次流式生成因为并发锁失败  
13. 你再次生成，流式接口成功返回中间结果  
14. 随后页面或你自己关闭了流式生成模式  
15. 你改用普通非流式生成  
16. 你连续多次重新生成，主要是换 seed 抽不同图  
17. 页面保存并展示了一批历史生成结果  
18. 你最后下载了历史图片，共 8 张

---

# 四、哪些是“你主动做的”，哪些是“页面自动做的”

## 你主动做的
- 打开页面
- 登录
- 输入 prompt
- 触发生成
- 可能切换设置
- 多次重新生成
- 下载历史图片

## 页面自动做的
- 加载 JS/CSS/SVG/埋点 SDK
- 初始化 reCAPTCHA
- 保存/恢复 localStorage
- 拉取用户数据、订阅、prompt 宏
- 关联匿名 ID
- 上报错误与统计事件
- 记录 requestLog

---

如果你愿意，我下一步可以继续给你两种更深入的版本：

1. **把这整套流程画成 Mermaid 时序图**
2. **按“用户动作 -> 网络请求 seq 编号 -> 组件”做成证据对照表**

如果你要“证据对照表”那种，我会建议你让我进一步查看具体请求详情。

**User**:

列出所有 API 参数和响应结构

**AI**:

下面给你一份**基于当前抓包摘要与前序分析**整理的 **NovelAI 本次会话所有已识别核心 API 的参数与响应结构清单**。  
先说明边界：

- 你现在给我的不是每条请求的完整 raw 内容，而是**摘要 + 已分析出的关键字段**
- 所以我能做到的是：
  1. **把已确认的 API 全列出来**
  2. **把已确认的参数/响应字段写清楚**
  3. 对于未拿到完整包体的接口，标注为 **“已确认字段”** / **“推定结构”**
- 如果你要做到“字段 100% 完整、包含所有 header/body 子字段”，下一步我需要你指定请求序号，我可以进一步逐条看详情

---

# 一、总览：本次识别到的核心 API

按业务分组有这些：

## 认证与风控
1. `GET https://www.google.com/recaptcha/enterprise/anchor`
2. `POST https://www.google.com/recaptcha/enterprise/clr`
3. `POST https://image.novelai.net/user/login`

## 用户账户与订阅
4. `GET https://api.novelai.net/user/data`
5. `GET https://api.novelai.net/user/subscription`
6. `GET https://api.novelai.net/user/giftkeys`
7. `PUT https://api.novelai.net/user/clientsettings`

## 用户对象
8. `GET https://image.novelai.net/user/objects/promptmacros`

## 文本/试用/匿名关联
9. `POST https://text.novelai.net/usage/link`
10. `GET https://text.novelai.net/ai/trial-status`

## 图像生成
11. `OPTIONS https://image.novelai.net/ai/generate-image/suggest-tags?...`
12. `POST https://image.novelai.net/ai/generate-image-stream`
13. `POST https://image.novelai.net/ai/generate-image`

## 统计/埋点
14. `POST https://plausible.io/api/event`

---

# 二、逐个 API：参数与响应结构

---

## 1) reCAPTCHA Enterprise Anchor

### 接口
```http
GET https://www.google.com/recaptcha/enterprise/anchor
```

### 类型
- 风控初始化接口
- 用于生成页面使用的 reCAPTCHA token

### 请求参数
通常为 URL query 参数，当前摘要未给出完整值，但 reCAPTCHA anchor 常见字段包括：

#### 已确认/高概率存在
- `ar`
- `k`：site key
- `co`：页面来源/域名编码
- `hl`：语言
- `v`：版本
- `size`
- `cb`：随机值/缓存规避参数

### 响应结构
不是 JSON，通常是：
- `text/html`

### 响应内容特征
会包含隐藏字段或脚本中的 token，例如：
- `recaptcha-token`

### 用途
供后续：
- 登录请求 `recaptcha`
- 生图请求 `recaptcha_token`

---

## 2) reCAPTCHA Enterprise CLR

### 接口
```http
POST https://www.google.com/recaptcha/enterprise/clr
```

### 类型
- reCAPTCHA 校验链路请求

### 请求参数
当前未拿到完整包体；通常为表单或 query 参数，内容与 token 校验上下文有关。

### 响应结构
通常不是业务 JSON，可能是：
- 文本
- 空响应
- 很小的控制响应

### 说明
这是 Google 风控链路的一部分，不是 NovelAI 自己的业务 API。

---

## 3) 用户登录

### 接口
```http
POST https://image.novelai.net/user/login
```

### 类型
- 认证 API

### 鉴权
- 无需 Bearer Token
- 依赖 reCAPTCHA token

### 请求头
已知关键头：
```http
Content-Type: application/json
```

### 请求体结构
**已确认字段：**
```json
{
  "key": "<登录密钥>",
  "recaptcha": "<recaptcha token>"
}
```

### 字段说明
- `key`
  - 类型：`string`
  - 含义：登录凭据
  - 说明：不是明文密码，推测是前端处理后的登录密钥/派生值
- `recaptcha`
  - 类型：`string`
  - 含义：reCAPTCHA Enterprise token

### 响应状态
- 成功：`201 Created`

### 响应体结构
**已确认：**
```json
{
  "accessToken": "<JWT>"
}
```

### 字段说明
- `accessToken`
  - 类型：`string`
  - 含义：JWT 访问令牌

### 错误响应
摘要未给出完整错误体，但常见会是：
```json
{
  "message": "..."
}
```

---

## 4) 用户综合数据

### 接口
```http
GET https://api.novelai.net/user/data
```

### 类型
- 用户账户综合信息 API

### 鉴权
```http
Authorization: Bearer <JWT>
```

### 请求参数
- 无显式 body
- query 未见

### 响应体结构
根据前序分析，已确认返回用户优先级、订阅、支付处理器、perks 等。可整理为：

```json
{
  "priority": 0,
  "subscription": {
    "tier": 3,
    "active": true,
    "perks": {
      "imageGeneration": true,
      "unlimitedImageGeneration": true
    }
  },
  "paymentProcessor": "...",
  "...": "..."
}
```

### 已确认字段
- `subscription.tier`
- `subscription.active`
- `subscription.perks.imageGeneration`
- `subscription.perks.unlimitedImageGeneration`

### 推定可能字段
- `emailVerified`
- `trainingStepsLeft`
- `purchasedPoints`
- `priority`
- `paymentProcessor`

> 注意：这里完整字段名因为没有 raw body，不能保证逐字精确。

---

## 5) 用户订阅信息

### 接口
```http
GET https://api.novelai.net/user/subscription
```

### 类型
- 订阅状态 API

### 鉴权
```http
Authorization: Bearer <JWT>
```

### 请求参数
- 无 body

### 响应体结构
根据前序分析，至少包含：

```json
{
  "tier": 3,
  "active": true,
  "perks": {
    "imageGeneration": true,
    "unlimitedImageGeneration": true
  },
  "...": "..."
}
```

### 已确认字段
- `tier`
- `active`
- `perks.imageGeneration`
- `perks.unlimitedImageGeneration`

### 推定可能字段
- `renewalDate`
- `paymentProcessor`
- `cancelled`
- `expiresAt`

---

## 6) Gift Keys

### 接口
```http
GET https://api.novelai.net/user/giftkeys
```

### 类型
- 礼品码列表 API

### 鉴权
```http
Authorization: Bearer <JWT>
```

### 请求参数
- 无 body

### 响应体结构
摘要没有完整返回体，通常可能是数组：

```json
[
  {
    "key": "...",
    "status": "...",
    "...": "..."
  }
]
```

或：
```json
{
  "giftKeys": [
    {
      "...": "..."
    }
  ]
}
```

### 结论
- **接口存在已确认**
- **具体字段未确认**

---

## 7) 用户客户端设置

### 接口
```http
PUT https://api.novelai.net/user/clientsettings
```

### 类型
- 用户偏好设置 API

### 鉴权
```http
Authorization: Bearer <JWT>
```

### 请求体结构
已确认至少包含：

```json
{
  "settingsVersion": 16,
  "streamImageGeneration": false,
  "imageTutorialSeen": true,
  "uiLanguage": "en",
  "model": "nai-diffusion-4-5-curated"
}
```

### 已确认字段
- `streamImageGeneration`
- `imageTutorialSeen`
- `uiLanguage`
- `model`

### 推定可能字段
- `settingsVersion`
- 其他 UI 偏好字段

### 响应结构
摘要未给出，常见可能是：
1. 返回更新后的设置对象
```json
{
  "streamImageGeneration": false,
  "...": "..."
}
```

2. 或空响应 / 204

当前不能确认是哪一种。

---

## 8) Prompt Macros

### 接口
```http
GET https://image.novelai.net/user/objects/promptmacros
```

### 类型
- 用户对象存储 API

### 鉴权
```http
Authorization: Bearer <JWT>
```

### 请求参数
- 无 body

### 响应结构
已知作用是返回用户保存的 prompt 宏对象。大概率是数组或对象列表：

```json
[
  {
    "id": "...",
    "type": "promptmacro",
    "data": {
      "...": "..."
    }
  }
]
```

或：
```json
{
  "objects": [
    {
      "...": "..."
    }
  ]
}
```

### 结论
- **返回 prompt 宏已确认**
- **完整字段未确认**

---

## 9) 匿名用量关联

### 接口
```http
POST https://text.novelai.net/usage/link
```

### 类型
- 匿名用户与登录账号关联 API

### 鉴权
```http
Authorization: Bearer <JWT>
```

### 请求体结构
根据前序分析，结构可表示为：

```json
{
  "anonymous_user_id": "anon-..."
}
```

### 已确认字段
- `anonymous_user_id` 或同义字段

> 字段名当前是推定表达，含义已确认，逐字字段名未 100% raw 校验。

### 响应结构
摘要未给出，可能为：
```json
{
  "success": true
}
```
或空响应。

---

## 10) 试用状态

### 接口
```http
GET https://text.novelai.net/ai/trial-status
```

### 类型
- 试用/共享试用状态 API

### 鉴权
- 可能需要 Bearer Token，也可能匿名可查；当前摘要未完全确认
- 在本次会话中属于登录后初始化的一部分

### 请求参数
- 无 body

### 响应结构
摘要没有完整体，仅能确认用于表示 trial 状态。可能类似：

```json
{
  "trial": false,
  "sharedTrial": false,
  "...": "..."
}
```

或：
```json
{
  "status": "...",
  "...": "..."
}
```

---

## 11) 图像标签建议

### 接口
```http
OPTIONS/GET https://image.novelai.net/ai/generate-image/suggest-tags
```

### 类型
- Prompt 标签联想 API

### 请求参数
摘要中已见 query 参数：

```text
model=nai-diffusion-4-5-curated
prompt=girl
```

也出现了：
- `prompt=room`
- `prompt=misaka`

### 已确认 query 字段
- `model`
- `prompt`

### 响应结构
当前只确认到了 `OPTIONS` 预检，没有拿到成功业务响应体。  
合理推定为标签数组，例如：

```json
{
  "tags": [
    "1girl",
    "indoors",
    "room"
  ]
}
```

或：
```json
[
  "1girl",
  "room",
  "bedroom"
]
```

### 结论
- 请求参数已较明确
- 响应结构未直接捕获

---

## 12) 流式图像生成

### 接口
```http
POST https://image.novelai.net/ai/generate-image-stream
```

### 类型
- 核心 AI 图像生成 API（流式）

### 鉴权
```http
Authorization: Bearer <JWT>
Content-Type: multipart/form-data
```

### 请求格式
不是纯 JSON，而是：
- `multipart/form-data`
- 其中一个 part 名为 `request`
- part 内容是 JSON blob

### 请求体 JSON 结构
已确认结构如下：

```json
{
  "input": "girl, room, very aesthetic, masterpiece, no text, -0.8::feet::, rating:general",
  "model": "nai-diffusion-4-5-curated",
  "action": "generate",
  "parameters": {
    "params_version": 3,
    "width": 832,
    "height": 1216,
    "scale": 5.6,
    "sampler": "k_euler_ancestral",
    "steps": 28,
    "n_samples": 1,
    "seed": 1234567890,
    "qualityToggle": true,
    "noise_schedule": "karras",
    "negative_prompt": "...",
    "image_format": "png",
    "stream": "msgpack",
    "characterPrompts": [
      {
        "prompt": "misaka",
        "uc": "",
        "center": {
          "x": 0.5,
          "y": 0.5
        },
        "enabled": true
      }
    ]
  },
  "use_new_shared_trial": true,
  "recaptcha_token": "<token>"
}
```

### 已确认顶层字段
- `input`
- `model`
- `action`
- `parameters`
- `use_new_shared_trial`
- `recaptcha_token`

### 已确认 `parameters` 字段
- `params_version`
- `width`
- `height`
- `scale`
- `sampler`
- `steps`
- `n_samples`
- `seed`
- `qualityToggle`
- `noise_schedule`
- `negative_prompt`
- `image_format`
- `stream`
- `characterPrompts`

### 已确认 `characterPrompts` 子字段
- `prompt`
- `uc`
- `center.x`
- `center.y`
- `enabled`

### 成功响应
状态：
- `200`

响应类型：
- **不是普通 JSON**
- **二进制/流式分块响应**
- 可能是 msgpack 事件流

### 流式响应内容特征
已观察到字段/片段：
- `event_type`
- `intermediate`
- `samp_ix`
- `step_ix`
- `gen_id`
- `sigma`
- JPEG 二进制片段

### 可描述的流式事件结构
更像这样：

```json
{
  "event_type": "intermediate",
  "samp_ix": 0,
  "step_ix": 12,
  "gen_id": "...",
  "sigma": 1.234,
  "image": "<jpeg binary>"
}
```

最终事件可能类似：
```json
{
  "event_type": "final",
  "gen_id": "...",
  "image": "<jpeg/png binary>"
}
```

### 失败响应
已确认一种：
- 状态：`429`
- 响应体：
```json
{
  "message": "Concurrent generation is locked"
}
```

---

## 13) 非流式图像生成

### 接口
```http
POST https://image.novelai.net/ai/generate-image
```

### 类型
- 核心 AI 图像生成 API（非流式）

### 鉴权
```http
Authorization: Bearer <JWT>
Content-Type: multipart/form-data
```

### 请求格式
与流式接口一致：
- `multipart/form-data`
- `request` part 内嵌 JSON

### 请求体结构
与流式接口非常接近，只是 `parameters.stream` 可能不存在：

```json
{
  "input": "girl, room, very aesthetic, masterpiece, no text, -0.8::feet::, rating:general",
  "model": "nai-diffusion-4-5-curated",
  "action": "generate",
  "parameters": {
    "params_version": 3,
    "width": 832,
    "height": 1216,
    "scale": 5.6,
    "sampler": "k_euler_ancestral",
    "steps": 28,
    "n_samples": 1,
    "seed": 1234567890,
    "qualityToggle": true,
    "noise_schedule": "karras",
    "negative_prompt": "...",
    "image_format": "png",
    "characterPrompts": [
      {
        "prompt": "misaka",
        "uc": "",
        "center": {
          "x": 0.5,
          "y": 0.5
        },
        "enabled": true
      }
    ]
  },
  "use_new_shared_trial": true,
  "recaptcha_token": "<token>"
}
```

### 响应状态
- 成功：`200`

### 响应体结构
已确认不是 JSON，而是：
- ZIP / 二进制包

响应内容出现：
- `PK...image_0.png...`

### 因此响应可抽象为
```text
application/zip
└── image_0.png
```

### 失败响应
至少观察到：
```json
{
  "message": "Concurrent generation is locked"
}
```
状态码：
- `429`

---

## 14) Plausible 业务事件埋点

### 接口
```http
POST https://plausible.io/api/event
```

### 类型
- 埋点/统计事件 API

### 请求体结构
本次已知事件之一：

```json
{
  "name": "ImageGenHistoryDownload",
  "url": "https://novelai.net/image",
  "domain": "novelai.net",
  "props": {
    "images": "8"
  }
}
```

### 已确认字段
- `name`
- `url`
- `domain`
- `props.images`

### 响应结构
通常为：
- `202` / `200`
- 空响应或简单成功体

---

# 三、生成类接口的完整字段整理

因为你最关心的通常是生图接口，我把它单独汇总。

---

## 3.1 生成请求顶层字段

| 字段 | 类型 | 是否确认 | 说明 |
|---|---|---:|---|
| `input` | string | 是 | 主 prompt |
| `model` | string | 是 | 模型名，如 `nai-diffusion-4-5-curated` |
| `action` | string | 是 | 动作，值为 `generate` |
| `parameters` | object | 是 | 生成参数集合 |
| `use_new_shared_trial` | boolean | 是 | 试用相关标志 |
| `recaptcha_token` | string | 是 | 生成动作风控 token |

---

## 3.2 `parameters` 字段

| 字段 | 类型 | 是否确认 | 示例 |
|---|---|---:|---|
| `params_version` | number | 是 | `3` |
| `width` | number | 是 | `832` |
| `height` | number | 是 | `1216` |
| `scale` | number | 是 | `5.6` |
| `sampler` | string | 是 | `k_euler_ancestral` |
| `steps` | number | 是 | `28` |
| `n_samples` | number | 是 | `1` |
| `seed` | number | 是 | 随机种子 |
| `qualityToggle` | boolean | 是 | `true` |
| `noise_schedule` | string | 是 | `karras` |
| `negative_prompt` | string | 是 | 负向提示词 |
| `image_format` | string | 是 | `png` |
| `stream` | string | 流式接口确认 | `msgpack` |
| `characterPrompts` | array | 是 | 角色提示数组 |

---

## 3.3 `characterPrompts[]` 子结构

```json
{
  "prompt": "misaka",
  "uc": "",
  "center": {
    "x": 0.5,
    "y": 0.5
  },
  "enabled": true
}
```

| 字段 | 类型 | 是否确认 | 说明 |
|---|---|---:|---|
| `prompt` | string | 是 | 局部角色提示词 |
| `uc` | string | 是 | 对应负向/附加字段 |
| `center.x` | number | 是 | 角色中心点 X |
| `center.y` | number | 是 | 角色中心点 Y |
| `enabled` | boolean | 是 | 是否启用 |

---

# 四、鉴权与通用请求特征

## 4.1 登录后大多数业务接口通用请求头
```http
Authorization: Bearer <JWT>
```

## 4.2 生成类接口额外特征
- `Content-Type: multipart/form-data`
- part name = `request`
- 内部装 JSON blob
- 携带 `recaptcha_token`

## 4.3 登录接口特征
- `Content-Type: application/json`
- body 字段为 `key + recaptcha`

---

# 五、当前“已经确认”与“还缺完整原文”的边界

## 已确认较完整的
1. `POST /user/login`
2. `POST /ai/generate-image-stream`
3. `POST /ai/generate-image`
4. `PUT /user/clientsettings`（部分字段）
5. `POST /usage/link`（功能明确，字段半确认）
6. `POST /plausible.io/api/event`

## 仅确认用途，字段未完整
1. `GET /user/data`
2. `GET /user/subscription`
3. `GET /user/giftkeys`
4. `GET /user/objects/promptmacros`
5. `GET /ai/trial-status`
6. `GET/OPTIONS /suggest-tags`
7. Google reCAPTCHA 两个接口

---

# 六、如果你要“完整字段版”，下一步怎么做

如果你想让我输出真正严格的：

- 每个 API 的**完整请求头**
- **完整请求体**
- **完整响应头**
- **完整响应体字段树**
- 哪些字段是必填 / 可选 / 动态变化

那我需要逐条查看原始请求详情。  
你刚才的问题是“列出所有 API 参数和响应结构”，在当前摘要条件下我已经把**能从现有证据提取的核心结构基本列全了**。

---

# 七、最简版结论

本次会话里，最关键的 API 结构可以概括为：

## 登录
```json
POST /user/login
{
  "key": "...",
  "recaptcha": "..."
}
=> 
{
  "accessToken": "..."
}
```

## 流式生图
```json
POST /ai/generate-image-stream
multipart/form-data(request=<json>)
{
  "input": "...",
  "model": "nai-diffusion-4-5-curated",
  "action": "generate",
  "parameters": {
    "width": 832,
    "height": 1216,
    "scale": 5.6,
    "sampler": "k_euler_ancestral",
    "steps": 28,
    "seed": 123,
    "negative_prompt": "...",
    "characterPrompts": [...],
    "stream": "msgpack"
  },
  "recaptcha_token": "..."
}
=>
200: 流式二进制事件
或
429: {"message":"Concurrent generation is locked"}
```

## 非流式生图
```json
POST /ai/generate-image
multipart/form-data(request=<json>)
{
  "input": "...",
  "model": "nai-diffusion-4-5-curated",
  "action": "generate",
  "parameters": {...},
  "recaptcha_token": "..."
}
=>
200: ZIP(binary, image_0.png)
或
429: {"message":"Concurrent generation is locked"}
```

---

如果你愿意，我下一步最适合做的是：

1. **我帮你整理成 OpenAPI/YAML 风格文档**
2. **你给我具体请求序号，我逐条提取“完整真实字段”**
3. **我帮你把所有接口做成“字段字典表”**（字段名 / 类型 / 示例 / 来源接口 / 备注）

如果你要最实用的，我建议下一步直接说：

> “把生图、登录、订阅这几类接口整理成 OpenAPI 风格”

或者：

> “继续，把关键请求的完整字段补齐”
