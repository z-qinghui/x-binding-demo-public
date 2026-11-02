# X (Twitter) 智能客服集成方案 Demo

基于 OAuth 2.0 PKCE 授权绑定企业 X 账号，通过 Webhook 实时接收私信和评论，支持新版 Chat 端到端加密私信的服务端解密（chat-xdk + Juicebox PIN）。

## 演示视频

[▶ 点击观看演示视频](demo%20%E6%BC%94%E7%A4%BA_chidimeru.mp4)

## 核心能力

- **OAuth 2.0 PKCE 账号绑定** — 3-legged 用户授权，Access/Refresh Token 自动续期
- **私信收发** — 旧版 DM（明文）+ 新版 Chat（E2EE）双体系自适应
- **Chat 加密私信服务端解密** — chat-xdk WASM + Juicebox PIN 恢复真机身份，webhook 实时解密
- **评论回复** — 监听 @提及（post.mention.create），通过 POST /2/tweets 回复

## 代码架构

```
x-binding-demo/
├── server.js                 # Express 主服务，所有 API 路由定义
├── lib/
│   ├── chat-crypto.js        # chat-xdk WASM 封装（Juicebox PIN 解密、加密/解密消息）
│   └── x-chat-api.js         # X Chat REST 客户端（基于 @xdevplatform/xdk）
├── public/
│   ├── index.html            # 前端 SPA（3 个页签：绑定 / 私信 / 评论）
│   ├── app.js                # 前端逻辑（轮询、事件渲染、自动解锁解密）
│   └── style.css             # 暗色主题样式
├── .env                      # 凭证配置（⚠️ 勿提交）
├── .data/
│   ├── state.json            # 绑定 + webhook 持久化（重启自动恢复）
│   └── webhook-events.log    # Webhook 原始推送日志（调试用）
├── start.sh                  # 启动脚本
├── stop.sh                   # 停止脚本
└── package.json
```

### 模块职责

| 模块                   | 职责                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| `server.js`          | Express 路由：OAuth 授权、Webhook CRC 校验/事件接收、DM 收发、Chat 解密、评论回复、Token 刷新 |
| `lib/chat-crypto.js` | 封装`@xdevplatform/chat-xdk` WASM 引擎：Juicebox PIN 解锁真机身份、批量/单条解密、消息加密  |
| `lib/x-chat-api.js`  | 封装`@xdevplatform/xdk` Client：拉取加密事件、获取公钥、发送加密消息、获取 Juicebox 配置    |
| `public/app.js`      | 前端 SPA 逻辑：页面切换、OAuth 回调处理、轮询本地事件、自动解锁 Chat 身份、渲染消息/提及列表  |

## 关键功能实现逻辑

### 1. OAuth 2.0 PKCE 账号绑定

```
前端 → GET /api/x/auth
  ├─ 生成 code_verifier (32字节随机) + code_challenge (SHA256)
  ├─ 临时存储 code_verifier（内存，5 分钟过期）
  └─ 返回 X 授权 URL → 用户在 X 登录授权

X 回调 → GET /api/x/callback?code=xxx&state=xxx
  ├─ 校验 state，取出 code_verifier
  ├─ POST https://api.x.com/2/oauth2/token（authorization_code + code_verifier）
  ├─ 用 access_token 调 GET /2/users/me 获取用户信息
  ├─ 绑定信息写入 bindingStore（内存）+ 持久化到 .data/state.json
  └─ 重定向前端 ?bound=true&user_id=xxx
```

### 2. Webhook 事件接收 — 旧 DM / 新 Chat 双体系自适应

```
X 推送 → POST /api/x/webhook
  ├─ 解析 XAA 信封：event.data.event_type + event.data.payload
  ├─ dm.received / dm.sent → 旧版 DM，payload 含明文 direct_message_events
  ├─ chat.received / chat.sent → 新版 Chat E2EE
  │   ├─ payload.encoded_event 为密文（base64）
  │   ├─ 入库占位（text=null, encrypted=true）
  │   └─ 异步调用 decryptChatEvent() → chat-xdk 解密回填明文
  └─ post.mention.create / post.create → 提及/评论事件入库
```

### 3. Chat E2EE 服务端解密（核心）

```
decryptChatEvent(userId, { encodedEvent, keyChangeEvent, senderId })
  │
  ├─ 1. getChatCrypto(userId) — 获取已解锁的 ChatCrypto 实例
  │     ├─ 已缓存 → 直接返回
  │     └─ 未解锁 → Juicebox 流程：
  │           ├─ XChatApi.getJuiceboxConfig(userId)
  │           │     └─ GET /2/users/{id}/public_keys → 取含 juicebox_config 的最新版本
  │           ├─ ChatCrypto.createWithJuicebox(config)
  │           │     └─ createChat({ juiceboxConfig, getAuthToken }) → WASM 实例
  │           ├─ cc.unlock(pin) — 用 .env 的 XCHAT_PIN 从 Juicebox 恢复真机私钥
  │           ├─ cc.setIdentity(userId, version) — 设置默认发送者
  │           ├─ cc.setCacheKeys(true) — 缓存会话密钥
  │           ├─ cc.setRejectUnverified(false) — 放宽验签（demo 权衡）
  │           └─ cc.registerSelfSigningKey(userId, version) — 登记自身公钥
  │
  ├─ 2. 登记会话双方全部签名公钥
  │     ├─ 并行拉取 sender + self 的 public_keys
  │     └─ cc.addSigningKeys(userId, entries) — 按 userId 去重合并
  │
  └─ 3. cc.decryptBatch([keyChangeEvent?, encodedEvent])
        ├─ SDK 自动从 key_change 提取会话密钥
        └─ 返回明文 { text, decrypted, verified }
```

**关键踩坑点：**

- Juicebox config token 一次性使用，重复 unlock 抛 UTF-8 错误 → 用 `chatUnlockInflight` Map 防并发
- `public_key_version` 必须与 `juicebox_config` 同源（原始 fetch，非 xdk camelCase 转换）
- key change 常引用未在公钥接口返回的签名版本 → `setRejectUnverified(false)` 降级解密

### 4. 私信回复发送 — Demo 统一走旧版 DM 端点（重要）⚠️

**Demo 现状**：所有私信回复（无论对方是旧版 DM 还是新版 Chat 加密会话）都走**同一条发送链路**——旧版 DM 明文端点，**未实现新版 Chat 加密发送（`chat.sent`）**。

```
前端「回复」→ sendDmForUser() → POST /api/x/dm/send
  ├─ body: { user_id, participant_id, text }
  ├─ 自动刷新过期 token
  └─ POST https://api.x.com/2/dm_conversations/with/:participant_id/messages
       body: { text }          # 纯明文，无加密
```

- 发送侧**没有** `encryptMessage`、**没有**调用 `POST /2/chat/conversations/:id/messages`。
- 即：**收（chat.received 密文，chat-xdk 解密）与 发（dm.send 明文）走两套不对称的路径**。

#### 今日发现（2026-08-07 实测）

对一个**新版 Chat 加密会话**，用旧版 DM 端点发送**明文**回复，实测行为如下：

| 观察点                           | 实测结论                                                                                                   |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 明文回复是否可达对方             | ✅**可达**：`nanfang721 →` `Qinghui2026888` 回复"你好啊"，对方 X 客户端在同一会话内正常收到明文 |
| 发送方是否加密                   | ❌ 未加密（走`dm.send`，不是 `chat.sent`）                                                             |
| 事件形态                         | 收到`chat.received`（密文占位/解密后明文），回复以旧版明文 DM 发出——**加密不对称**               |
| X 服务端如何桥接明文到 Chat 会话 | ⚠️ 官方文档未说明，无法证实内部机制，仅确认"发得出、对方收得到、明文可读"的端到端结果                    |

> **结论**：Demo 私信回复目前"**功能可用但加密不对称**"。若要标准化（收密文即回密文、保持端到端加密对称），需补齐 `chat.sent` 加密发送（`encryptMessage` + `POST /2/chat/conversations/:id/messages`），此为待补齐项，非当前 Demo 已实现能力。

### 5. 评论回复

```
前端点击「回复」→ POST /api/x/tweets/reply
  ├─ body: { user_id, in_reply_to_tweet_id, text }
  ├─ 自动刷新过期 token
  └─ POST https://api.x.com/2/tweets
       body: { text, reply: { in_reply_to_tweet_id } }
```

## API 路由表

### 账号绑定

| Method | 端点                       | 说明                             |
| ------ | -------------------------- | -------------------------------- |
| GET    | `/api/x/auth`            | 发起 OAuth 授权，返回 X 登录 URL |
| GET    | `/api/x/callback`        | OAuth 回调，code 换 token        |
| GET    | `/api/x/status?user_id=` | 查询绑定状态                     |
| POST   | `/api/x/refresh`         | 刷新 Access Token                |
| POST   | `/api/x/unbind`          | 解绑单个账号                     |
| POST   | `/api/x/unbind-all`      | 一键解绑所有（演示用）           |
| GET    | `/api/x/bindings`        | 列出所有绑定                     |

### 私信 & Chat

| Method | 端点                                 | 说明                      |
| ------ | ------------------------------------ | ------------------------- |
| POST   | `/api/x/webhook/register`          | 注册 Webhook URL          |
| GET    | `/api/x/webhooks`                  | 列出已注册 Webhook        |
| PUT    | `/api/x/webhook/:id/validate`      | 重新验证 Webhook          |
| DELETE | `/api/x/webhook/:id`               | 删除 Webhook              |
| POST   | `/api/x/webhook/subscribe`         | 订阅 DM 事件              |
| POST   | `/api/x/dm/send`                   | 发送私信（旧版 DM）       |
| GET    | `/api/x/dm/events`                 | 拉取 DM 事件历史          |
| GET    | `/api/x/dm/local-events`           | 本地缓存的 Webhook 事件   |
| POST   | `/api/x/chat/unlock`               | Juicebox PIN 解锁真机身份 |
| GET    | `/api/x/chat/identity-status`      | 查询解锁状态              |
| POST   | `/api/x/chat/decrypt-conversation` | 手动解密整个会话          |
| GET    | `/api/x/chat/local-events`         | 已解密的 Chat 事件        |

### 评论回复

| Method | 端点                             | 说明                     |
| ------ | -------------------------------- | ------------------------ |
| POST   | `/api/x/activity/subscribe`    | 订阅提及/评论事件        |
| POST   | `/api/x/tweets/reply`          | 发送评论回复             |
| GET    | `/api/x/mentions`              | 查询近期提及（轮询兜底） |
| GET    | `/api/x/mentions/local-events` | 本地缓存的提及事件       |

### 用户查询

| Method | 端点                                   | 说明             |
| ------ | -------------------------------------- | ---------------- |
| GET    | `/api/x/users/by/username/:username` | 按用户名查用户   |
| GET    | `/api/x/users/:id`                   | 按 userId 查用户 |

## 环境变量

在 `.env` 中配置（参考 `.env.example` 或下方说明）：

| 变量              | 必填 | 说明                                                                                    |
| ----------------- | ---- | --------------------------------------------------------------------------------------- |
| `CLIENT_ID`     | ✅   | X Developer Portal OAuth 2.0 Client ID                                                  |
| `CLIENT_SECRET` | ✅   | OAuth 2.0 Client Secret                                                                 |
| `CALLBACK_URL`  | ✅   | OAuth 回调地址（如`http://localhost:3000/api/x/callback`）                            |
| `PORT`          |      | 服务端口，默认 3000                                                                     |
| `SCOPE`         | ✅   | OAuth 授权范围，如`dm.read dm.write tweet.read tweet.write users.read offline.access` |
| `BEARER_TOKEN`  | ✅   | App-Only Bearer Token（Webhook 注册等应用级 API）                                       |
| `WEBHOOK_URL`   | ✅   | Webhook 公网 HTTPS 地址（本地用 ngrok）                                                 |
| `CRC_SECRET`    | ✅   | CRC 校验密钥（Consumer Secret Key，非 Client Secret）                                   |
| `XCHAT_PIN`     |      | Chat E2EE 解密 PIN（4 位数字，不配则不解密 Chat）                                       |

## 启动 / 停止

### 方式一：脚本启动（推荐）

```bash
# 首次启动（自动安装依赖）
bash start.sh

# 停止服务
bash stop.sh

# 重启
bash stop.sh && bash start.sh
```

### 方式二：npm 启动

```bash
npm install    # 首次安装依赖
npm start      # 前台启动（Ctrl+C 停止）
```

### 方式三：手动后台运行

```bash
node server.js &          # 后台启动
echo $! > .data/server.pid  # 记录 PID
# 停止
kill $(cat .data/server.pid)
```

## 前置条件

1. **Node.js** >= 18（需支持原生 `fetch`）
2. **X Developer Portal** 应用配置：
   - 创建 Project + App
   - 启用 OAuth 2.0（Type of App: Web App）
   - App permissions: `Read and write and Direct messages`
   - Callback URL: `http://localhost:3000/api/x/callback`
3. **ngrok**（本地开发）：`ngrok http 3000`，将生成的地址填入 `.env` 的 `WEBHOOK_URL`

## 注意事项

- `.env` 和 `.data/` 包含敏感凭证，已加入 `.gitignore`，切勿提交
- `state.json` 含 access_token/refresh_token，生产环境应使用加密数据库
- Chat E2EE 解密需服务端持有 PIN，会削弱端到端保证，生产环境需评估合规风险
- Juicebox config token 一次性使用，重复 unlock 会失败
- DM 事件按量计费约 $0.010/条，仅保留最近 30 天
- Webhook 每小时 CRC 校验一次，需保持服务可达
