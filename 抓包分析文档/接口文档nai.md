以下是基于所给 HTTP 日志、响应、存储变化的结构化协议分析报告。

---

# NovelAI 协议分析报告

## 1. 场景识别

### 结论
该批操作的核心业务场景是：

1. **用户登录**
2. **获取账户信息/订阅状态**
3. **进入图像生成功能页并进行提示词编辑**
4. **调用 AI 图片生成接口进行多次生成**
5. **处理并发生成冲突**
6. **下载历史生成结果**
7. **创建/覆盖持久化 API Token**
8. **附带页面埋点、风控（reCAPTCHA Enterprise）、错误上报、广告/统计请求**

### 非核心但可见的辅助场景
- Google Sign-In 组件加载，但**未看到真正走 Google 登录回调**
- Chargebee 计费前端组件加载，但**未看到支付提交**
- Osano 同意管理、Plausible / PostHog / Google Ads / Reddit Pixel / Cloudflare RUM 埋点
- 文本服务状态联动：`text.novelai.net/ai/trial-status`、`text.novelai.net/usage/link`

---

## 2. 交互流程概述

按时间顺序还原主流程：

### 阶段 A：进入站点与页面初始化
1. 访问 `https://novelai.net/image`
2. 页面初始化期间加载：
   - `updateReload.json`
   - Cloudflare RUM
   - Google Ads / GTM / Plausible / PostHog
   - Chargebee
   - Reddit Pixel
   - Google GSI 按钮
3. 页面申请并加载 **reCAPTCHA Enterprise anchor**
   - `GET /recaptcha/enterprise/anchor`
   - 返回隐藏字段中的 token

### 阶段 B：登录
4. 前端先做 CORS 预检：
   - `OPTIONS https://image.novelai.net/user/login`
5. 执行登录：
   - `POST https://image.novelai.net/user/login`
   - Body:
     - `key`: 登录密钥
     - `recaptcha`: reCAPTCHA token
   - 响应 `201`
   - 返回：
     - `accessToken`（JWT）

### 阶段 C：登录后账户态初始化
6. 使用 `Authorization: Bearer <JWT>` 拉取用户信息：
   - `GET https://api.novelai.net/user/data`
   - 得到订阅、优先级、套餐能力等
7. 拉取图像侧用户对象：
   - `GET https://image.novelai.net/user/objects/promptmacros`
8. 绑定匿名文本使用记录：
   - `POST https://text.novelai.net/usage/link`
   - Body 中含 `anonymous_user_id`
9. 周期性或页面态查询：
   - `GET https://api.novelai.net/user/subscription`
   - `GET https://api.novelai.net/user/giftkeys`
   - `GET https://text.novelai.net/ai/trial-status`

### 阶段 D：前端编辑图像生成参数
10. 用户在图像页输入提示词，触发 tag suggest：
   - `GET/OPTIONS https://image.novelai.net/ai/generate-image/suggest-tags?...prompt=girl`
   - 同理 `room`、`misaka`
11. 本地存储写入：
   - `imagegen-prompt="girl, room"`
   - `imagegen-character-prompts=[{"prompt":"misaka",...}]`
   - `imagegen-params-nai-diffusion-4-5-curated={...}`

### 阶段 E：首次尝试流式图像生成
12. 预检：
   - `OPTIONS https://image.novelai.net/ai/generate-image-stream`
13. 流式生成请求：
   - `POST https://image.novelai.net/ai/generate-image-stream`
   - multipart/form-data
   - 内嵌 JSON 请求
   - 包含：
     - 主 prompt
     - model=`nai-diffusion-4-5-curated`
     - 详细采样参数
     - `characterPrompts`
     - `v4_prompt`
     - `negative_prompt`
     - `recaptcha_token`
14. 首次返回：
   - `429 Concurrent generation is locked`
   - 表示该账号/会话已有并发生成锁
15. 前端将错误写入本地请求日志，并上报 Sentry

### 阶段 F：再次流式生成成功
16. 再次调用 `POST /ai/generate-image-stream`
17. 这次返回 `200`
18. 响应内容不是 SSE 文本，而是**二进制流/混合流**，可见：
   - `event_type`
   - `intermediate`
   - `JPEG 二进制片段`
19. 前端流式处理时出现 JS 异常，被 Sentry 上报

### 阶段 G：切换为非流式生成
20. 用户更新客户端设置：
   - `PUT https://api.novelai.net/user/clientsettings`
   - 关键字段：
     - `"streamImageGeneration": false`
21. 随后改用非流式接口：
   - `POST https://image.novelai.net/ai/generate-image`
22. 请求依然是 `multipart/form-data` + JSON blob
23. 成功时返回 ZIP/二进制包：
   - 典型响应头部 `PK...`
   - 内含 `image_0.png`
24. 用户多次重复生成，不同 `seed`
25. 中间有一次又触发：
   - `429 Concurrent generation is locked`
26. 随后再次重试成功，多次得到 `PK image_0.png...`

### 阶段 H：结果下载与持久化 Token 管理
27. 用户进行了历史图像下载操作：
   - Plausible 事件 `ImageGenHistoryDownload`
   - `{"images":"8"}`
28. 用户查看 giftkeys：
   - `GET /user/giftkeys`
29. 用户尝试创建持久化 token：
   - `POST /user/create-persistent-token`
   - 第一次 `overwrite:false` → `409 Token already exists`
30. 用户改为覆盖：
   - `POST /user/create-persistent-token {"overwrite":true}`
   - `201` 返回 `pst-...`
31. 后续再次同样流程，生成新的持久化 token

---

## 3. API 端点清单

以下仅列关键业务 API。

### 3.1 认证与账户

| 方法 | 端点 | 用途 |
|---|---|---|
| POST | `https://image.novelai.net/user/login` | 登录，换取 accessToken |
| GET | `https://api.novelai.net/user/data` | 获取账户、订阅、优先级、能力信息 |
| GET | `https://api.novelai.net/user/subscription` | 获取订阅详情 |
| GET | `https://api.novelai.net/user/giftkeys` | 查询 gift keys |
| POST | `https://api.novelai.net/user/create-persistent-token` | 创建/覆盖持久化 token |
| PUT | `https://api.novelai.net/user/clientsettings` | 保存客户端设置 |

### 3.2 图像生成

| 方法 | 端点 | 用途 |
|---|---|---|
| GET | `https://image.novelai.net/user/objects/promptmacros` | 获取图像提示词宏 |
| GET | `https://image.novelai.net/ai/generate-image/suggest-tags` | 提示词标签补全/建议 |
| POST | `https://image.novelai.net/ai/generate-image-stream` | 流式图像生成 |
| POST | `https://image.novelai.net/ai/generate-image` | 非流式图像生成 |

### 3.3 文本/试用联动

| 方法 | 端点 | 用途 |
|---|---|---|
| POST | `https://text.novelai.net/usage/link` | 将匿名用户使用记录与登录账户关联 |
| GET | `https://text.novelai.net/ai/trial-status` | 获取 trial 状态 |

### 3.4 风控/验证

| 方法 | 端点 | 用途 |
|---|---|---|
| GET | `https://www.google.com/recaptcha/enterprise/anchor` | 获取 reCAPTCHA 企业版 token 页面 |
| POST | `https://www.google.com/recaptcha/enterprise/clr` | reCAPTCHA 校验/清理链路 |

### 3.5 埋点/监控

| 方法 | 端点 | 用途 |
|---|---|---|
| POST | `https://ph-fwd.novelai.net/i/v0/e/` | PostHog 埋点转发 |
| POST | `https://plausible.io/api/event` | Plausible 自定义事件上报 |
| POST | `https://o1006200.ingest.sentry.io/api/.../envelope/` | Sentry 错误上报 |
| POST | `https://novelai.net/cdn-cgi/rum` | Cloudflare RUM |
| GET | `https://novelai.net/updateReload.json` | 前端热更新/强制刷新控制 |

---

## 4. 鉴权机制分析

## 4.1 认证方式
核心认证方式是：

- **Bearer Token**
- Token 类型为 **JWT accessToken**
- 通过登录接口获得
- 后续放在 `Authorization: Bearer <token>` 请求头中

### 证据
`#134 POST /user/login` 响应：
```json
{"accessToken":"eyJhbGciOiJIUzI1NiIs..."}
```

后续：
- `#136 GET /user/data`
- `#140 GET /user/objects/promptmacros`
- `#143 POST /usage/link`
- `#171 GET /user/subscription`
- `#188 GET /user/giftkeys`
- `#193 POST /ai/generate-image`
- `#298/#300/#303 POST /user/create-persistent-token`

均携带：
```http
Authorization: Bearer eyJ...
```

---

## 4.2 登录凭据获取流程
登录请求体包含：

```json
{
  "key":"A5yPkGOx...",
  "recaptcha":"0cAFcWeA..."
}
```

说明登录至少依赖两项：
1. `key`：用户登录主凭据，可能是前端已派生/预处理后的登录密钥，而非明文密码
2. `recaptcha`：Google reCAPTCHA Enterprise token

### 推断
由于未给出 JS Hook 和加密操作记录，无法证明 `key` 的派生算法；但从现象看：
- 页面并未直接发送用户名/密码
- 而是发送一个高熵字符串 `key`
- 该值很可能由前端根据用户输入做 KDF/哈希/密钥派生后提交

---

## 4.3 凭据传递方式

### Access Token
通过 Header 传递：
```http
Authorization: Bearer <JWT>
```

### Session 本地持久化
`localStorage.session` 中保存：
```json
{
  "auth_token":"eyJ...",
  "encryption_key":"HlVTfooc..."
}
```

说明前端将登录态持久化在本地，而不是依赖 HttpOnly Session Cookie。

### Persistent Token
后续可创建长期 Token：
- 前缀 `pst-`
- 由 `/user/create-persistent-token` 返回
- 可作为后续 API 长期凭据候选

已观察到：
- `pst-YXZ67...`
- `pst-CcfwI...`

---

## 4.4 Cookie 是否承担主认证
从日志看：
- 没有关键业务接口依赖登录 Cookie
- Cookie 主要是：
  - Osano consent
  - g_state
  - _gcl_au
  - _rdt_uuid
  - analytics / ads 相关

因此：
**业务主认证不依赖 Cookie，会话主凭据是 Bearer Token。**

---

## 5. 流式通信分析

## 5.1 是否存在流式接口
存在。

关键端点：
- `POST https://image.novelai.net/ai/generate-image-stream`

## 5.2 协议类型判断
不是 WebSocket。  
也**不完全像标准 SSE**，更像：

- **HTTP 持续响应流**
- 请求体 multipart/form-data
- 响应体是**二进制流 + 事件字段混合**
- 请求参数中明确有：
  - `"stream":"msgpack"`

### 证据
`#163` 和 `#166` 的请求 JSON 中：
```json
"image_format":"png",
"stream":"msgpack"
```

而 `#166` 响应中可见：
- `event_type`
- `intermediate`
- `JPEG 魔数/图像片段`

说明服务端可能返回：
- msgpack 编码的事件流
- 事件里嵌入中间图像预览/采样进度
- 前端边读边解析

## 5.3 流式响应特征
可见字段：
- `event_type`
- `intermediate`
- `sample`
- `step_ix`
- `gen_id`
- `sigma`
- `image`

这很像生成过程中的中间采样事件。

## 5.4 流式失败特征
若存在并发锁，直接返回：
```json
{"statusCode":429,"message":"Concurrent generation is locked"}
```

---

## 6. 存储使用分析

## 6.1 localStorage

### 核心登录态
`session`
```json
{
  "auth_token":"<JWT>",
  "encryption_key":"<高熵字符串>"
}
```

意义：
- `auth_token`：API 访问令牌
- `encryption_key`：前端本地加密/对象加解密可能使用的密钥

### 图像生成参数
- `imagegen-prompt="girl, room"`
- `imagegen-character-prompts=[{"prompt":"misaka",...}]`
- `imagegen-params-nai-diffusion-4-5-curated={...}`

意义：
- 用于持久化当前模型参数、prompt、角色 prompt

### 请求日志
`requestLog_gcDmc-UUvJENuj-ps_6e1`
- 记录 correlationId、URL、method、status、httpStatus、开始结束时间
- 可用于前端调试、错误追踪、历史展示

### 用户/设备与埋点
- `auid=anon-...`
- `ph_phc_..._posthog`
- `_gcl_ls`
- `_grecaptcha`

### 非登录配置
- `noAccountSettings`
- `localTrialState2`
- `lastLoginMethod=regular`

---

## 6.2 sessionStorage

关键项：
- `paymentDueModalDisabled=true`
- `signUpModalShown=true`
- PostHog 当前窗口状态
- 一个可疑高熵键：
  - `bGBxd1tsa2ZvbDBsaWNrfXFld3c==eyNhbHFrciUyMSYpeGRjajIrIm4=`
  
该键名称看起来像拼接后的编码串，更像应用内部状态或混淆残留，不足以单独断定业务意义。

---

## 6.3 Cookie

核心看到的是非业务认证 Cookie：
- `osano_consentmanager_uuid`
- `osano_consentmanager`
- `_gcl_au`
- `_rdt_uuid`
- `g_state`

其中：
- `g_state` 来自 Google Sign-In
- 不承担 NovelAI 主鉴权

### 存储变化中 “0/1/2/3/4=[object Object]”
这类 Cookie 名非常异常，且值为 `[object Object]`，更像：
- 某脚本错误地把对象直接写入 Cookie
- 或采集工具解析异常
不应视作主业务字段。

---

## 7. 关键依赖关系

## 7.1 登录链路依赖
```text
recaptcha anchor -> 获得 recaptcha token
                -> POST /user/login(key, recaptcha)
                -> 返回 accessToken
                -> 后续所有用户 API / 图像 API 依赖 Bearer Token
```

## 7.2 图像生成依赖
```text
登录成功
 -> 获取订阅/能力信息
 -> 编辑 prompt / model / params
 -> 获取/刷新 recaptcha_token
 -> POST /ai/generate-image(-stream)
```

### 关键约束
- 图像生成请求中含 `recaptcha_token`
- 若生成通道被占用，会返回 `429 Concurrent generation is locked`

## 7.3 流式/非流式切换依赖
```text
默认尝试 stream 接口
 -> 遇到异常/并发锁/前端处理问题
 -> PUT /user/clientsettings { streamImageGeneration: false }
 -> 后续改调 /ai/generate-image
```

## 7.4 持久化 Token 创建依赖
```text
先有 accessToken
 -> POST /user/create-persistent-token
 -> 若已有旧 token 且 overwrite=false => 409
 -> overwrite=true => 201 返回新 pst-token
```

## 7.5 文本服务联动依赖
```text
登录后 -> POST /text/usage/link(anonymous_user_id)
      -> 把匿名 trial/usage 状态关联到账户
```

---

## 8. 复现建议

下面给出协议级伪逻辑，而不是可直接运行代码。

## 8.1 登录复现

```pseudo
# Step 1: 获取 recaptcha token
GET https://www.google.com/recaptcha/enterprise/anchor?...site_key=...
parse hidden input #recaptcha-token => recaptcha_token

# Step 2: 准备登录 key
# 注意：日志中只看到最终 key，未看到其派生过程
# 若要完整复现，需要逆向前端登录 key 生成逻辑
login_key = derive_key(username_or_email, password)  # 待补

# Step 3: 登录
POST https://image.novelai.net/user/login
Content-Type: application/json

{
  "key": login_key,
  "recaptcha": recaptcha_token
}

# Step 4: 保存 accessToken
access_token = response.accessToken
store localStorage.session.auth_token = access_token
```

---

## 8.2 登录后初始化复现

```pseudo
headers = {
  "Authorization": "Bearer " + access_token,
  "Content-Type": "application/json"
}

GET https://api.novelai.net/user/data
GET https://api.novelai.net/user/subscription
GET https://image.novelai.net/user/objects/promptmacros
GET https://api.novelai.net/user/giftkeys

POST https://text.novelai.net/usage/link
{
  "anonymous_user_id": "anon-xxxx"
}
```

---

## 8.3 图像生成复现

### 非流式
```pseudo
# 准备 prompt / params / recaptcha_token
request_json = {
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
    "seed": RANDOM_UINT32,
    "n_samples": 1,
    "ucPreset": 0,
    "qualityToggle": true,
    "autoSmea": false,
    "dynamic_thresholding": false,
    "controlnet_strength": 1,
    "legacy": false,
    "add_original_image": true,
    "cfg_rescale": 0,
    "noise_schedule": "karras",
    "legacy_v3_extend": false,
    "skip_cfg_above_sigma": null,
    "use_coords": false,
    "legacy_uc": false,
    "normalize_reference_strength_multiple": true,
    "inpaintImg2ImgStrength": 1,
    "characterPrompts": [
      {
        "prompt": "misaka",
        "uc": "",
        "center": {"x": 0.5, "y": 0.5},
        "enabled": true
      }
    ],
    "v4_prompt": {
      "caption": {
        "base_caption": "...",
        "char_captions": [
          {
            "char_caption": "misaka",
            "centers": [{"x": 0.5, "y": 0.5}]
          }
        ]
      },
      "use_coords": false,
      "use_order": true
    },
    "v4_negative_prompt": {...},
    "negative_prompt": "...",
    "prefer_brownian": true,
    "image_format": "png"
  },
  "use_new_shared_trial": true,
  "recaptcha_token": recaptcha_token
}

# multipart/form-data 上传名为 request 的 JSON blob
POST https://image.novelai.net/ai/generate-image
Authorization: Bearer <token>
Content-Type: multipart/form-data

form-data:
  request = blob(JSON.stringify(request_json), "application/json")

# 成功返回 zip 包，内含 image_0.png
```

### 流式
```pseudo
request_json.parameters.stream = "msgpack"

POST https://image.novelai.net/ai/generate-image-stream
Authorization: Bearer <token>
Content-Type: multipart/form-data

# 持续读取响应体
while chunk = read():
    decode msgpack event
    if event_type == "intermediate":
        render preview
    if event contains final image:
        save final output
```

---

## 8.4 并发锁处理逻辑

```pseudo
resp = POST /ai/generate-image or /ai/generate-image-stream

if resp.status == 429 and resp.message contains "Concurrent generation is locked":
    wait / poll
    retry later
```

---

## 8.5 持久化 Token 复现

```pseudo
POST https://api.novelai.net/user/create-persistent-token
Authorization: Bearer <access_token>
Content-Type: application/json

{"overwrite": false}

if response.status == 409:
    POST same endpoint
    {"overwrite": true}

# success -> {"token":"pst-..."}
```

---

## 9. 关键字段总结

## 9.1 登录相关
- `key`
- `recaptcha`
- 返回 `accessToken`

## 9.2 用户态
- `Authorization: Bearer <JWT>`
- localStorage `session.auth_token`
- localStorage `session.encryption_key`

## 9.3 图像生成相关
- `input`
- `model`
- `action="generate"`
- `parameters.width/height/scale/sampler/steps/seed`
- `characterPrompts`
- `v4_prompt`
- `v4_negative_prompt`
- `negative_prompt`
- `recaptcha_token`

## 9.4 持久化 Token
- 请求：
  - `{"overwrite":false|true}`
- 响应：
  - `{"token":"pst-..."}`

---

## 10. 业务结论

### 最终识别出的用户行为
本次会话中，用户完成了以下关键操作：

1. 打开 NovelAI 图片生成页面
2. 通过 `key + recaptcha` 登录
3. 获取用户订阅与账户数据
4. 输入 prompt：`girl, room`
5. 输入角色 prompt：`misaka`
6. 使用模型 `nai-diffusion-4-5-curated` 多次生成图片
7. 首次尝试流式生成，发生并发锁与前端异常
8. 切换到非流式生成并连续成功生成多张图片
9. 下载了历史图像结果（8 张）
10. 创建并覆盖了持久化 token

---

## 11. 风险/实现要点

从协议角度看，复现难点主要有两个：

1. **登录 key 的前端派生算法未直接暴露**
   - 这是完整自动化登录的主要门槛

2. **reCAPTCHA Enterprise token 是图像生成与登录的前置依赖**
   - 单纯重放旧 token 很可能失效
   - 真实复现需要浏览器环境或相应验证码获取流程

---

如果你需要，我下一步可以继续给你输出两种更进一步的结果之一：

1. **“最小可复现请求清单”**：把这些请求精简成最小顺序列表  
2. **“Python/Node 协议复现脚本骨架”**：按登录→拉用户信息→生成图片→创建持久 token 写成伪代码/代码框架