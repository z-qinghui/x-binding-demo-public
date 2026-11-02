/**
 * X Chat API 客户端封装（基于官方 @xdevplatform/xdk）
 *
 * 认证：OAuth2 用户 access token（scope 需含 dm.read + dm.write）。
 * 职责：拉取会话加密事件、获取用户公钥、注册本身份公钥、发送加密消息。
 * 所有解密/加密由 lib/chat-crypto.js 完成，本模块只负责网络 I/O。
 */
"use strict";

const { Client } = require("@xdevplatform/xdk");

const BASE_URL = "https://api.x.com";

/** 会话 ID 在 REST 路径里用 '-' 代替 ':'（参照官方示例）。 */
function pathConversationId(conversationId) {
  return String(conversationId).replaceAll(":", "-");
}

class XChatApi {
  constructor(accessToken) {
    if (!accessToken) throw new Error("access_token_required");
    this.accessToken = accessToken;
    this.client = new Client({ accessToken });
  }

  /** 当前授权用户的 userId。 */
  async getMyUserId() {
    const resp = await this.client.users.getMe();
    return String(resp.data.id);
  }

  /**
   * 获取某用户已注册的公钥数组（含 signing/identity 公钥、版本、juicebox_config）。
   * 用于验签与会话密钥交换。
   */
  async getPublicKeys(userId) {
    const resp = await this.client.users.getPublicKey(userId);
    const data = resp.data ?? [];
    return Array.isArray(data) ? data : [data];
  }

  /**
   * 拉取会话的原始（加密）事件，每条含 base64 密文 encoded_event。
   * @returns {Promise<{ data: any[], meta: object }>}
   */
  async getEvents(conversationId, { maxResults = 50, paginationToken } = {}) {
    return this.client.chat.getConversationEvents(pathConversationId(conversationId), {
      maxResults,
      paginationToken,
    });
  }

  /** 发送一条由 chat-crypto encryptMessage 产出的加密消息。 */
  async sendMessage(conversationId, body) {
    return this.client.chat.sendMessage(pathConversationId(conversationId), {
      messageId: body.message_id,
      encodedMessageCreateEvent: body.encoded_message_create_event,
      encodedMessageEventSignature: body.encoded_message_event_signature,
      conversationToken: body.conversation_token,
    });
  }

  /** 提交会话密钥交换（初始化或轮换）。 */
  async addConversationKeys(conversationId, body) {
    return this.client.chat.addConversationKeys(pathConversationId(conversationId), body);
  }

  /**
   * 拉取某用户最新的原始公钥记录（snake_case，绕过 xdk camelCase 规范化）。
   * 关键：version 必须与 juicebox_config 同源取自原始 fetch，否则解密时身份版本
   * 对齐失败（会话密钥提取不到）。
   * @param {string} userId
   * @returns {Promise<{config: object, version: string}|null>} 无 juicebox_config 时 null
   */
  async getJuiceboxConfig(userId) {
    const r = await fetch(
      `${BASE_URL}/2/users/${encodeURIComponent(userId)}/public_keys`,
      { headers: { Authorization: `Bearer ${this.accessToken}` } }
    );
    if (!r.ok) throw new Error(`get_public_keys_failed: HTTP ${r.status}`);
    const j = await r.json();
    const arr = Array.isArray(j.data) ? j.data : j.data ? [j.data] : [];
    const withJb = arr.filter((p) => p.juicebox_config);
    if (!withJb.length) return null;
    const versionOf = (p) => Number(p.public_key_version || 0);
    const latest = withJb.reduce((best, p) => (versionOf(p) >= versionOf(best) ? p : best), withJb[0]);
    return { config: latest.juicebox_config, version: String(latest.public_key_version) };
  }
}

/**
 * 把 X 公钥接口返回的一条记录，转换为 chat-xdk setSigningKeys 需要的条目。
 * 兼容 camelCase / snake_case 两种字段命名。
 */
function toSigningKeyEntry(userId, pk) {
  return {
    userId: String(userId),
    publicKeyVersion: String(pk.publicKeyVersion ?? pk.public_key_version ?? ""),
    publicKey: pk.signingPublicKey ?? pk.signing_public_key ?? "",
    identityPublicKey: pk.publicKey ?? pk.public_key ?? "",
    identityPublicKeySignature:
      pk.identityPublicKeySignature ?? pk.identity_public_key_signature ?? "",
  };
}

module.exports = { XChatApi, toSigningKeyEntry, pathConversationId };
