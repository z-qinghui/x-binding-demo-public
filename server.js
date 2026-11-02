require("dotenv").config();
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const path = require("path");

// X Chat 端到端加密（chat-xdk）——解密加密私信
const { ChatCrypto } = require("./lib/chat-crypto");
const { XChatApi, toSigningKeyEntry } = require("./lib/x-chat-api");
const { normalizeAttachment, sniffMime } = require("./lib/chat-attachment");
const { Client } = require("@xdevplatform/xdk");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ---------------------------------------------------------------------------
// 内存存储（绑定信息落盘到 .data/state.json，重启自动恢复）
//   ⚠️ state.json 含 access_token/refresh_token，已加入 .gitignore，切勿提交
// ---------------------------------------------------------------------------
const fs = require("fs");
const STATE_FILE = path.join(__dirname, ".data", "state.json");

const tokenStore = new Map(); // key: state, value: { codeVerifier, createdAt }（临时，不落盘）
const bindingStore = new Map(); // key: userId, value: { tokens, user, boundAt }

// 进程内 ChatCrypto 实例缓存（Juicebox 解锁后的真机身份，懒加载，不落盘）
//   key: userId -> ChatCrypto
const chatCryptoCache = new Map();
let chatPinEpoch = 0; // PIN 热更新计数器，防止旧 unlock promise 写入过期缓存

// ⚠️ Juicebox 熔断：PIN 错误（InvalidPin）会消耗账号有限的猜测配额，
// 耗尽后 XChat 真机身份会被永久删除、丢失所有旧加密私信。
// 一旦某账号解锁因 PIN 错误失败，就熔断该账号后续所有自动 unlock，
// 直到进程重启（改对 .env 里的 PIN 后重启即可恢复）。
//   key: userId -> { reason: string, at: number }
const chatUnlockBlocked = new Map();
// PIN 错误特征：chat-xdk 抛出的 Juicebox recovery 失败信息里含 InvalidPin
const isInvalidPinError = (msg) =>
  /InvalidPin|invalid pin|guesses_remaining/i.test(String(msg || ""));
const isTokenStaleError = (msg) =>
  /not valid for encoding utf-8/i.test(String(msg || ""));

// 保存绑定 + webhook 到本地文件
function saveState() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    const data = {
      bindings: [...bindingStore.entries()],
      webhooks: typeof webhookStore !== "undefined" ? [...webhookStore.entries()] : [],
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("保存状态失败:", err.message);
  }
}

// 启动时从文件恢复
function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const data = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
    for (const [k, v] of data.bindings || []) bindingStore.set(k, v);
    if (typeof webhookStore !== "undefined") {
      for (const [k, v] of data.webhooks || []) webhookStore.set(k, v);
      deduplicateWebhooks();
      saveState(); // 去重后回写，清理 state.json 中的冗余条目
    }
    console.log(
      `📂 已恢复 ${bindingStore.size} 个绑定, ${webhookStore.size} 个 webhook`
    );
  } catch (err) {
    console.error("恢复状态失败:", err.message);
  }
}

// ---------------------------------------------------------------------------
// PKCE 工具函数
// ---------------------------------------------------------------------------
function generateCodeVerifier() {
  return crypto.randomBytes(32).toString("base64url");
}

function generateCodeChallenge(verifier) {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

function generateState() {
  return crypto.randomBytes(16).toString("hex");
}

// ---------------------------------------------------------------------------
// 1. 发起授权 —— 前端点击「绑定 X 账号」后调用
//    生成 PKCE code_verifier / code_challenge，拼装授权 URL 并返回
// ---------------------------------------------------------------------------
app.get("/api/x/auth", (req, res) => {
  const state = generateState();
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);

  // 临时存储 code_verifier，回调时校验
  tokenStore.set(state, { codeVerifier, createdAt: Date.now() });

  const params = new URLSearchParams({
    response_type: "code",
    client_id: process.env.CLIENT_ID,
    redirect_uri: process.env.CALLBACK_URL,
    scope: process.env.SCOPE,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  const authUrl = `https://x.com/i/oauth2/authorize?${params.toString()}`;

  // 5 分钟后自动清理过期 state
  setTimeout(() => tokenStore.delete(state), 5 * 60 * 1000);

  res.json({ authUrl, state });
});

// ---------------------------------------------------------------------------
// 2. OAuth 回调 —— X 授权后重定向到此
//    用 code + code_verifier 换取 access_token + refresh_token
// ---------------------------------------------------------------------------
app.get("/api/x/callback", async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.redirect(`/?error=${encodeURIComponent(error)}`);
  }

  const stored = tokenStore.get(state);
  if (!stored) {
    return res.redirect("/?error=invalid_state");
  }

  try {
    // 用 code 换 token
    const tokenRes = await fetch("https://api.x.com/2/oauth2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization:
          "Basic " +
          Buffer.from(
            `${process.env.CLIENT_ID}:${process.env.CLIENT_SECRET}`
          ).toString("base64"),
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: process.env.CALLBACK_URL,
        code_verifier: stored.codeVerifier,
      }),
    });

    if (!tokenRes.ok) {
      const errBody = await tokenRes.text();
      console.error("Token exchange failed:", errBody);
      return res.redirect(
        `/?error=${encodeURIComponent("token_exchange_failed")}`
      );
    }

    const tokens = await tokenRes.json();

    // 用 access_token 获取用户信息
    const userRes = await fetch(
      "https://api.x.com/2/users/me?user.fields=profile_image_url,description,public_metrics",
      {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      }
    );

    const userData = await userRes.json();
    const user = userData.data;

    console.log(`🔐 Token scopes: ${tokens.scope}`);

    // 存储绑定信息（按 userId 去重）
    const binding = {
      userId: user.id,
      user: {
        id: user.id,
        username: user.username,
        name: user.name,
        avatar: user.profile_image_url,
        description: user.description,
        followers: user.public_metrics?.followers_count,
        following: user.public_metrics?.following_count,
      },
      tokens: {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_in: tokens.expires_in,
        expires_at: Date.now() + tokens.expires_in * 1000,
        scope: tokens.scope,
        token_type: tokens.token_type,
      },
      boundAt: new Date().toISOString(),
    };

    bindingStore.set(user.id, binding);
    saveState();

    // 清理临时 state
    tokenStore.delete(state);

    // 重定向到前端，携带绑定成功标识
    res.redirect(`/?bound=true&user_id=${user.id}`);
  } catch (err) {
    console.error("OAuth callback error:", err);
    res.redirect(`/?error=${encodeURIComponent(err.message)}`);
  }
});

// ---------------------------------------------------------------------------
// 3. 获取当前绑定状态
// ---------------------------------------------------------------------------
app.get("/api/x/status", (req, res) => {
  const userId = req.query.user_id;
  if (!userId || !bindingStore.has(userId)) {
    return res.json({ bound: false });
  }

  const binding = bindingStore.get(userId);
  const isExpired = Date.now() > binding.tokens.expires_at;

  res.json({
    bound: true,
    user: binding.user,
    boundAt: binding.boundAt,
    tokenStatus: isExpired ? "expired" : "active",
    expiresAt: new Date(binding.tokens.expires_at).toISOString(),
    scope: binding.tokens.scope,
  });
});

// ---------------------------------------------------------------------------
// 4. 刷新 Token
// ---------------------------------------------------------------------------
app.post("/api/x/refresh", async (req, res) => {
  const { user_id } = req.body;
  const binding = bindingStore.get(user_id);

  if (!binding || !binding.tokens.refresh_token) {
    return res.status(400).json({ error: "no_refresh_token" });
  }

  try {
    const tokenRes = await fetch("https://api.x.com/2/oauth2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization:
          "Basic " +
          Buffer.from(
            `${process.env.CLIENT_ID}:${process.env.CLIENT_SECRET}`
          ).toString("base64"),
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: binding.tokens.refresh_token,
      }),
    });

    if (!tokenRes.ok) {
      return res.status(400).json({ error: "refresh_failed" });
    }

    const tokens = await tokenRes.json();

    // 更新存储
    binding.tokens = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || binding.tokens.refresh_token,
      expires_in: tokens.expires_in,
      expires_at: Date.now() + tokens.expires_in * 1000,
      scope: tokens.scope,
      token_type: tokens.token_type,
    };

    saveState();
    res.json({
      success: true,
      expiresAt: new Date(binding.tokens.expires_at).toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// 5. 解绑账号
// ---------------------------------------------------------------------------
app.post("/api/x/unbind", (req, res) => {
  const { user_id } = req.body;
  if (bindingStore.has(user_id)) {
    bindingStore.delete(user_id);
    saveState();
    return res.json({ success: true });
  }
  res.status(404).json({ error: "not_found" });
});

// ---------------------------------------------------------------------------
// 5.5 一键解绑所有账号（演示用，便于多次绑定流程）
// ---------------------------------------------------------------------------
app.post("/api/x/unbind-all", (req, res) => {
  const count = bindingStore.size;
  bindingStore.clear();
  saveState();
  console.log(`🗑️ 一键解绑：已清除 ${count} 个绑定`);
  res.json({ success: true, unboundCount: count });
});

// ---------------------------------------------------------------------------
// 6. 获取所有已绑定账号（管理后台用）
// ---------------------------------------------------------------------------
app.get("/api/x/bindings", (req, res) => {
  const bindings = [];
  for (const [userId, binding] of bindingStore) {
    bindings.push({
      userId,
      user: binding.user,
      boundAt: binding.boundAt,
      tokenStatus:
        Date.now() > binding.tokens.expires_at ? "expired" : "active",
    });
  }
  res.json({ bindings, count: bindings.length });
});

// ---------------------------------------------------------------------------
// 内存存储 —— Webhook & DM
// ---------------------------------------------------------------------------
const webhookStore = new Map(); // key: webhookId, value: { id, url, valid, createdAt }
const dmEventStore = []; // 收到的 DM 事件列表（最近 100 条）
const mentionEventStore = []; // 收到的提及/评论事件列表（最近 100 条）
const mediaCache = new Map(); // attachmentId → { bytes: Buffer, type: string, at: number }
const MEDIA_CACHE_MAX = 30; // 最多缓存 30 个媒体（内存保护）

/**
 * 从解密事件中提取并归一化媒体附件元数据列表。
 * 统一走 lib/chat-attachment.js 的 normalizeAttachment，产出带
 * kind/ext/mime 的中间模型（供前端分类渲染 + 媒体代理判定 MIME）。
 */
function extractChatAttachments(event) {
  const list = event?.content?.attachments || [];
  return list
    .map((a) => normalizeAttachment(a))
    .filter((a) => a && a.mediaHashKey);
}

// ---------------------------------------------------------------------------
// 旧版 DM 媒体解析（dm.received / dm.sent 明文媒体，图片/视频）
//   webhook 的 direct_message_events 只带 entities.urls（t.co / pic.twitter.com，
//   expanded_url = https://twitter.com/messages/media/<message_id>），不带 attachment.media。
//   需用绑定账号 token 调 GET /2/dm_conversations/with/:peer/dm_events（带 media 扩展），
//   按 message id 反查 media_keys → includes.media，拿到直接媒体地址。
//   实测：视频 mp4 变体 / 缩略图在公开 CDN（免鉴权）；照片走 ton.twitter.com，需 OAuth 1.0a。
// ---------------------------------------------------------------------------
const DM_MEDIA_QUERY =
  "dm_event.fields=attachments" +
  "&media.fields=type,url,preview_image_url,duration_ms,width,height,alt_text,variants" +
  "&expansions=attachments.media_keys";

// 从 URL 提取文件名（取路径末段，去查询串）
function filenameFromUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    const seg = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() || "");
    return seg || null;
  } catch {
    return null;
  }
}

// 视频挑选可直连的 mp4 变体（码率最高者）；HLS(m3u8) 不选
function pickVideoVariant(media) {
  const variants = Array.isArray(media.variants) ? media.variants : [];
  let best = null;
  for (const v of variants) {
    if (v.content_type === "video/mp4") {
      const br = v.bit_rate || 0;
      if (!best || br > best.bit_rate) best = { url: v.url, bit_rate: br };
    }
  }
  return best?.url || null;
}

// 归一化 DM 媒体为前端可渲染的附件模型（kind/filename 与 Chat 附件对齐，但走 /api/x/dm/media）
function normalizeDmMedia(media, messageId, expandedUrl) {
  const type = media.type || "photo"; // photo / video / animated_gif
  const isVideo = type === "video";
  const isGif = type === "animated_gif";
  const directUrl = isVideo || isGif ? pickVideoVariant(media) : media.url || null;
  const previewUrl = media.preview_image_url || null;
  const filename =
    filenameFromUrl(directUrl) ||
    filenameFromUrl(previewUrl) ||
    (isGif ? "动图.gif" : isVideo ? "视频.mp4" : "图片.jpg");
  return {
    kind: isGif ? "gif" : isVideo ? "video" : "image",
    type,
    mediaKey: media.media_key,
    filename,
    url: directUrl, // 直接媒体地址（video/gif=公开 mp4；photo=ton.twitter.com，需 OAuth1）
    previewUrl, // 视频缩略图（公开 pbs.twimg.com）
    fallbackUrl: expandedUrl || null, // 照片无法内联时的兜底：在 X 中查看
    width: media.width || null,
    height: media.height || null,
    durationMillis: media.duration_ms || null,
    messageId,
  };
}

// 反查某条 DM 消息的媒体元数据（返回 normalizeDmMedia 列表，无媒体返回 []）
async function resolveDmMedia(userId, record) {
  const binding = bindingStore.get(userId);
  if (!binding) return [];
  // 对方 ID：收到→senderId，发出→recipientId
  const peerId = record.type === "dm.sent" ? record.recipientId : record.senderId;
  if (!peerId) return [];

  try {
    if (Date.now() > binding.tokens.expires_at) await refreshTokens(binding);
    const apiUrl =
      `https://api.x.com/2/dm_conversations/with/${peerId}/dm_events?` +
      `${DM_MEDIA_QUERY}&max_results=50`;
    const res = await fetch(apiUrl, {
      headers: { Authorization: `Bearer ${binding.tokens.access_token}` },
    });
    if (!res.ok) {
      console.warn(`⚠️ [DM] 媒体反查失败 (${res.status}) msg=${record.id}`);
      return [];
    }
    const data = await res.json();
    const ev = (data.data || []).find((d) => d.id === record.id);
    const mediaKeys = ev?.attachments?.media_keys || [];
    if (!mediaKeys.length) return [];

    const byKey = new Map((data.includes?.media || []).map((m) => [m.media_key, m]));
    // 照片的兜底查看地址（entities.urls 里的 expanded_url）
    const expandedUrl =
      (record.urls || []).find((u) => /\/messages\/media\//.test(u.expandedUrl || ""))
        ?.expandedUrl || null;

    const atts = [];
    for (const key of mediaKeys) {
      const m = byKey.get(key);
      if (m) atts.push(normalizeDmMedia(m, record.id, expandedUrl));
    }
    return atts;
  } catch (e) {
    console.warn(`⚠️ [DM] 媒体反查异常 msg=${record.id}: ${e.message}`);
    return [];
  }
}

// 清理 webhookStore：相同 URL 仅保留最新一条，删除旧条目
function deduplicateWebhooks() {
  const byUrl = new Map(); // url -> { id, entry, createdAt }
  for (const [id, entry] of webhookStore) {
    const existing = byUrl.get(entry.url);
    if (!existing || new Date(entry.createdAt) > new Date(existing.createdAt)) {
      // 如果有旧的同 URL 条目，从 store 中移除
      if (existing) webhookStore.delete(existing.id);
      byUrl.set(entry.url, { id, entry, createdAt: entry.createdAt });
    } else {
      // 当前条目比已记录的旧，移除当前条目
      webhookStore.delete(id);
    }
  }
}

// ---------------------------------------------------------------------------
// 7. Webhook CRC 校验端点
//    X 每小时 GET 一次，需返回 HMAC-SHA256 哈希
//    文档：https://docs.x.com/x-api/webhooks/quickstart
// ---------------------------------------------------------------------------
app.get("/api/x/webhook", (req, res) => {
  const crcToken = req.query.crc_token;
  if (!crcToken) {
    return res.status(400).json({ error: "missing crc_token" });
  }

  // 用 Consumer Secret 做 HMAC-SHA256
  const hmac = crypto.createHmac("sha256", process.env.CRC_SECRET);
  hmac.update(crcToken);
  const hash = hmac.digest("base64");

  res.json({ response_token: `sha256=${hash}` });
});

// ---------------------------------------------------------------------------
// 8. Webhook 事件接收端点
//    X 通过 POST 推送事件（DM 收发、评论提及等）
// ---------------------------------------------------------------------------
app.post("/api/x/webhook", (req, res) => {
  // 落盘完整推送，便于分析真实结构（调试用，生产可关闭）
  try {
    fs.appendFileSync(
      path.join(__dirname, ".data", "webhook-events.log"),
      new Date().toISOString() + " " + JSON.stringify(req.body) + "\n"
    );
  } catch {}
  console.log("📩 收到 Webhook 推送!", JSON.stringify(req.body).substring(0, 300));

  // 验证签名（demo 中仅警告，不阻断处理，避免因密钥差异漏收事件）
  const signature = req.headers["x-twitter-webhooks-signature"];
  const body = JSON.stringify(req.body);
  if (signature && process.env.CRC_SECRET) {
    const expectedSig =
      "sha256=" +
      crypto.createHmac("sha256", process.env.CRC_SECRET).update(body).digest("base64");
    if (signature !== expectedSig) {
      console.warn("⚠️ Webhook 签名验证不匹配（demo 继续处理，生产需核对 CRC_SECRET）");
    }
  }

  const event = req.body;

  // XAA 新格式：事件包在 event.data 里，event_type 标识类型，
  //   真实业务数据在 event.data.payload 下（DM 用 direct_message_events / users 结构）
  const envelope = event.data || event;
  const eventType = envelope.event_type || event.event_type;
  const payload = envelope.payload || {};

  // ---- 私信事件：dm.received / dm.sent（旧DM）+ chat.received / chat.sent（新Chat）----
  if (
    eventType === "dm.received" ||
    eventType === "dm.sent" ||
    eventType === "chat.received" ||
    eventType === "chat.sent"
  ) {
    // 新版 Chat 事件结构未知，多路径兜底提取文本
    const dmEvents = payload.direct_message_events || [];
    const isChat = eventType === "chat.received" || eventType === "chat.sent";
    // 确定事件归属的绑定用户：
    //   dm.sent → 归属接收方（recipient_id），因为发送方是"我"，消息应出现在对方的聊天窗口
    //   dm.received / chat.* → 归属 filter.user_id（订阅者/接收方）
    const filterUserId =
      envelope.filter && bindingStore.has(envelope.filter.user_id)
        ? envelope.filter.user_id
        : null;
    let dmOwnerUserId = filterUserId || [...bindingStore.keys()][0] || null;
    if (eventType === "dm.sent" && dmEvents.length) {
      const mc = dmEvents[0]?.message_create || {};
      const recipientId = mc.target?.recipient_id;
      if (recipientId && bindingStore.has(recipientId)) {
        dmOwnerUserId = recipientId;
      }
    }
    if (isChat && !dmEvents.length) {
      // 新版 X Chat 是端到端加密（E2EE）。real-time-events 文档：chat.received
      // 直接携带密文 encoded_event（及可选 conversation_key_change_event）。
      // 先入库占位（text=null），再用 chat-xdk 异步解密并回填 text。
      const encodedEvent = payload.encoded_event || null;
      const keyChangeEvent = payload.conversation_key_change_event || null;
      // Chat 事件无 recipient_id，从 conversation_id（格式 "idA:idB"）解析对方 ID：
      //   取对话双方中非发送方的一方作为接收方，供前端按收发双方分发到各自面板。
      const convParts = (payload.conversation_id || "").split(":").filter(Boolean);
      const chatRecipientId =
        convParts.length === 2
          ? convParts.find((id) => id !== payload.sender_id) || null
          : null;
      const record = {
        id: payload.id || envelope.event_uuid,
        type: eventType,
        ownerUserId: dmOwnerUserId,
        senderId: payload.sender_id,
        recipientId: chatRecipientId,
        conversationId: payload.conversation_id,
        text: null,
        encrypted: true,
        decrypted: false,
        encodedEvent, // 保留密文便于失败后重试解密
        keyChangeEvent, // 保留 key change 事件便于媒体下载时提取会话密钥
        conversationKeyVersion: payload.conversation_key_version || null,
        attachments: [], // 解密后回填媒体附件元数据
        mediaKeyVersion: null, // 解密后回填消息加密用的会话密钥版本
        createdAt: payload.created_at_msec
          ? new Date(parseInt(payload.created_at_msec)).toISOString()
          : new Date().toISOString(),
      };
      dmEventStore.unshift(record);

      // 异步解密回填：找到「本会话所属绑定用户」的身份来解密。
      // chat.received 的接收方即绑定用户；用第一个已注册身份的用户兜底。
      // 接收方（绑定用户）即会话归属者：优先 filter.user_id，其次任一绑定用户
      if (dmOwnerUserId && encodedEvent) {
        decryptChatEvent(dmOwnerUserId, {
          encodedEvent,
          keyChangeEvent,
          senderId: payload.sender_id,
          signatureInfo: payload.message_event_signature || null,
        })
          .then((r) => {
            if (r.decrypted) {
              record.text = r.text;
              record.decrypted = true;
              // 保留附件元数据和会话密钥版本（媒体代理端点需要）
              const atts = extractChatAttachments(r.event);
              if (atts.length) record.attachments = atts;
              record.mediaKeyVersion = r.event?.keyVersion ?? null;
              console.log(`🔓 [XChat] webhook 事件已解密: ${(r.text || "").substring(0, 50)}${atts.length ? ` [附件×${atts.length}]` : ""}`);
            } else {
              console.log(`🔒 [XChat] webhook 事件未解密 (${r.reason})`);
            }
          })
          .catch((e) => console.warn(`⚠️ [XChat] 异步解密异常: ${e.message}`));
      }
      console.log(
        `💬 [Chat-E2EE] ${eventType} from ${payload.sender_id}（已入库，${
          encodedEvent ? "触发 chat-xdk 异步解密" : "无密文"
        }）`
      );
    } else if (dmEvents.length) {
      for (const dm of dmEvents) {
        // 按消息 ID 去重：dm.sent 和 dm.received 可能对同一条消息各推一次
        const exists = dmEventStore.some((e) => e.id === dm.id);
        if (exists) {
          console.log(`♻️ [XAA] ${eventType} 消息 ${dm.id} 已存在，跳过`);
          continue;
        }
        const mc = dm.message_create || {};
        const md = mc.message_data || {};
        // 旧 DM 媒体信号：entities.urls 里 expanded_url 指向 /messages/media/<id> 或
        // display_url = pic.twitter.com/*。webhook 不携带 attachment.media，需事后反查。
        const urls = (Array.isArray(md.entities?.urls) ? md.entities.urls : []).map((u) => ({
          url: u.url,
          expandedUrl: u.expanded_url,
          displayUrl: u.display_url,
          indices: u.indices,
        }));
        const hasMedia = urls.some(
          (u) =>
            /\/messages\/media\//.test(u.expandedUrl || "") ||
            /^pic\.twitter\.com/i.test(u.displayUrl || "")
        );
        const record = {
          id: dm.id,
          type: eventType,
          ownerUserId: dmOwnerUserId,
          senderId: mc.sender_id,
          recipientId: mc.target?.recipient_id,
          text: md.text,
          attachments: [], // 媒体元数据异步反查后回填
          urls, // 原始 entities.urls（含 t.co / expanded_url）
          hasMedia,
          createdAt: dm.created_timestamp
            ? new Date(parseInt(dm.created_timestamp)).toISOString()
            : new Date().toISOString(),
        };
        dmEventStore.unshift(record);
        console.log(
          `📩 [XAA] ${eventType}: ${(md.text || "").substring(0, 50)}${hasMedia ? " [媒体]" : ""}`
        );

        // 异步反查媒体元数据（照片/视频）并回填，前端每 4s 轮询会自动刷新
        if (hasMedia && dmOwnerUserId) {
          resolveDmMedia(dmOwnerUserId, record)
            .then((atts) => {
              if (atts.length) {
                record.attachments = atts;
                console.log(
                  `🖼️ [DM] 媒体已解析 msg=${record.id}: ${atts.map((a) => a.kind).join(",")}`
                );
              }
            })
            .catch(() => {});
        }
      }
    } else {
      // 兜底：扁平结构 event.data.text
      dmEventStore.unshift({
        id: envelope.id || envelope.dm_event_id,
        type: eventType,
        ownerUserId: dmOwnerUserId,
        senderId: envelope.sender_id,
        text: envelope.text,
        createdAt: envelope.created_at || new Date().toISOString(),
      });
      console.log(`📩 [XAA-flat] ${eventType}: ${(envelope.text || "").substring(0, 50)}`);
    }
  }

  // ---- 提及/评论事件：post.mention.create / post.create ----
  else if (eventType === "post.mention.create" || eventType === "post.create") {
    // 真实 XAA 结构：推文字段直接在 payload 下（扁平），兼容 payload.tweet 嵌套
    const tweet = payload.tweet || payload.data || payload;
    // 仅入库有 id 的有效事件，避免脏数据
    if (tweet && tweet.id) {
      // 按 tweet id 去重：post.mention.create 与 post.create 可能对同一推文各推一次
      const exists = mentionEventStore.some((m) => m.id === tweet.id);
      if (exists) {
        console.log(`💭 [XAA] ${eventType} 重复推文 ${tweet.id}，跳过`);
      } else {
        mentionEventStore.unshift({
          id: tweet.id,
          type: eventType,
          authorId: tweet.author_id,
          text: tweet.text,
          conversationId: tweet.conversation_id,
          createdAt: tweet.created_at || new Date().toISOString(),
        });
        console.log(`💭 [XAA] ${eventType}: ${(tweet.text || "").substring(0, 50)}`);
      }
    } else {
      console.warn(`⚠️ ${eventType} 事件缺少 tweet.id，已忽略`);
    }
  }

  // ---- 旧 AAA 格式兼容（顶层 direct_message_events / tweet_create_events）----
  else if (event.direct_message_events) {
    for (const dm of event.direct_message_events) {
      const mc = dm.message_create || {};
      dmEventStore.unshift({
        id: dm.id,
        type: dm.type,
        senderId: mc.sender_id,
        recipientId: mc.target?.recipient_id,
        text: mc.message_data?.text,
        createdAt: new Date(parseInt(dm.created_timestamp)).toISOString(),
      });
      console.log(`📩 [AAA] DM: ${(mc.message_data?.text || "").substring(0, 50)}`);
    }
  } else if (event.tweet_create_events) {
    for (const t of event.tweet_create_events) {
      mentionEventStore.unshift({
        id: t.id_str || t.id,
        type: "tweet_create",
        authorId: t.user?.id_str,
        text: t.text,
        createdAt: new Date().toISOString(),
      });
      console.log(`💭 [AAA] 推文: @${t.user?.screen_name}: ${(t.text || "").substring(0, 50)}`);
    }
  }

  // 保留最近 100 条
  if (dmEventStore.length > 100) dmEventStore.length = 100;
  if (mentionEventStore.length > 100) mentionEventStore.length = 100;

  res.status(200).json({ ok: true });
});

// ---------------------------------------------------------------------------
// 9. 注册 Webhook
//    POST /2/webhooks —— 用 App-Only Bearer Token
//    X 会立即发 CRC 校验请求
// ---------------------------------------------------------------------------
app.post("/api/x/webhook/register", async (req, res) => {
  const webhookUrl = process.env.WEBHOOK_URL;
  if (!webhookUrl || webhookUrl.includes("your-domain")) {
    return res.status(400).json({
      error: "WEBHOOK_URL 未配置",
      hint: "请在 .env 中设置 WEBHOOK_URL（本地开发先用 ngrok）",
    });
  }

  try {
    const regRes = await fetch("https://api.x.com/2/webhooks", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.BEARER_TOKEN}`,
      },
      body: JSON.stringify({ url: webhookUrl }),
    });

    if (!regRes.ok) {
      const errBody = await regRes.text();
      // 已达上限说明之前已注册过：拉取现有 Webhook 回填内存，视为成功复用
      if (errBody.includes("WebhookLimitExceeded")) {
        const listRes = await fetch("https://api.x.com/2/webhooks", {
          headers: { Authorization: `Bearer ${process.env.BEARER_TOKEN}` },
        });
        const listData = await listRes.json();
        const existing = Array.isArray(listData.data) ? listData.data : [];
        for (const w of existing) {
          webhookStore.set(w.id, {
            id: w.id,
            url: w.url,
            valid: w.valid,
            createdAt: w.created_at,
          });
        }
        deduplicateWebhooks();
        const reused = existing[0];
        if (reused) {
          saveState();
          console.log(`♻️ 复用已有 Webhook: ${reused.id} -> ${reused.url}`);
          return res.json({ success: true, webhook: reused, reused: true });
        }
      }
      console.error("Webhook 注册失败:", errBody);
      return res.status(regRes.status).json({
        error: "registration_failed",
        detail: errBody,
      });
    }

    const data = await regRes.json();
    const webhook = data.data;

    webhookStore.set(webhook.id, {
      id: webhook.id,
      url: webhook.url,
      valid: webhook.valid,
      createdAt: webhook.created_at,
    });
    deduplicateWebhooks();

    saveState();
    console.log(`✅ Webhook 注册成功: ${webhook.id} -> ${webhook.url}`);
    res.json({ success: true, webhook });
  } catch (err) {
    console.error("Webhook 注册异常:", err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// 10. Webhook 管理
// ---------------------------------------------------------------------------
// 列出已注册 Webhook（同时把结果回填到内存 webhookStore，解决服务重启后丢失 ID 的问题）
app.get("/api/x/webhooks", async (req, res) => {
  try {
    const listRes = await fetch("https://api.x.com/2/webhooks", {
      headers: {
        Authorization: `Bearer ${process.env.BEARER_TOKEN}`,
      },
    });
    const data = await listRes.json();
    // 回填内存，供后续订阅使用
    if (Array.isArray(data.data)) {
      for (const w of data.data) {
        webhookStore.set(w.id, {
          id: w.id,
          url: w.url,
          valid: w.valid,
          createdAt: w.created_at,
        });
      }
      deduplicateWebhooks();
    }
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 手动触发 CRC 校验
app.put("/api/x/webhook/:webhookId/validate", async (req, res) => {
  try {
    const valRes = await fetch(
      `https://api.x.com/2/webhooks/${req.params.webhookId}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${process.env.BEARER_TOKEN}`,
        },
      }
    );
    const data = await valRes.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 删除 Webhook
app.delete("/api/x/webhook/:webhookId", async (req, res) => {
  try {
    const delRes = await fetch(
      `https://api.x.com/2/webhooks/${req.params.webhookId}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${process.env.BEARER_TOKEN}`,
        },
      }
    );
    if (delRes.ok) {
      webhookStore.delete(req.params.webhookId);
      res.json({ success: true });
    } else {
      res.status(delRes.status).json({ error: "delete_failed" });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// 10.5 订阅事件
//     注册 webhook 后，还需订阅才能收到事件推送
//     POST /2/activity/subscriptions
// ---------------------------------------------------------------------------
// 通用订阅函数：为某用户订阅一组 XAA 事件类型
//   POST /2/activity/subscriptions
//   body: { event_type, filter: { user_id }, webhook_id }
async function subscribeEvents(binding, events) {
  // 获取已注册的 webhook_id；内存为空时自动从 X 拉取回填
  if (webhookStore.size === 0) {
    const listRes = await fetch("https://api.x.com/2/webhooks", {
      headers: { Authorization: `Bearer ${process.env.BEARER_TOKEN}` },
    });
    const listData = await listRes.json();
    if (Array.isArray(listData.data)) {
      for (const w of listData.data) {
        webhookStore.set(w.id, { id: w.id, url: w.url, valid: w.valid, createdAt: w.created_at });
      }
    }
  }
  // 选择最新创建的有效 Webhook（按 createdAt 降序）
  const webhooks = [...webhookStore.values()]
    .filter((w) => w.valid !== false)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  let webhookId = webhooks[0]?.id;
  if (!webhookId) {
    throw new Error("no_webhook_registered");
  }

  const results = [];
  for (const eventType of events) {
    const subRes = await fetch("https://api.x.com/2/activity/subscriptions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${binding.tokens.access_token}`,
      },
      body: JSON.stringify({
        event_type: eventType,
        filter: { user_id: binding.userId },
        webhook_id: webhookId,
        tag: `demo-${eventType}`,
      }),
    });
    const body = await subRes.text();
    // DuplicateSubscription 表示该事件此前已订阅且仍生效，视为成功
    const isDuplicate = body.includes("DuplicateSubscription");
    const ok = subRes.ok || isDuplicate;
    results.push({ eventType, ok, status: subRes.status, duplicate: isDuplicate, body });
    if (subRes.ok) {
      console.log(`✅ 已订阅 ${binding.user.username} 的 ${eventType} 事件`);
    } else if (isDuplicate) {
      console.log(`♻️ ${binding.user.username} 的 ${eventType} 事件此前已订阅（仍生效）`);
    } else {
      console.error(`订阅 ${eventType} 失败:`, body);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// 10.5 订阅 DM 事件（私信页面调用）
//     注册 webhook 后，还需订阅才能收到事件推送
// ---------------------------------------------------------------------------
app.post("/api/x/webhook/subscribe", async (req, res) => {
  const { user_id, events } = req.body;
  const binding = bindingStore.get(user_id);

  if (!binding) {
    return res.status(400).json({ error: "account_not_bound" });
  }

  if (Date.now() > binding.tokens.expires_at) {
    try {
      await refreshTokens(binding);
    } catch {
      return res.status(401).json({ error: "token_expired_refresh_failed" });
    }
  }

  try {
    const eventTypes =
      Array.isArray(events) && events.length ? events : ["dm.received", "dm.sent"];
    const results = await subscribeEvents(binding, eventTypes);
    const allOk = results.every((r) => r.ok);
    res.json({ success: allOk, results, detail: allOk ? undefined : JSON.stringify(results) });
  } catch (err) {
    res.status(500).json({ error: err.message, detail: err.message });
  }
});

// ---------------------------------------------------------------------------
// 10.6 订阅提及/评论事件（评论回复页面调用）
// ---------------------------------------------------------------------------
app.post("/api/x/activity/subscribe", async (req, res) => {
  const { user_id, events } = req.body;
  const binding = bindingStore.get(user_id);

  if (!binding) {
    return res.status(400).json({ error: "account_not_bound" });
  }

  if (Date.now() > binding.tokens.expires_at) {
    try {
      await refreshTokens(binding);
    } catch {
      return res.status(401).json({ error: "token_expired_refresh_failed" });
    }
  }

  try {
    const eventTypes =
      Array.isArray(events) && events.length
        ? events
        : ["post.mention.create", "post.create"];
    const results = await subscribeEvents(binding, eventTypes);
    const allOk = results.every((r) => r.ok);
    res.json({ success: allOk, results, detail: allOk ? undefined : JSON.stringify(results) });
  } catch (err) {
    res.status(500).json({ error: err.message, detail: err.message });
  }
});

// ---------------------------------------------------------------------------
// 10.8 查询用户信息（通过用户名）
//     GET /api/x/users/by/username/:username
// ---------------------------------------------------------------------------
app.get("/api/x/users/by/username/:username", async (req, res) => {
  const { user_id } = req.query;
  const binding = bindingStore.get(user_id);

  if (!binding) {
    return res.status(400).json({ error: "account_not_bound" });
  }

  if (Date.now() > binding.tokens.expires_at) {
    try {
      await refreshTokens(binding);
    } catch {
      return res.status(401).json({ error: "token_expired_refresh_failed" });
    }
  }

  try {
    const userRes = await fetch(
      `https://api.x.com/2/users/by/username/${req.params.username}?user.fields=profile_image_url,description,public_metrics`,
      {
        headers: { Authorization: `Bearer ${binding.tokens.access_token}` },
      }
    );

    if (!userRes.ok) {
      const errBody = await userRes.text();
      return res.status(userRes.status).json({ error: "user_not_found", detail: errBody });
    }

    const data = await userRes.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 按 userId 查用户（收到私信时回填对方用户名，无需手动填写）
//   GET /api/x/users/:id?user_id=<绑定用户>
app.get("/api/x/users/:id", async (req, res) => {
  const { user_id } = req.query;
  const binding = bindingStore.get(user_id);
  if (!binding) return res.status(400).json({ error: "account_not_bound" });
  if (Date.now() > binding.tokens.expires_at) {
    try {
      await refreshTokens(binding);
    } catch {
      return res.status(401).json({ error: "token_expired_refresh_failed" });
    }
  }
  try {
    const userRes = await fetch(
      `https://api.x.com/2/users/${encodeURIComponent(req.params.id)}?user.fields=profile_image_url`,
      { headers: { Authorization: `Bearer ${binding.tokens.access_token}` } }
    );
    if (!userRes.ok) {
      return res.status(userRes.status).json({ error: "user_not_found" });
    }
    res.json(await userRes.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// 11. DM 发送
//    POST /2/dm_conversations/with/:participant_id/messages
// ---------------------------------------------------------------------------
app.post("/api/x/dm/send", async (req, res) => {
  const { user_id, participant_id, text } = req.body;
  const binding = bindingStore.get(user_id);

  if (!binding) {
    return res.status(400).json({ error: "account_not_bound" });
  }

  // 检查 token 是否过期，自动刷新
  if (Date.now() > binding.tokens.expires_at) {
    try {
      await refreshTokens(binding);
    } catch {
      return res.status(401).json({ error: "token_expired_refresh_failed" });
    }
  }

  try {
    const dmRes = await fetch(
      `https://api.x.com/2/dm_conversations/with/${participant_id}/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${binding.tokens.access_token}`,
        },
        body: JSON.stringify({ text }),
      }
    );

    if (!dmRes.ok) {
      const errBody = await dmRes.text();
      console.error("DM 发送失败:", errBody);
      return res.status(dmRes.status).json({ error: "send_failed", detail: errBody });
    }

    const data = await dmRes.json();
    console.log(`📤 DM 已发送给 ${participant_id}: ${text?.substring(0, 50)}`);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// 12. DM 读取
//    GET /2/dm_events —— 拉取所有会话近期事件
// ---------------------------------------------------------------------------
app.get("/api/x/dm/events", async (req, res) => {
  const { user_id } = req.query;
  const binding = bindingStore.get(user_id);

  if (!binding) {
    return res.status(400).json({ error: "account_not_bound" });
  }

  if (Date.now() > binding.tokens.expires_at) {
    try {
      await refreshTokens(binding);
    } catch {
      return res.status(401).json({ error: "token_expired_refresh_failed" });
    }
  }

  try {
    const apiUrl = "https://api.x.com/2/dm_events?dm_event.fields=created_at,text,sender_id&event_types=MessageCreate&max_results=50";
    console.log(`📡 拉取所有 DM 事件: ${apiUrl}`);

    const dmRes = await fetch(apiUrl, {
      headers: { Authorization: `Bearer ${binding.tokens.access_token}` },
    });

    const responseText = await dmRes.text();
    console.log(`📡 X API 响应 (${dmRes.status}):`, responseText.substring(0, 500));

    if (!dmRes.ok) {
      return res.status(dmRes.status).json({ error: "fetch_failed", detail: responseText });
    }

    const data = JSON.parse(responseText);
    console.log(`📡 事件数: ${data?.data?.length || 0}`);
    res.json(data);
  } catch (err) {
    console.error("DM 事件拉取异常:", err);
    res.status(500).json({ error: err.message });
  }
});

// 按对象拉取一对一会话
app.get("/api/x/dm/conversation/:participantId", async (req, res) => {
  const { user_id } = req.query;
  const binding = bindingStore.get(user_id);

  if (!binding) {
    return res.status(400).json({ error: "account_not_bound" });
  }

  if (Date.now() > binding.tokens.expires_at) {
    try {
      await refreshTokens(binding);
    } catch {
      return res.status(401).json({ error: "token_expired_refresh_failed" });
    }
  }

  try {
    const apiUrl = `https://api.x.com/2/dm_conversations/with/${req.params.participantId}/dm_events?dm_event.fields=created_at,text,sender_id&max_results=50`;
    console.log(`📡 拉取会话: ${apiUrl.substring(0, 80)}...`);

    const dmRes = await fetch(apiUrl, {
      headers: { Authorization: `Bearer ${binding.tokens.access_token}` },
    });

    const responseText = await dmRes.text();
    console.log(`📡 X API 响应 (${dmRes.status}):`, responseText.substring(0, 300));

    if (!dmRes.ok) {
      return res.status(dmRes.status).json({ error: "fetch_failed", detail: responseText });
    }

    const data = JSON.parse(responseText);
    console.log(`📡 事件数: ${data?.data?.length || 0}`);
    res.json(data);
  } catch (err) {
    console.error("拉取会话异常:", err);
    res.status(500).json({ error: err.message });
  }
});

// 获取本地缓存的 DM 事件（Webhook 推送的）
app.get("/api/x/dm/local-events", (req, res) => {
  const userId = req.query.user_id;
  let events = dmEventStore;
  if (userId) {
    events = dmEventStore.filter(
      (e) => e.ownerUserId === userId || e.senderId === userId || e.recipientId === userId
    );
  }
  res.json({ events, count: events.length });
});

// ---------------------------------------------------------------------------
// 13. 发送评论回复
//    POST /2/tweets，带 reply.in_reply_to_tweet_id
//    文档：https://docs.x.com/x-api/posts/manage-tweets/quickstart#reply-to-a-post
// ---------------------------------------------------------------------------
app.post("/api/x/tweets/reply", async (req, res) => {
  const { user_id, in_reply_to_tweet_id, text } = req.body;
  const binding = bindingStore.get(user_id);

  if (!binding) {
    return res.status(400).json({ error: "account_not_bound" });
  }
  if (!in_reply_to_tweet_id || !text) {
    return res.status(400).json({ error: "missing_params" });
  }

  if (Date.now() > binding.tokens.expires_at) {
    try {
      await refreshTokens(binding);
    } catch {
      return res.status(401).json({ error: "token_expired_refresh_failed" });
    }
  }

  try {
    const tweetRes = await fetch("https://api.x.com/2/tweets", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${binding.tokens.access_token}`,
      },
      body: JSON.stringify({
        text,
        reply: { in_reply_to_tweet_id },
      }),
    });

    const body = await tweetRes.text();
    if (!tweetRes.ok) {
      console.error("评论回复失败:", body);
      return res.status(tweetRes.status).json({ error: "reply_failed", detail: body });
    }

    const data = JSON.parse(body);
    console.log(`💭 评论回复已发送: ${data?.data?.id}`);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// 14. 查询近期提及（轮询兜底方案）
//    GET /2/users/:id/mentions
//    文档：https://docs.x.com/x-api/posts/timelines/quickstart/user-mention-quickstart
// ---------------------------------------------------------------------------
app.get("/api/x/mentions", async (req, res) => {
  const { user_id } = req.query;
  const binding = bindingStore.get(user_id);

  if (!binding) {
    return res.status(400).json({ error: "account_not_bound" });
  }

  if (Date.now() > binding.tokens.expires_at) {
    try {
      await refreshTokens(binding);
    } catch {
      return res.status(401).json({ error: "token_expired_refresh_failed" });
    }
  }

  try {
    const apiUrl = `https://api.x.com/2/users/${binding.userId}/mentions?tweet.fields=created_at,author_id,conversation_id&max_results=25`;
    const mentionsRes = await fetch(apiUrl, {
      headers: { Authorization: `Bearer ${binding.tokens.access_token}` },
    });

    const body = await mentionsRes.text();
    if (!mentionsRes.ok) {
      return res.status(mentionsRes.status).json({ error: "fetch_failed", detail: body });
    }

    const data = JSON.parse(body);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 获取本地缓存的提及事件（Webhook 推送的）
app.get("/api/x/mentions/local-events", (req, res) => {
  res.json({ events: mentionEventStore, count: mentionEventStore.length });
});

// ===========================================================================
// XChat 加密私信解密（chat-xdk，私钥 blob / Bot 身份路径）
// ---------------------------------------------------------------------------
// 流程：注册身份(生成密钥→注册公钥) → webhook chat.received 触发 → Chat API
//       拉取会话加密事件 → chat-xdk 解密 → 展示明文。
// 能力边界：仅能解密「本身份注册后、且作为参与者」的会话；无法解密用户在真机
//           X App 用旧设备密钥加密的历史私信（那需 Juicebox PIN 路径）。
// ===========================================================================

// 确保 binding 的 token 未过期（过期则刷新），返回 binding 或抛错
async function ensureBinding(userId) {
  const binding = bindingStore.get(userId);
  if (!binding) {
    const err = new Error("account_not_bound");
    err.httpStatus = 400;
    throw err;
  }
  if (Date.now() > binding.tokens.expires_at) {
    try {
      await refreshTokens(binding);
    } catch {
      const err = new Error("token_expired_refresh_failed");
      err.httpStatus = 401;
      throw err;
    }
  }
  return binding;
}

// 进行中的解锁 promise（防止并发重复 unlock —— juicebox config token 一次性，
// 重复解锁会触发 "encoded data not valid utf-8" 错误）
const chatUnlockInflight = new Map();
// token 冷却：unlock 因 token 过期（utf-8 错误）失败后，需等待 API 刷新 token_map
const chatUnlockCooldown = new Map(); // userId → cooldownUntil (timestamp)

// 获取某用户已解锁的 Juicebox 真机身份 ChatCrypto 实例。
// 需配置 XCHAT_PIN 且账号有 juicebox_config。无法解锁时返回 null。
// 解锁只做一次并长期缓存复用；并发请求共享同一个进行中的解锁 promise。
async function getChatCrypto(userId) {
  if (chatCryptoCache.has(userId)) return chatCryptoCache.get(userId);
  if (chatUnlockInflight.has(userId)) return chatUnlockInflight.get(userId);

  // 熔断：该账号曾因 PIN 错误解锁失败，拒绝再次尝试（保护 Juicebox 猜测配额）
  const blocked = chatUnlockBlocked.get(userId);
  if (blocked) {
    const err = new Error(blocked.reason);
    err.code = "juicebox_locked_out";
    throw err;
  }

  // token 冷却期：Juicebox token_map 刷新需 ~30 秒，期间重试无意义
  const cooldownUntil = chatUnlockCooldown.get(userId);
  if (cooldownUntil && Date.now() < cooldownUntil) {
    console.warn(`⏳ [XChat] token 冷却中，${Math.ceil((cooldownUntil - Date.now()) / 1000)}s 后重试`);
    return null;
  }

  const pin = process.env.XCHAT_PIN;
  const binding = bindingStore.get(userId);
  if (!pin || !binding) return null;

  const epochAtStart = chatPinEpoch; // 记录发起时的 epoch

  const promise = (async () => {
    const api = new XChatApi(binding.tokens.access_token);
    const chatUserId = binding.user?.id || userId;
    // 每次解锁用新鲜拉取的 juicebox_config（token 一次性，不可复用旧对象）
    const jb = await api.getJuiceboxConfig(chatUserId);
    if (!jb) return null;
    const latestVersion = jb.version; // 与 config 同源，确保身份版本对齐

    const cc = await ChatCrypto.createWithJuicebox(jb.config);
    try {
      await cc.unlock(pin); // PIN 仅在内存使用，不落盘
    } catch (err) {
      console.error(`🛑 [XChat] unlock 异常详情: message="${err.message}" | pin_len=${pin.length} | version=${latestVersion}`);
      if (isTokenStaleError(err.message)) {
        // token_map 已消耗，需等 API 刷新（约 30 秒）
        chatUnlockCooldown.set(userId, Date.now() + 35000);
        console.warn(`⏳ [XChat] Juicebox token 已消耗，设置 35s 冷却期`);
        throw err;
      }
      // PIN 错误会烧 Juicebox 配额，熔断该账号后续自动重试，避免耗尽后身份被永久删除
      if (isInvalidPinError(err.message)) {
        chatUnlockBlocked.set(userId, {
          reason: `PIN 不匹配，已停止自动重试以保护 Juicebox 配额。请核对 .env 的 XCHAT_PIN 后重启服务（原始错误：${err.message}）`,
          at: Date.now(),
        });
        console.error(`🛑 [XChat] user=${userId} PIN 错误，已熔断自动解锁：${err.message}`);
      }
      throw err;
    }
    cc.setIdentity(chatUserId, latestVersion);
    cc.setCacheKeys(true);
    // X 的 key change 常用未在公钥接口返回的签名版本，严格模式会拒绝提取会话密钥。
    // demo 场景下放宽为 verified:false 仍解密。⚠️ 安全权衡：不再强制校验签名真实性。
    cc.setRejectUnverified(false);
    cc.registerSelfSigningKey(chatUserId, latestVersion);
    // 防止竞态：如果解锁期间 PIN 已热更新，丢弃本次结果不缓存
    if (chatPinEpoch !== epochAtStart) {
      console.warn(`⚠️ [XChat] 解锁完成但 PIN 已变更(epoch ${epochAtStart}→${chatPinEpoch})，丢弃旧实例`);
      return null;
    }
    chatCryptoCache.set(userId, cc);
    console.log(`🔑 [XChat] Juicebox 真机身份已解锁 user=${userId} version=${latestVersion || "(默认)"}`);
    return cc;
  })();

  chatUnlockInflight.set(userId, promise);
  try {
    return await promise;
  } finally {
    chatUnlockInflight.delete(userId);
  }
}

// 查询 XChat 真机身份解锁状态
app.get("/api/x/chat/identity-status", (req, res) => {
  const { user_id } = req.query;
  const cc = chatCryptoCache.get(user_id);
  const blocked = chatUnlockBlocked.get(user_id);
  res.json({
    juiceboxUnlocked: Boolean(cc && cc.isUnlocked()),
    pinConfigured: Boolean(process.env.XCHAT_PIN),
    // 熔断状态：前端据此判断服务端是否已重启（重启后 Map 清空、blocked 变 false），
    // 从而在改对 .env 的 PIN 后无需刷新页面即可自动恢复解锁。
    blocked: Boolean(blocked),
    blockedAt: blocked ? blocked.at : null,
  });
});

// 热更新 PIN（无需重启服务）
//   POST { pin: "1234", sync_env?: true }
//   清除解锁缓存 + 熔断状态，下次解密自动用新 PIN 重新解锁
app.post("/api/x/chat/update-pin", (req, res) => {
  const { pin, sync_env } = req.body || {};
  if (!pin || typeof pin !== "string" || pin.length < 4) {
    return res.status(400).json({ error: "pin_invalid", hint: "PIN 至少 4 位" });
  }

  const oldPin = process.env.XCHAT_PIN;
  process.env.XCHAT_PIN = pin;

  // 清除所有用户的解锁缓存和熔断状态（旧 PIN 解锁的实例作废）
  const clearedUsers = [...chatCryptoCache.keys()];
  chatCryptoCache.clear();
  chatUnlockBlocked.clear();
  chatUnlockInflight.clear(); // 防止进行中的旧 PIN 解锁 promise 写入缓存
  chatUnlockCooldown.clear(); // 清除 token 冷却（新 PIN 需要立即尝试）
  chatPinEpoch++; // epoch 递增，让已发起的旧 unlock promise 不再缓存结果

  // 可选：同步写回 .env 文件（持久化，重启后也生效）
  let envSynced = false;
  if (sync_env !== false) {
    try {
      const fs = require("fs");
      const envPath = path.join(__dirname, ".env");
      let content = fs.readFileSync(envPath, "utf8");
      if (content.includes("XCHAT_PIN=")) {
        content = content.replace(/^XCHAT_PIN=.*/m, `XCHAT_PIN=${pin}`);
      } else {
        content += `\nXCHAT_PIN=${pin}`;
      }
      fs.writeFileSync(envPath, content);
      envSynced = true;
    } catch (err) {
      console.warn(`⚠️ [XChat] PIN 写回 .env 失败: ${err.message}`);
    }
  }

  console.log(`🔄 [XChat] PIN 已热更新（${oldPin ? "旧→新" : "首次设置"}），清除 ${clearedUsers.length} 个缓存实例`);
  res.json({
    success: true,
    cleared: clearedUsers.length,
    envSynced,
    hint: "下次解密将自动用新 PIN 重新解锁 Juicebox 身份",
  });
});

// 用 Juicebox PIN 解锁真机身份（PIN 从环境变量 XCHAT_PIN 读，不落盘）。
// 解锁后即可解密用户在真机/网页 X 里真实收发的加密私信。
//   POST { user_id }
app.post("/api/x/chat/unlock", async (req, res) => {
  const { user_id } = req.body || {};
  try {
    await ensureBinding(user_id);
    if (!process.env.XCHAT_PIN) {
      return res.status(400).json({ error: "pin_not_configured", hint: "在 .env 设置 XCHAT_PIN" });
    }
    // 复用已解锁实例（解锁只做一次；juicebox token 一次性，勿重复解锁）
    const cc = await getChatCrypto(user_id);
    if (!cc) {
      return res.status(422).json({ error: "juicebox_unavailable", hint: "账号无 juicebox_config 或未配置 PIN" });
    }
    res.json({ success: true, unlocked: cc.isUnlocked() });
  } catch (err) {
    // 熔断态：PIN 错误后已停止重试，返回专用错误码让前端不再自动轮询解锁
    if (err.code === "juicebox_locked_out") {
      return res.status(423).json({ error: "juicebox_locked_out", hint: err.message });
    }
    if (isInvalidPinError(err.message)) {
      return res.status(423).json({
        error: "invalid_pin",
        hint: "PIN 不匹配，为保护 Juicebox 猜测配额已停止自动重试。请核对 .env 的 XCHAT_PIN 后重启服务。",
      });
    }
    const status = err.httpStatus || 500;
    console.error("XChat Juicebox 解锁失败:", err.message);
    res.status(status).json({ error: err.message });
  }
});

// 确保已登记某发送者的签名公钥（首次见到该 sender 时从 X 拉取并登记）
async function ensureSigningKeys(cc, api, senderId) {
  if (!senderId || cc.hasSigningKeysFor(senderId)) return;
  try {
    const pks = await api.getPublicKeys(senderId);
    const entries = pks.map((pk) => toSigningKeyEntry(senderId, pk));
    cc.addSigningKeys(senderId, entries);
  } catch (err) {
    console.warn(`⚠️ [XChat] 拉取 sender=${senderId} 公钥失败: ${err.message}`);
  }
}

/**
 * 解密单条实时事件（webhook/轮询）。
 * real-time-events 文档：chat.received 直接含密文 encoded_event；
 * 若带 conversation_key_change_event，先经批量路径吸收新会话密钥再解密。
 * @returns {Promise<{text:string|null, decrypted:boolean, reason?:string}>}
 */
async function decryptChatEvent(userId, { encodedEvent, keyChangeEvent, senderId, signatureInfo }) {
  // 确保 token 有效（webhook 异步路径不经 ensureBinding，需显式刷新）
  try { await ensureBinding(userId); } catch { /* 最坏降级到旧 token */ }

  const cc = await getChatCrypto(userId);
  if (!cc) return { text: null, decrypted: false, reason: "no_identity" };
  if (!encodedEvent) return { text: null, decrypted: false, reason: "no_ciphertext" };

  // 登记会话双方的「全部」签名公钥版本（key change 可能引用任一历史版本）。
  // 优先从 X 拉全量；网络失败时用 payload 自带签名作降级兜底。
  const binding = bindingStore.get(userId);
  const selfId = String(binding?.user?.id || userId);
  let fetched = false;
  if (binding) {
    try {
      const api = new XChatApi(binding.tokens.access_token);
      const [senderPks, myPks] = await Promise.all([
        api.getPublicKeys(senderId),
        api.getPublicKeys(selfId),
      ]);
      cc.addSigningKeys(senderId, senderPks.map((pk) => toSigningKeyEntry(senderId, pk)));
      cc.addSigningKeys(selfId, myPks.map((pk) => toSigningKeyEntry(selfId, pk)));
      fetched = true;
    } catch (err) {
      console.warn(`⚠️ [XChat] 拉取双方公钥失败，降级用 payload 自带签名: ${err.message}`);
    }
  }
  // 降级：网络失败时至少用 payload 自带的 sender 签名公钥
  if (!fetched && signatureInfo?.signing_public_key && senderId) {
    cc.addSigningKeys(senderId, [
      {
        userId: String(senderId),
        publicKeyVersion: String(signatureInfo.public_key_version || ""),
        publicKey: signatureInfo.signing_public_key,
        identityPublicKey: "",
        identityPublicKeySignature: "",
      },
    ]);
  }

  try {
    // 用批量路径喂 [key_change, message]，让 SDK 自动提取会话密钥并解密。
    // 这是验证通过的可靠路径（单条 decryptEvent 依赖密钥已在缓存）。
    const batchIn = [];
    if (keyChangeEvent) batchIn.push(keyChangeEvent);
    batchIn.push(encodedEvent);
    const result = cc.decryptBatch(batchIn);
    const msg = (result.messages || []).find((m) => m.event?.type === "message");
    if (msg) {
      const text = msg.event.content?.text ?? null;
      return { text, decrypted: text != null, event: msg.event, verified: msg.verified };
    }
    // 没解出 message：可能是纯 key change，或验签严格拦截
    const errs = JSON.stringify(result.errors || {});
    return { text: null, decrypted: false, reason: errs.length > 2 ? errs : "no_message" };
  } catch (err) {
    console.warn(`⚠️ [XChat] 解密失败 user=${userId}: ${err.message}`);
    return { text: null, decrypted: false, reason: err.message };
  }
}

// 手动解密整个会话历史（批量路径）：拉取加密事件 → 批量解密 → 返回明文列表
//   POST { user_id, conversation_id }
app.post("/api/x/chat/decrypt-conversation", async (req, res) => {
  const { user_id, conversation_id } = req.body || {};
  try {
    const binding = await ensureBinding(user_id);
    const cc = await getChatCrypto(user_id);
    if (!cc) {
      return res.status(400).json({ error: "identity_not_unlocked", hint: "先调用 /api/x/chat/unlock 解锁真机身份" });
    }
    if (!conversation_id) {
      return res.status(400).json({ error: "conversation_id_required" });
    }

    const api = new XChatApi(binding.tokens.access_token);
    const page = await api.getEvents(conversation_id, { maxResults: 100 });
    const raw = page.data ?? [];

    // 登记所有出现过的发送者 + 自己的签名公钥（key change 验签需要会话双方）
    const senders = new Set(
      raw.map((e) => String(e.senderId ?? e.sender_id ?? "")).filter(Boolean)
    );
    senders.add(String(binding.user?.id || user_id));
    for (const s of senders) await ensureSigningKeys(cc, api, s);

    const eventsB64 = raw
      .map((e) => e.encodedEvent ?? e.encoded_event)
      .filter(Boolean);
    const result = cc.decryptBatch(eventsB64);

    const messages = (result.messages || [])
      .filter((m) => m.event?.type === "message")
      .map((m) => ({
        senderId: m.event.senderId ?? m.event.sender_id,
        text: m.event.content?.text ?? null,
        createdAt: m.event.createdAtMsec
          ? new Date(Number(m.event.createdAtMsec)).toISOString()
          : null,
      }));

    console.log(
      `🔓 [XChat] 会话 ${conversation_id} 解密：明文 ${messages.length} 条 / 原始 ${eventsB64.length} 条`
    );
    res.json({ success: true, count: messages.length, messages });
  } catch (err) {
    const status = err.httpStatus || 500;
    console.error("XChat 会话解密失败:", err.message);
    res.status(status).json({ error: err.message });
  }
});

// 获取本地缓存的（已尝试解密的）Chat 事件
app.get("/api/x/chat/local-events", (req, res) => {
  const events = dmEventStore.filter(
    (e) => e.type === "chat.received" || e.type === "chat.sent"
  );
  res.json({ events, count: events.length });
});

/**
 * 统一媒体响应：写 Content-Type / Content-Disposition / 缓存头，并支持
 * HTTP Range 单区间请求（视频 seek / 断点续传）。bytes 为已解密的明文字节。
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {Buffer} bytes
 * @param {string} contentType
 * @param {string} filename 原始文件名（用于 Content-Disposition）
 * @param {{download?: boolean}} [opts]
 */
function sendMediaBytes(req, res, bytes, contentType, filename, { download = false } = {}) {
  const total = bytes.length;
  const fn = filename || "attachment";
  const disposition =
    (download ? "attachment" : "inline") + `; filename*=UTF-8''${encodeURIComponent(fn)}`;

  res.setHeader("Content-Type", contentType || "application/octet-stream");
  res.setHeader("Content-Disposition", disposition);
  res.setHeader("Cache-Control", "private, max-age=300");
  res.setHeader("Accept-Ranges", "bytes");

  // Range：单区间（bytes=start-end / bytes=start- / bytes=-suffix）
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m) {
      let start = m[1] === "" ? null : parseInt(m[1], 10);
      let end = m[2] === "" ? null : parseInt(m[2], 10);
      if (start === null) {
        start = Math.max(total - (end || 0), 0);
        end = total - 1;
      } else if (end === null || end >= total) {
        end = total - 1;
      }
      if (start < 0 || start >= total || start > end) {
        res.status(416).setHeader("Content-Range", `bytes */${total}`);
        return res.end();
      }
      res.status(206);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
      res.setHeader("Content-Length", end - start + 1);
      return res.send(bytes.subarray(start, end + 1));
    }
  }

  res.setHeader("Content-Length", total);
  res.send(bytes);
}

// 媒体代理端点：下载 + 解密 Chat E2EE 加密媒体，返回明文字节
//   GET /api/x/chat/media?user_id=...&conversation_id=...&attachment_id=[&download=1]
app.get("/api/x/chat/media", async (req, res) => {
  const { user_id, conversation_id, attachment_id, download } = req.query;
  if (!user_id || !conversation_id || !attachment_id) {
    return res.status(400).json({ error: "缺少 user_id / conversation_id / attachment_id" });
  }
  const forceDownload = download === "1" || download === "true";

  // 内存缓存命中
  const cached = mediaCache.get(attachment_id);
  if (cached) {
    return sendMediaBytes(req, res, cached.bytes, cached.type, cached.filename, {
      download: forceDownload,
    });
  }

  try {
    const binding = await ensureBinding(user_id);
    const cc = await getChatCrypto(user_id);
    if (!cc) return res.status(422).json({ error: "identity_not_unlocked" });

    // 从 dmEventStore 查找含该附件的 record
    const record = dmEventStore.find(
      (e) =>
        e.ownerUserId === user_id &&
        e.conversationId === conversation_id &&
        e.attachments?.some((a) => a.attachmentId === attachment_id)
    );
    if (!record) return res.status(404).json({ error: "attachment_not_found" });

    const att = record.attachments.find((a) => a.attachmentId === attachment_id);

    // 提取会话密钥
    let convKey = null;
    if (record.keyChangeEvent) {
      const api = new XChatApi(binding.tokens.access_token);
      // 确保签名公钥已登记（extractConversationKeys 验签需要）
      await ensureSigningKeys(cc, api, record.senderId);
      await ensureSigningKeys(cc, api, String(binding.user?.id || user_id));
      const { keys } = cc.extractConversationKeys([record.keyChangeEvent]);
      const ver = String(record.mediaKeyVersion || record.conversationKeyVersion || "");
      convKey = keys[ver];
    }
    if (!convKey) {
      return res.status(422).json({ error: "no_conversation_key", hint: "无法提取会话密钥" });
    }

    // 下载加密媒体
    const client = new Client({ accessToken: binding.tokens.access_token });
    const convIdPath = conversation_id.replaceAll(":", "-");
    const buf = await client.chat.mediaDownload(convIdPath, att.mediaHashKey);

    // 解密
    const plain = cc.decryptStream(new Uint8Array(buf), convKey);
    const bytes = Buffer.from(plain);

    // 类型判定：归一化 MIME 优先，魔数嗅探兜底（file 类 / 无扩展名场景）
    const contentType =
      att.mime && att.mime !== "application/octet-stream" ? att.mime : sniffMime(bytes);

    // 缓存（LRU 简化：超限删最旧）
    if (mediaCache.size >= MEDIA_CACHE_MAX) {
      const oldest = mediaCache.keys().next().value;
      mediaCache.delete(oldest);
    }
    mediaCache.set(attachment_id, {
      bytes,
      type: contentType,
      filename: att.filename || null,
      at: Date.now(),
    });

    sendMediaBytes(req, res, bytes, contentType, att.filename, { download: forceDownload });
  } catch (err) {
    const status = err.httpStatus || 500;
    console.error(`⚠️ [XChat] 媒体代理失败: ${err.message}`);
    res.status(status).json({ error: err.message });
  }
});

// 旧 DM 媒体代理端点：按 message_id + media_key 反查并转发媒体字节
//   GET /api/x/dm/media?message_id=...&media_key=...[&download=1]
app.get("/api/x/dm/media", async (req, res) => {
  const { message_id, media_key, download } = req.query;
  if (!message_id || !media_key) {
    return res.status(400).json({ error: "缺少 message_id / media_key" });
  }
  const forceDownload = download === "1" || download === "true";

  const record = dmEventStore.find((e) => e.id === message_id);
  if (!record) return res.status(404).json({ error: "message_not_found" });

  let att = (record.attachments || []).find((a) => a.mediaKey === media_key) || null;
  // 媒体尚未反查（或服务重启丢内存）→ 现场反查一次
  if (!att) {
    const atts = await resolveDmMedia(record.ownerUserId || record.senderId, record);
    record.attachments = atts;
    att = atts.find((a) => a.mediaKey === media_key) || null;
  }
  if (!att) return res.status(404).json({ error: "media_not_found" });

  const targetUrl = att.url || att.previewUrl;
  if (!targetUrl) return res.status(404).json({ error: "no_media_url" });

  try {
    // 视频/动图/缩略图走公开 CDN（免鉴权）；照片 ton.twitter.com 需 OAuth 1.0a，
    // 本 demo 仅 OAuth2 → 会 401/403，返回兜底查看地址（在 X 中查看）。
    const mediaRes = await fetch(targetUrl, { redirect: "follow" });
    if (!mediaRes.ok) {
      return res.status(403).json({
        error: "media_download_forbidden",
        hint:
          att.kind === "image"
            ? "DM 照片需 OAuth 1.0a 用户上下文才能内联（本 demo 仅 OAuth2）"
            : "媒体地址不可用或已过期",
        fallbackUrl: att.fallbackUrl || null,
      });
    }
    const bytes = Buffer.from(await mediaRes.arrayBuffer());
    const contentType =
      mediaRes.headers.get("content-type") ||
      (att.kind === "video" || att.kind === "gif" ? "video/mp4" : "image/jpeg");
    sendMediaBytes(req, res, bytes, contentType, att.filename, { download: forceDownload });
  } catch (err) {
    console.error(`⚠️ [DM] 媒体代理失败: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Token 自动刷新辅助函数
// ---------------------------------------------------------------------------
async function refreshTokens(binding) {
  const tokenRes = await fetch("https://api.x.com/2/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization:
        "Basic " +
        Buffer.from(
          `${process.env.CLIENT_ID}:${process.env.CLIENT_SECRET}`
        ).toString("base64"),
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: binding.tokens.refresh_token,
    }),
  });

  if (!tokenRes.ok) throw new Error("refresh_failed");

  const tokens = await tokenRes.json();
  binding.tokens = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token || binding.tokens.refresh_token,
    expires_in: tokens.expires_in,
    expires_at: Date.now() + tokens.expires_in * 1000,
    scope: tokens.scope,
    token_type: tokens.token_type,
  };
  saveState();
}

// ---------------------------------------------------------------------------
// 启动服务
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
loadState(); // 启动时从 .data/state.json 恢复绑定 + webhook
app.listen(PORT, () => {
  console.log(`\n🚀 X 账号绑定授权 Demo 已启动`);
  console.log(`   地址: http://localhost:${PORT}`);
  console.log(`   回调: ${process.env.CALLBACK_URL}`);
  console.log(`   Scope: ${process.env.SCOPE}`);
  console.log(`   Webhook: ${process.env.WEBHOOK_URL}\n`);
});
