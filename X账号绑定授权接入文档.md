# X（Twitter）账号绑定授权接入文档

> 本文档指导您完成 X（Twitter）企业账号与客服工作台的绑定授权配置。绑定后，客服座席可在工作台中代企业客户收发私信、回复评论和提及。

---

## 前置准备

### 1. 注册 X 开发者账号

| 步骤 | 操作 | 说明 |
|------|------|------|
| 1 | 访问 [developer.x.com](https://developer.x.com) | 会跳转到 [console.x.com](https://console.x.com) |
| 2 | 用您的 X 账号登录 | 个人账号即可，无需企业认证 |
| 3 | 填写开发者申请表单 | 填写用途说明（见下方示例） |
| 4 | 等待审核通过 | 通常几分钟到几小时自动通过 |

**开发者申请表单填写示例：**

| 问题 | 建议回答 |
|------|----------|
| 你打算用 X API 做什么？ | Building a customer service platform that allows enterprise brands to receive and reply to DMs and mentions from their customers on X |
| 你的应用名称 | YourPlatform - X Customer Service Integration |
| 你的应用描述 | Multi-tenant customer service workbench with real-time X DM and mention monitoring |
| 你的网站 URL | `https://your-platform.com` |
| 你是否会用 API 发送推文/DM？ | Yes |
| 你是否会让其他用户授权你的应用？ | Yes |

### 2. 创建 OAuth 2.0 应用

登录 [console.x.com](https://console.x.com) 后：

1. 点击 **Create Project** → 输入项目名称（如 "Customer Service Platform"）
2. 在项目内 **Create App** → 输入应用名称（如 "X Channel Integration"）
3. 选择 **OAuth 2.0** 类型（不要选 OAuth 1.0a）
4. 设置 **App permissions** 为 **Read and write**
5. 配置 **Callback URL**：`https://your-platform.com/api/x/callback`（开发阶段可用 `http://localhost:3000/api/x/callback`）
6. 配置 **Website URL**：`https://your-platform.com`

### 3. 获取凭证

创建完成后，在 App 的 **Keys and tokens** 页面获取：

| 凭证 | 说明 | 用途 |
|------|------|------|
| **Client ID** | OAuth 2.0 专用，格式如 `<YOUR_CLIENT_ID>` | 构造授权 URL |
| **Client Secret** | ⚠️ 仅显示一次，立即保存 | 后端换取 Token |
| **Bearer Token** | App-only，用于 Webhook 注册等 | 应用级 API 调用 |

> ⚠️ **Client Secret 只显示一次**，创建后无法再查看，只能重新生成。务必立即安全保存。

### 4. 配置环境变量

在项目根目录创建 `.env` 文件：

```bash
# X Developer Portal OAuth 2.0 凭证
CLIENT_ID=你的Client_ID
CLIENT_SECRET=你的Client_Secret

# OAuth 回调地址（需与 Developer Portal 中配置一致）
CALLBACK_URL=https://your-platform.com/api/x/callback

# 服务端口
PORT=3000

# 授权 Scope
SCOPE=dm.read dm.write tweet.read tweet.write users.read offline.access
```

---

## OAuth 2.0 PKCE 授权流程

### 流程概览

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  1. 生成     │     │  2. 用户     │     │  3. 换取     │     │  4. 获取     │
│  PKCE 参数   │ ──→ │  X 授权     │ ──→ │  Token      │ ──→ │  用户信息    │
│  code_verifier│     │  登录授权   │     │  access_token│     │  绑定完成    │
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘
```

### Step 1：生成 PKCE 参数

前端生成 `code_verifier`（随机字符串）和 `code_challenge`（SHA256 哈希）：

```javascript
// 生成 code_verifier（43-128 字符的随机字符串）
function generateCodeVerifier() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode(...array))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// 生成 code_challenge（S256 方式）
async function generateCodeChallenge(verifier) {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
```

### Step 2：构造授权 URL 并跳转

```javascript
const params = new URLSearchParams({
  response_type: 'code',
  client_id: '你的Client_ID',
  redirect_uri: 'https://your-platform.com/api/x/callback',
  scope: 'dm.read dm.write tweet.read tweet.write users.read offline.access',
  state: '随机状态字符串',  // 防 CSRF
  code_challenge: codeChallenge,
  code_challenge_method: 'S256',
});

const authUrl = `https://x.com/i/oauth2/authorize?${params.toString()}`;
// 跳转到此 URL，用户在 X 官方页面登录并授权
```

**授权 URL 示例：**
```
https://x.com/i/oauth2/authorize?response_type=code&client_id=<YOUR_CLIENT_ID>&redirect_uri=https%3A%2F%2Fyour-platform.com%2Fapi%2Fx%2Fcallback&scope=dm.read+dm.write+tweet.read+tweet.write+users.read+offline.access&state=abc123&code_challenge=xxx&code_challenge_method=S256
```

### Step 3：处理回调，换取 Token

用户在 X 页面授权后，X 会重定向到您的回调地址，携带 `code` 和 `state` 参数：

```
https://your-platform.com/api/x/callback?code=xxx&state=abc123
```

后端用 `code` + `code_verifier` 换取 Token：

```javascript
// POST https://api.x.com/2/oauth2/token
const tokenRes = await fetch('https://api.x.com/2/oauth2/token', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Authorization': 'Basic ' + btoa(`${CLIENT_ID}:${CLIENT_SECRET}`),
  },
  body: new URLSearchParams({
    grant_type: 'authorization_code',
    code: '回调中的code参数',
    redirect_uri: '你的回调地址',
    code_verifier: 'Step1中生成的code_verifier',
  }),
});

const tokens = await tokenRes.json();
// 返回：
// {
//   access_token: "xxx",
//   refresh_token: "xxx",  // 需要 offline.access scope
//   expires_in: 7200,       // 2小时
//   scope: "dm.read dm.write ...",
//   token_type: "bearer"
// }
```

### Step 4：获取用户信息

```javascript
const userRes = await fetch('https://api.x.com/2/users/me?user.fields=profile_image_url,description,public_metrics', {
  headers: { 'Authorization': `Bearer ${tokens.access_token}` },
});

const userData = await userRes.json();
// 返回：
// {
//   data: {
//     id: "2046970020232830976",
//     username: "your_username",
//     name: "Your Display Name",
//     profile_image_url: "https://...",
//     description: "Bio text",
//     public_metrics: { followers_count: 100, following_count: 50, ... }
//   }
// }
```

---

## Token 管理

### Token 生命周期

| Token | 有效期 | 说明 |
|-------|--------|------|
| Access Token | **2 小时** | 用于调用 API |
| Refresh Token | **长期有效** | 用于静默续期 Access Token（需 `offline.access` scope） |

### 自动续期

```javascript
// 用 refresh_token 获取新的 access_token
const refreshRes = await fetch('https://api.x.com/2/oauth2/token', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Authorization': 'Basic ' + btoa(`${CLIENT_ID}:${CLIENT_SECRET}`),
  },
  body: new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: '存储的refresh_token',
  }),
});

const newTokens = await refreshRes.json();
// 返回新的 access_token 和 refresh_token
// 更新存储，旧 token 立即失效
```

### 最佳实践

1. **安全存储**：Token 必须加密存储在数据库中，不得暴露给前端
2. **自动续期**：在 Access Token 过期前（如剩余 30 分钟）主动刷新
3. **错误处理**：Token 失效时（HTTP 401），自动尝试刷新；刷新失败则提示用户重新授权
4. **并发控制**：刷新 Token 时加锁，避免多个请求同时刷新导致 token 冲突

---

## 授权 Scope 说明

| Scope | 说明 | 是否必需 |
|-------|------|----------|
| `dm.read` | 读取私信 | ✅ 必需 |
| `dm.write` | 发送私信 | ✅ 必需 |
| `tweet.read` | 读取推文 | ✅ 必需（读取评论/提及） |
| `tweet.write` | 发送推文/回复 | ✅ 必需（回复评论） |
| `users.read` | 读取用户信息 | ✅ 必需（获取绑定账号信息） |
| `offline.access` | 获取 Refresh Token | ✅ 必需（自动续期） |

> ⚠️ `dm.read` 和 `dm.write` 必须成对申请，否则授权会失败。

---

## 后端 API 接口

### 发起授权

```
GET /api/x/auth
```

**响应：**
```json
{
  "authUrl": "https://x.com/i/oauth2/authorize?...",
  "state": "随机状态字符串"
}
```

**前端处理：** 跳转到 `authUrl`，用户在 X 页面完成授权后自动回调。

### OAuth 回调

```
GET /api/x/callback?code=xxx&state=xxx
```

**处理逻辑：**
1. 校验 `state` 参数
2. 用 `code` + `code_verifier` 换取 Token
3. 用 `access_token` 获取用户信息
4. 存储绑定关系
5. 重定向到前端页面

### 查询绑定状态

```
GET /api/x/status?user_id=xxx
```

**响应：**
```json
{
  "bound": true,
  "user": {
    "id": "2046970020232830976",
    "username": "your_username",
    "name": "Your Name",
    "avatar": "https://...",
    "followers": 100,
    "following": 50
  },
  "boundAt": "2026-07-22T10:00:00.000Z",
  "tokenStatus": "active",
  "expiresAt": "2026-07-22T12:00:00.000Z",
  "scope": "dm.read dm.write tweet.read tweet.write users.read offline.access"
}
```

### 刷新 Token

```
POST /api/x/refresh
Content-Type: application/json

{
  "user_id": "2046970020232830976"
}
```

**响应：**
```json
{
  "success": true,
  "expiresAt": "2026-07-22T14:00:00.000Z"
}
```

### 解绑账号

```
POST /api/x/unbind
Content-Type: application/json

{
  "user_id": "2046970020232830976"
}
```

**响应：**
```json
{
  "success": true
}
```

---

## 部署注意事项

### 回调地址配置

| 环境 | 回调地址 | Developer Portal 配置 |
|------|----------|----------------------|
| 开发 | `http://localhost:3000/api/x/callback` | 需在 Portal 中添加此地址 |
| 生产 | `https://your-domain.com/api/x/callback` | 需在 Portal 中添加此地址 |

> ⚠️ 回调地址必须与 Developer Portal 中配置的 **完全一致**（包括协议、域名、路径），否则授权会失败。

### HTTPS 要求

- 生产环境 **必须使用 HTTPS**
- 开发环境可使用 HTTP（localhost）

### 安全建议

1. **Client Secret 保密**：仅存储在后端环境变量中，不得暴露给前端
2. **State 参数校验**：防止 CSRF 攻击，每次授权生成随机 state 并校验
3. **Token 加密存储**：数据库中的 Token 必须加密
4. **定期轮换密钥**：定期在 Developer Portal 重新生成 Client Secret

---

## 常见问题

### Q: 授权页面显示 "Something went wrong"

**原因：** 回调地址不匹配
**解决：** 检查 Developer Portal 中配置的 Callback URL 与代码中的 `CALLBACK_URL` 是否完全一致

### Q: Token 换取失败 (401 Unauthorized)

**原因：** Client Secret 错误或已过期
**解决：** 在 Developer Portal 重新生成 Client Secret，更新 `.env` 文件

### Q: 获取用户信息失败 (403 Forbidden)

**原因：** Scope 不足
**解决：** 确保申请了 `users.read` scope，且用户在授权时同意了该权限

### Q: Refresh Token 为空

**原因：** 未申请 `offline.access` scope
**解决：** 在 `.env` 的 `SCOPE` 中添加 `offline.access`，重新授权

### Q: 企业客户需要注册开发者账号吗？

**不需要。** 企业客户只需有普通 X 账号，通过 OAuth 授权即可。开发者账号由平台方（您）注册和管理。

### Q: 授权会暴露 X 密码吗？

**不会。** OAuth 2.0 是在 X 官方页面完成登录和授权，您的平台只拿到 Token，永远看不到密码。

---

## 本地运行 Demo

```bash
# 1. 进入项目目录
cd x-binding-demo

# 2. 安装依赖
npm install

# 3. 配置环境变量
# 编辑 .env 文件，填入你的 Client ID 和 Client Secret

# 4. 启动服务
npm start

# 5. 访问 http://localhost:3000
```

---

## 参考链接

| 资源 | 链接 |
|------|------|
| X Developer Portal | [https://developer.x.com](https://developer.x.com) |
| X Developer Console | [https://console.x.com](https://console.x.com) |
| OAuth 2.0 文档 | [https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code](https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code) |
| X API v2 文档 | [https://docs.x.com/x-api](https://docs.x.com/x-api) |
| DM 管理文档 | [https://docs.x.com/x-api/direct-messages/manage/integrate](https://docs.x.com/x-api/direct-messages/manage/integrate) |
| 开发者应用文档 | [https://docs.x.com/fundamentals/developer-apps](https://docs.x.com/fundamentals/developer-apps) |
| X API 定价 | [https://docs.x.com/x-api/getting-started/pricing](https://docs.x.com/x-api/getting-started/pricing) |
