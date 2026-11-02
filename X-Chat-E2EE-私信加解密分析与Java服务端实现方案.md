# X Chat E2EE 私信加解密分析与 Java 服务端实现方案

> 基于 `x-binding-demo` 项目代码深度解读，评估服务端加解密可行性。

---

## 一、Demo 架构概览

### 1.1 技术栈

| 层 | 技术 |
|---|------|
| 运行时 | Node.js ≥ 18 |
| 服务端框架 | Express.js (CommonJS) |
| 前端 | 原生 JS SPA（无框架） |
| 加密引擎 | `@xdevplatform/chat-xdk` v0.4.3（WASM） |
| API 客户端 | `@xdevplatform/xdk` v0.6.6 |
| 密钥恢复 | `juicebox-sdk` v0.3.7 |

### 1.2 项目结构

```
x-binding-demo/
├── lib/
│   ├── chat-crypto.js      ← 核心 E2EE 加解密模块
│   └── x-chat-api.js       ← X Chat REST API 客户端
├── public/
│   ├── app.js              ← 前端 SPA（纯展示，无加密逻辑）
│   └── index.html
├── server.js               ← Express 服务端（所有 API 路由）
└── .env                    ← 配置 XCHAT_PIN 等
```

---

## 二、私信解密（收消息）代码实现详解

### 2.1 整体流程

```
X App 推送 webhook (chat.received + encoded_event)
  → server.js 存入内存（text=null, encrypted=true）
  → getChatCrypto(userId): 解锁用户身份
  → 拉取双方签名公钥
  → chat-xdk WASM 引擎解密
  → 回填明文到内存记录
  → 前端轮询 /api/x/chat/local-events 展示
```

### 2.2 第一步：身份解锁（Juicebox PIN 恢复）

X 新版 Chat 使用端到端加密，每个用户有一个**设备身份密钥**。Demo 通过 Juicebox 密钥恢复协议，用 4 位 PIN 码恢复出真实的设备私钥。

**核心代码** — [server.js:1200-1255](server.js#L1200-L1255)：

```javascript
async function getChatCrypto(userId) {
  // 1. 检查内存缓存（已解锁实例可复用）
  if (chatCryptoCache.has(userId)) return chatCryptoCache.get(userId);

  // 2. 熔断机制：PIN 错误后停止重试，保护 Juicebox 猜测配额
  const blocked = chatUnlockBlocked.get(userId);
  if (blocked) throw new Error(blocked.reason);

  // 3. 读取环境变量中的 PIN
  const pin = process.env.XCHAT_PIN;

  // 4. 每次用新鲜的 juicebox_config（token 一次性，不可复用）
  const api = new XChatApi(binding.tokens.access_token);
  const jb = await api.getJuiceboxConfig(chatUserId);

  // 5. 创建 WASM 加密实例并解锁
  const cc = await ChatCrypto.createWithJuicebox(jb.config);
  await cc.unlock(pin);  // PIN 恢复设备私钥

  // 6. 配置身份与密钥缓存
  cc.setIdentity(chatUserId, latestVersion);
  cc.setCacheKeys(true);
  cc.setRejectUnverified(false);  // demo 模式放宽签名验证
  cc.registerSelfSigningKey(chatUserId, latestVersion);

  // 7. 缓存实例
  chatCryptoCache.set(userId, cc);
}
```

**关键点**：
- Juicebox 是一个密钥分割恢复协议，将设备密钥分片存储在多个服务器上
- 4 位 PIN 用于认证和恢复，有猜测次数限制（约 10 次）
- `juicebox_config` 包含 token_map，每次解锁需拉取新鲜配置（token 一次性）

### 2.3 第二步：签名公钥登记

解密前需登记会话双方的签名公钥，用于验证消息签名。

**核心代码** — [server.js:1301-1310](server.js#L1301-L1310)：

```javascript
async function ensureSigningKeys(cc, api, senderId) {
  if (!senderId || cc.hasSigningKeysFor(senderId)) return;
  const pks = await api.getPublicKeys(senderId);  // 调用 X API
  const entries = pks.map((pk) => toSigningKeyEntry(senderId, pk));
  cc.addSigningKeys(senderId, entries);
}
```

公钥格式转换 — [x-chat-api.js:95-104](lib/x-chat-api.js#L95-L104)：

```javascript
function toSigningKeyEntry(userId, pk) {
  return {
    userId: String(userId),
    publicKeyVersion: String(pk.public_key_version),
    publicKey: pk.signing_public_key,           // 签名公钥
    identityPublicKey: pk.public_key,           // 身份公钥
    identityPublicKeySignature: pk.identity_public_key_signature,
  };
}
```

### 2.4 第三步：WASM 引擎解密

**核心代码** — [server.js:1318-1374](server.js#L1318-L1374)：

```javascript
async function decryptChatEvent(userId, { encodedEvent, keyChangeEvent, senderId, signatureInfo }) {
  const cc = await getChatCrypto(userId);

  // 并行拉取双方公钥
  const [senderPks, myPks] = await Promise.all([
    api.getPublicKeys(senderId),
    api.getPublicKeys(selfId),
  ]);
  cc.addSigningKeys(senderId, senderPks.map(pk => toSigningKeyEntry(senderId, pk)));
  cc.addSigningKeys(selfId, myPks.map(pk => toSigningKeyEntry(selfId, pk)));

  // 关键：用批量路径解密，喂入 [key_change, message]
  // SDK 自动从 key_change 提取会话密钥，再解密消息
  const batchIn = [];
  if (keyChangeEvent) batchIn.push(keyChangeEvent);
  batchIn.push(encodedEvent);
  const result = cc.decryptBatch(batchIn);  // ← WASM 解密核心调用

  const msg = result.messages.find(m => m.event?.type === "message");
  return {
    text: msg.event.content.text,     // 明文
    decrypted: true,
    verified: msg.verified,           // 签名验证状态
  };
}
```

### 2.5 第四步：Webhook 接收与异步解密

**核心代码** — [server.js:432-488](server.js#L432-L488)：

```javascript
// chat.received 事件：先入库占位，再异步解密
if (isChat && !dmEvents.length) {
  const encodedEvent = payload.encoded_event;
  const keyChangeEvent = payload.conversation_key_change_event;

  // 先存入内存（text=null, encrypted=true）
  const record = {
    id: payload.id,
    type: eventType,
    senderId: payload.sender_id,
    text: null,
    encrypted: true,
    decrypted: false,
    encodedEvent,  // 保留密文
  };
  dmEventStore.unshift(record);

  // 异步解密回填
  if (dmOwnerUserId && encodedEvent) {
    decryptChatEvent(dmOwnerUserId, {
      encodedEvent,
      keyChangeEvent,
      senderId: payload.sender_id,
      signatureInfo: payload.message_event_signature,
    }).then((r) => {
      if (r.decrypted) {
        record.text = r.text;
        record.decrypted = true;
      }
    });
  }
}
```

---

## 三、私信加密（发消息）代码实现详解

### 3.1 现状：Demo 未使用加密发送

Demo 的发消息路由 `/api/x/dm/send` 使用的是**旧版明文 DM API**，并未调用加密发送：

**server.js:928-970** — 发送路由：

```javascript
app.post("/api/x/dm/send", async (req, res) => {
  // 使用旧版明文 DM 端点
  const resp = await fetch("https://api.x.com/2/dm_conversations/with/.../messages", {
    method: "POST",
    body: JSON.stringify({ text: { text: message } }),  // 明文！
  });
});
```

### 3.2 加密发送能力已实现但未接入

`ChatCrypto` 类中加密方法已完整实现 — [chat-crypto.js:228-238](lib/chat-crypto.js#L228-L238)：

```javascript
encryptMessage({ conversationId, text, replyToEvent }) {
  const params = { conversationId, text };
  const payload = replyToEvent
    ? this.#chat.encryptReply({ ...params, replyToEvent })
    : this.#chat.encryptMessage(params);
  return {
    message_id: payload.messageId,
    encoded_message_create_event: payload.encryptedContent,       // 密文
    encoded_message_event_signature: payload.encodedEventSignature, // 签名
  };
}
```

`XChatApi.sendMessage` 也已封装 — [x-chat-api.js:54-61](lib/x-chat-api.js#L54-L61)：

```javascript
async sendMessage(conversationId, body) {
  return this.client.chat.sendMessage(pathConversationId(conversationId), {
    messageId: body.message_id,
    encodedMessageCreateEvent: body.encoded_message_create_event,
    encodedMessageEventSignature: body.encoded_message_event_signature,
    conversationToken: body.conversation_token,
  });
}
```

### 3.3 加密发送完整流程（理论路径）

```
1. getChatCrypto(userId) → 获取已解锁的加密实例
2. cc.encryptMessage({ conversationId, text }) → 产出密文 + 签名
3. xChatApi.sendMessage(conversationId, encryptedBody) → 提交到 X Chat API
```

首次与对方通信前还需会话密钥交换：

```javascript
// 准备密钥交换
const keyChange = cc.prepareConversationKeyChange([{
  userId: targetUserId,
  publicKey: targetPublicKey,
  keyVersion: targetKeyVersion,
}]);
await xChatApi.addConversationKeys(conversationId, keyChange);
```

---

## 四、Demo 是否真的服务端实现？

### 4.1 结论：是的，加解密完全在服务端

| 维度 | 实现位置 | 说明 |
|------|---------|------|
| **解密** | Node.js 服务端 ✅ | WASM 引擎在服务端进程内运行，PIN 在服务端内存中使用 |
| **加密** | 服务端已实现但未接入 | `encryptMessage()` 存在但 `/api/x/dm/send` 绕过了它 |
| **前端** | 纯展示层 | 仅轮询 `/api/x/chat/local-events` 展示已解密的明文 |
| **密钥管理** | 服务端内存 | `chatCryptoCache` Map 缓存已解锁实例，进程重启丢失 |

### 4.2 安全考量

Demo 的安全模型**有意弱化**了 E2EE 保证：

1. **PIN 存储在 `.env` 文件**：服务端持有 PIN 即可恢复设备私钥，理论上可解密所有消息
2. **`setRejectUnverified(false)`**：放宽签名验证，demo 模式下仍解密签名不匹配的消息
3. **明文发送**：发消息走旧版 API，未加密
4. **内存缓存无持久化**：进程重启需重新解锁

---

## 五、Java 服务端实现可行性评估

### 5.1 核心挑战：WASM 依赖

`@xdevplatform/chat-xdk` 的加密引擎是**编译为 WASM 的 Rust 代码**，这是 Java 实现的最大障碍。

| 能力 | Node.js (Demo) | Java 可行性 | 难度 |
|------|---------------|------------|------|
| Juicebox PIN 恢复 | `juicebox-sdk` (JS) | 需 Java 移植或 HTTP 调用 | ⭐⭐⭐ 高 |
| 消息加密/解密 | `chat-xdk` (WASM) | 需 WASM 运行时或原生移植 | ⭐⭐⭐⭐ 极高 |
| 会话密钥管理 | SDK 内部自动 | 需理解底层协议 | ⭐⭐⭐ 高 |
| X API 调用 | `@xdevplatform/xdk` (JS) | REST API，Java 直接调用 | ⭐ 低 |
| 签名验证 | SDK 内部 | 需理解签名格式 | ⭐⭐ 中 |

### 5.2 四种 Java 实现路径

#### 路径 A：Node.js 微服务桥接（推荐 ⭐⭐⭐⭐⭐）

**架构**：Java 主服务 + Node.js 加解密微服务

```
┌─────────────────────┐     HTTP/gRPC      ┌──────────────────────┐
│   Java 主服务        │ ◄──────────────► │  Node.js E2EE 服务    │
│   - 业务逻辑         │                   │  - chat-xdk (WASM)   │
│   - 消息路由         │                   │  - juicebox-sdk      │
│   - 数据持久化       │                   │  - 加解密 API         │
└─────────────────────┘                   └──────────────────────┘
```

**Node.js 微服务 API 设计**：

```javascript
// POST /decrypt-event
// 请求：{ userId, encodedEvent, keyChangeEvent, senderId, signatureInfo }
// 响应：{ text, decrypted, verified }

// POST /encrypt-message
// 请求：{ userId, conversationId, text, replyToEvent? }
// 响应：{ message_id, encoded_message_create_event, encoded_message_event_signature }

// POST /unlock
// 请求：{ userId, pin }
// 响应：{ success, unlocked }

// POST /prepare-key-change
// 请求：{ userId, publicKeys, conversationId? }
// 响应：{ keyChangePayload }
```

**优点**：
- 复用 X 官方 SDK，零加密算法移植风险
- 最快上线（1-2 周）
- 官方 SDK 更新时只需升级 npm 依赖

**缺点**：
- 多一个服务运维
- PIN 和密钥经过网络传输（需 mTLS 保护）
- 增加约 50-100ms 延迟

---

#### 路径 B：Java 内嵌 GraalVM WASM 运行时（⭐⭐⭐）

**架构**：Java 进程内通过 GraalVM 的 WASM 支持直接运行 chat-xdk WASM

```java
// 使用 GraalVM 的 polyglot API 加载 WASM
import org.graalvm.polyglot.*;

Context context = Context.newBuilder("wasm")
    .option("wasm.MemoryPages", "16")
    .build();
Source wasmSource = Source.newBuilder("wasm",
    new File("chat_xdk_wasm_bg.wasm")).build();
context.eval(wasmSource);

// 调用 WASM 导出函数
Value decryptEvent = context.getBindings("wasm").getMember("decrypt_event");
```

**优点**：
- 单一 Java 进程
- 无网络开销

**缺点**：
- GraalVM WASM 支持尚不成熟，JS-WASM 互操作复杂
- chat-xdk 的 WASM 模块依赖 JS 胶水代码（`chat_xdk_wasm.js`），需在 GraalVM 中同时运行 JS 和 WASM
- Juicebox SDK 仍需移植
- 调试困难，兼容性风险高

---

#### 路径 C：JNI 调用原生库（⭐⭐）

**架构**：将 chat-xdk 的 Rust 源码编译为原生 `.so`/`.dylib`，通过 JNI 调用

```java
public class ChatCryptoNative {
    static { System.loadLibrary("chat_xdk"); }

    // JNI 方法声明
    public static native byte[] decryptEvent(byte[] encodedEvent, byte[] keyChangeEvent);
    public static native byte[] encryptMessage(String conversationId, String text);
    public static native boolean unlock(String pin, byte[] juiceboxConfig);
}
```

Rust 侧编译为 `cdylib`：

```rust
#[no_mangle]
pub extern "C" fn decrypt_event(encoded: *const u8, len: usize) -> *mut u8 {
    // 调用 chat-xdk 内部逻辑
}
```

**优点**：
- 零 GC 开销，高性能
- 原生代码直接调用

**缺点**：
- 需深入理解 chat-xdk Rust 源码（非公开文档）
- 跨平台编译负担
- JNI 开发维护成本高

---

#### 路径 D：纯 Java 移植加密协议（⭐）

**架构**：完全用 Java 重写 E2EE 协议栈

**需要实现**：
1. Juicebox 密钥恢复协议（Shamir 秘密分享 + VRF）
2. X3DH 密钥协商协议
3. Double Ratchet 消息加密
4. Ed25519 / X25519 签名与密钥交换
5. Protobuf 序列化/反序列化

```java
// 示例：使用 Signal Protocol 的 Java 移植
public class XChatE2EE {
    private IdentityKeyPair identityKeyPair;
    private SignedPreKey signedPreKey;
    private List<PreKey> oneTimePreKeys;

    public EncryptedMessage encrypt(String conversationId, String plaintext) {
        SessionCipher cipher = new SessionCipher(sessionStore, address);
        CiphertextMessage msg = cipher.encrypt(plaintext.getBytes());
        return new EncryptedMessage(msg.serialize(), sign(msg.serialize()));
    }

    public String decrypt(byte[] encodedEvent) {
        SignalMessage signalMsg = new SignalMessage(encodedEvent);
        SessionCipher cipher = new SessionCipher(sessionStore, address);
        byte[] plaintext = cipher.decrypt(signalMsg);
        return new String(plaintext);
    }
}
```

**优点**：
- 完全自主可控
- 无外部依赖

**缺点**：
- 工作量巨大（3-6 个月）
- 需逆向 X 的私有协议扩展
- 官方协议变更时维护滞后
- 安全审计成本高

---

### 5.3 推荐方案：路径 A — Node.js 微服务桥接

#### 架构详图

```
┌─────────────────────────────────────────────────────────────┐
│                        Java 主服务 (Spring Boot)             │
│                                                             │
│  ┌───────────┐  ┌──────────────┐  ┌──────────────────────┐ │
│  │ Webhook   │  │ 消息业务逻辑  │  │ X OAuth2 认证管理     │ │
│  │ Controller│  │              │  │                      │ │
│  └─────┬─────┘  └──────┬───────┘  └──────────────────────┘ │
│        │               │                                    │
│        ▼               ▼                                    │
│  ┌─────────────────────────────────────────────────────────┐│
│  │              E2EE Bridge Client                         ││
│  │  - HTTP 调用 Node.js 微服务                              ││
│  │  - 连接池管理                                            ││
│  │  - 重试与熔断                                            ││
│  └─────────────────────────┬───────────────────────────────┘│
│                            │                                │
└────────────────────────────┼────────────────────────────────┘
                             │ HTTP (mTLS)
                             ▼
┌─────────────────────────────────────────────────────────────┐
│                  Node.js E2EE 微服务                         │
│                                                             │
│  ┌──────────────────┐  ┌──────────────────────────────────┐│
│  │ 加解密 API        │  │ chat-xdk WASM + juicebox-sdk    ││
│  │ POST /decrypt     │  │ - 密钥恢复                       ││
│  │ POST /encrypt     │  │ - 消息加解密                     ││
│  │ POST /unlock      │  │ - 会话密钥管理                   ││
│  │ POST /key-change  │  │                                  ││
│  └──────────────────┘  └──────────────────────────────────┘│
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

#### Java 端核心代码

**E2EE Bridge Client**：

```java
@Service
public class E2EEBridgeClient {

    private final WebClient webClient;
    private final CircuitBreaker circuitBreaker;

    public E2EEBridgeClient(
        @Value("${e2ee.bridge.url}") String bridgeUrl,
        CircuitBreakerFactory cbFactory
    ) {
        this.webClient = WebClient.builder()
            .baseUrl(bridgeUrl)
            .defaultHeader("Content-Type", "application/json")
            .build();
        this.circuitBreaker = cbFactory.create("e2ee-bridge");
    }

    /**
     * 解密单条 Chat 事件
     */
    public Mono<DecryptionResult> decryptEvent(String userId, EncryptedEvent event) {
        return circuitBreaker.run(
            webClient.post()
                .uri("/decrypt-event")
                .bodyValue(Map.of(
                    "userId", userId,
                    "encodedEvent", event.encodedEvent(),
                    "keyChangeEvent", event.keyChangeEvent(),
                    "senderId", event.senderId(),
                    "signatureInfo", event.signatureInfo()
                ))
                .retrieve()
                .bodyToMono(DecryptionResult.class),
            throwable -> Mono.just(DecryptionResult.failed(throwable.getMessage()))
        );
    }

    /**
     * 加密消息
     */
    public Mono<EncryptedMessage> encryptMessage(
        String userId, String conversationId, String text
    ) {
        return webClient.post()
            .uri("/encrypt-message")
            .bodyValue(Map.of(
                "userId", userId,
                "conversationId", conversationId,
                "text", text
            ))
            .retrieve()
            .bodyToMono(EncryptedMessage.class);
    }

    /**
     * 解锁用户身份（Juicebox PIN）
     */
    public Mono<UnlockResult> unlockIdentity(String userId) {
        return webClient.post()
            .uri("/unlock")
            .bodyValue(Map.of("userId", userId))
            .retrieve()
            .bodyToMono(UnlockResult.class);
    }
}
```

**Webhook Controller**：

```java
@RestController
@RequestMapping("/api/x/webhook")
public class XWebhookController {

    private final E2EEBridgeClient e2eeClient;
    private final MessageService messageService;

    @PostMapping
    public ResponseEntity<Map<String, Object>> handleWebhook(
        @RequestBody WebhookPayload payload,
        @RequestHeader(value = "x-twitter-webhooks-signature", required = false) String signature
    ) {
        String eventType = payload.getEventType();

        if ("chat.received".equals(eventType) || "chat.sent".equals(eventType)) {
            // 先存储加密事件
            MessageRecord record = messageService.storeEncrypted(payload);

            // 异步解密
            e2eeClient.decryptEvent(payload.getOwnerUserId(), payload.toEncryptedEvent())
                .subscribe(result -> {
                    if (result.isDecrypted()) {
                        messageService.updateDecrypted(record.getId(), result.getText());
                    }
                });
        }

        return ResponseEntity.ok(Map.of("ok", true));
    }
}
```

**数据模型**：

```java
public record DecryptionResult(
    String text,
    boolean decrypted,
    boolean verified,
    String reason
) {
    public static DecryptionResult failed(String reason) {
        return new DecryptionResult(null, false, false, reason);
    }
}

public record EncryptedMessage(
    String messageId,
    String encodedMessageCreateEvent,
    String encodedMessageEventSignature
) {}

public record EncryptedEvent(
    String encodedEvent,
    String keyChangeEvent,
    String senderId,
    Object signatureInfo
) {}
```

#### Node.js 微服务端代码

基于 Demo 代码精简，仅暴露加解密 API：

```javascript
const express = require('express');
const { ChatCrypto } = require('./lib/chat-crypto');
const { XChatApi, toSigningKeyEntry } = require('./lib/x-chat-api');

const app = express();
app.use(express.json());

// 实例缓存
const cryptoInstances = new Map();

// POST /decrypt-event
app.post('/decrypt-event', async (req, res) => {
  const { userId, encodedEvent, keyChangeEvent, senderId, signatureInfo } = req.body;
  try {
    const cc = cryptoInstances.get(userId);
    if (!cc) return res.json({ text: null, decrypted: false, reason: 'not_unlocked' });

    // 登记签名公钥
    const api = new XChatApi(cc.accessToken);
    const [senderPks, myPks] = await Promise.all([
      api.getPublicKeys(senderId),
      api.getPublicKeys(userId),
    ]);
    cc.addSigningKeys(senderId, senderPks.map(pk => toSigningKeyEntry(senderId, pk)));
    cc.addSigningKeys(userId, myPks.map(pk => toSigningKeyEntry(userId, pk)));

    // 解密
    const batchIn = keyChangeEvent ? [keyChangeEvent, encodedEvent] : [encodedEvent];
    const result = cc.decryptBatch(batchIn);
    const msg = result.messages.find(m => m.event?.type === 'message');

    res.json({
      text: msg?.event?.content?.text ?? null,
      decrypted: msg?.event?.content?.text != null,
      verified: msg?.verified ?? false,
    });
  } catch (err) {
    res.json({ text: null, decrypted: false, reason: err.message });
  }
});

// POST /encrypt-message
app.post('/encrypt-message', async (req, res) => {
  const { userId, conversationId, text, replyToEvent } = req.body;
  try {
    const cc = cryptoInstances.get(userId);
    if (!cc) return res.status(422).json({ error: 'not_unlocked' });

    const encrypted = cc.encryptMessage({ conversationId, text, replyToEvent });
    res.json(encrypted);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /unlock
app.post('/unlock', async (req, res) => {
  const { userId, accessToken } = req.body;
  try {
    const api = new XChatApi(accessToken);
    const jb = await api.getJuiceboxConfig(userId);
    const cc = await ChatCrypto.createWithJuicebox(jb.config);
    await cc.unlock(process.env.XCHAT_PIN);
    cc.setIdentity(userId, jb.version);
    cc.setCacheKeys(true);
    cc.setRejectUnverified(false);
    cc.registerSelfSigningKey(userId, jb.version);
    cc.accessToken = accessToken; // 保存用于后续 API 调用
    cryptoInstances.set(userId, cc);
    res.json({ success: true, unlocked: cc.isUnlocked() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(3001, () => console.log('E2EE Bridge running on :3001'));
```

### 5.4 关键实现注意事项

#### 5.4.1 Juicebox Config 一次性 Token

```
⚠️ 关键：juicebox_config 中的 token 是一次性的！
每次 unlock 都必须从 X API 拉取新鲜的 config，不可复用旧对象。
否则会触发 "encoded data not valid utf-8" 错误。
```

#### 5.4.2 签名公钥版本对齐

```
⚠️ 关键：getJuiceboxConfig() 必须从原始 fetch 获取 snake_case 字段！
X SDK 的 camelCase 规范化会导致 version 与 juicebox_config 不同源，
解密时身份版本对齐失败，会话密钥提取不到。
```

#### 5.4.3 密钥缓存策略

```java
// Java 侧缓存设计建议
@Configuration
public class CacheConfig {

    @Bean
    public CacheManager cacheManager() {
        CaffeineCacheManager manager = new CaffeineCacheManager();
        manager.setCaffeine(Caffeine.newBuilder()
            .expireAfterAccess(Duration.ofHours(2))  // 2 小时无访问过期
            .maximumSize(1000)                        // 最多 1000 个用户
        );
        return manager;
    }
}
```

#### 5.4.4 安全加固清单

| 项目 | Demo 现状 | 生产建议 |
|------|----------|---------|
| PIN 存储 | `.env` 文件 | HashiCorp Vault / AWS Secrets Manager |
| 签名验证 | `setRejectUnverified(false)` | `setRejectUnverified(true)` |
| 传输加密 | HTTP | mTLS 或 HTTPS + 内网隔离 |
| 密钥持久化 | 内存缓存 | 加密 Redis（AES-256） |
| 日志 | 明文打印 | 脱敏处理，禁止打印密钥/密文 |
| 审计 | 无 | 记录所有加解密操作 |

---

## 六、总结

### 6.1 Demo 代码质量评估

| 维度 | 评分 | 说明 |
|------|------|------|
| 加密能力 | ⭐⭐⭐⭐⭐ | 完整实现解密流程，加密代码存在但未接入 |
| 代码质量 | ⭐⭐⭐⭐⭐ | 注释详尽，错误处理完善，熔断机制合理 |
| 安全性 | ⭐⭐⭐ | Demo 级别，有意放宽了安全限制 |
| 生产就绪度 | ⭐⭐ | 需加固 PIN 管理、签名验证、持久化 |

### 6.2 Java 实现建议

| 路径 | 适用场景 | 工期 | 推荐度 |
|------|---------|------|--------|
| **A: Node.js 微服务桥接** | 快速上线，团队有 JS 经验 | 1-2 周 | ⭐⭐⭐⭐⭐ |
| B: GraalVM WASM | 追求单进程，愿意踩坑 | 1-2 月 | ⭐⭐⭐ |
| C: JNI 原生调用 | 极致性能，有 Rust 人才 | 1-2 月 | ⭐⭐ |
| D: 纯 Java 移植 | 完全自主，长期维护 | 3-6 月 | ⭐ |

**推荐路径 A**，核心原因：
1. X 的 E2EE 协议基于 Signal Protocol 的私有扩展，chat-xdk WASM 是唯一官方参考实现
2. 协议细节未完全公开，自行移植存在安全风险
3. 官方 SDK 更新时，路径 A 只需升级 npm 依赖，其他路径需重新逆向
4. 微服务架构允许独立扩缩容加解密能力
5. 未来 X 可能发布 Java SDK，届时可无缝替换桥接层
