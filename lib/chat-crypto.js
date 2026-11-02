/**
 * chat-xdk 加密核心封装（CommonJS ← 动态 import ESM WASM）
 *
 * X 新版 Chat 是端到端加密（E2EE）：webhook 只推送元数据 + 密文，需用本模块解密。
 * 仅走 Juicebox PIN（真机身份）路径：用用户 4 位 PIN 从 Juicebox 恢复其真实设备
 * 密钥，可解密用户在真机/网页 X 里收发的真实加密私信。createWithJuicebox() → unlock(pin)。
 *
 * 会话模型（一次性设置，参照官方示例 bot）：
 *   - setIdentity(userId, version)  每个签名动作的默认发送者 + 身份公钥版本
 *   - setSigningKeys(entries)       验签用的参与者公钥（需登记会话双方全部版本）
 *   - setCacheKeys(true)            解密时缓存会话密钥，供后续单条解密/加密复用
 *
 * ⚠️ PIN 是账号 E2E 最高凭据。服务端持有即削弱端到端保证。切勿泄露/提交/打日志。
 */
"use strict";

const path = require("path");
const { readFile } = require("node:fs/promises");

const PKG_DIR = path.resolve(
  __dirname,
  "..",
  "node_modules",
  "@xdevplatform",
  "chat-xdk",
  "pkg"
);
const WASM_JS = path.join(PKG_DIR, "chat_xdk_wasm.js");
const WASM_BIN = path.join(PKG_DIR, "chat_xdk_wasm_bg.wasm");

const SIGNING_KEY_VERSION = "1";

// WASM 模块单例（进程内只初始化一次）
let wasmModule = null;
let wasmReady = null;

/** 懒加载并初始化 WASM 引擎，返回模块导出。 */
async function ensureWasm() {
  if (wasmModule) return wasmModule;
  if (!wasmReady) {
    wasmReady = (async () => {
      const mod = await import(WASM_JS);
      await mod.default({ module_or_path: await readFile(WASM_BIN) });
      wasmModule = mod;
      return mod;
    })();
  }
  return wasmReady;
}

// chat-xdk 高层 API（Juicebox 路径）动态 import 缓存
let highLevelApi = null;
async function ensureHighLevel() {
  if (!highLevelApi) highLevelApi = await import("@xdevplatform/chat-xdk");
  return highLevelApi;
}

/**
 * 从 X 公钥接口返回的 juicebox_config 构造 getAuthToken 回调所需的 realm token 表。
 * token_map: [{ key, value: { address, token } }]
 * @returns {(realmId: string) => Promise<string>}
 */
function buildGetAuthToken(juiceboxConfig) {
  const tokenByAddress = new Map();
  const tokenMap = juiceboxConfig.token_map || [];
  for (const t of tokenMap) {
    if (t.value?.address) tokenByAddress.set(t.value.address, t.value.token);
  }
  return async (realmId) => {
    if (tokenByAddress.has(realmId)) return tokenByAddress.get(realmId);
    for (const [addr, tok] of tokenByAddress) {
      if (addr.includes(realmId) || realmId.includes(addr)) return tok;
    }
    const byKey = tokenMap.find((t) => t.key === realmId);
    return byKey ? byKey.value.token : "";
  };
}

/**
 * 单个 XChat 身份的加密上下文。一个绑定用户对应一个实例。
 * 封装底层 WASM Chat（blob）或高层 Juicebox Chat，方法名一致。
 */
class ChatCrypto {
  #chat;
  #wasm;
  #userId = null;
  signingKeyVersion = SIGNING_KEY_VERSION;
  // userId -> signing key entries（供 setSigningKeys 全量重设）
  #signingKeys = new Map();

  constructor(wasm, chat) {
    this.#wasm = wasm;
    this.#chat = chat;
  }

  /**
   * 异步工厂（Juicebox PIN 模式）：用真机身份密钥。
   * 构造后需调用 unlock(pin) 才能恢复密钥。
   * @param {object} juiceboxConfig X 公钥接口返回的原始 juicebox_config（snake_case）
   */
  static async createWithJuicebox(juiceboxConfig) {
    const wasm = await ensureWasm();
    const { createChat } = await ensureHighLevel();
    const chat = await createChat({
      juiceboxConfig: JSON.stringify(juiceboxConfig),
      getAuthToken: buildGetAuthToken(juiceboxConfig),
    });
    return new ChatCrypto(wasm, chat);
  }

  /** 用 PIN 从 Juicebox 恢复真机身份密钥。 */
  async unlock(pin) {
    await this.#chat.unlock(pin);
  }

  /** 是否已解锁。 */
  isUnlocked() {
    return this.#chat.isUnlocked ? this.#chat.isUnlocked() : this.#chat.hasIdentityKey();
  }

  base64ToBytes(b64) {
    return this.#wasm.base64ToBytes(b64);
  }

  bytesToBase64(bytes) {
    return this.#wasm.bytesToBase64(bytes);
  }

  // -- 身份 / 密钥管理 ------------------------------------------------------

  /**
   * 用本实例自身的公钥登记「我方」签名密钥（无网络依赖）。
   * key change 验签常需会话双方公钥；解锁后调用可补齐我方一侧。
   * @param {string} userId 我方 userId
   * @param {string} [version] 公钥版本（默认取实例当前版本）
   */
  registerSelfSigningKey(userId, version) {
    const pk = this.#chat.getPublicKeys();
    this.addSigningKeys(userId, [
      {
        userId: String(userId),
        publicKeyVersion: String(version || pk.version || this.signingKeyVersion),
        publicKey: pk.signing || "",
        identityPublicKey: pk.identity || "",
        identityPublicKeySignature: "",
      },
    ]);
  }

  /** 返回本身份的公钥（identity / signing / version）。 */
  publicKeys() {
    return this.#chat.getPublicKeys();
  }

  // -- 会话设置（一次性）---------------------------------------------------

  /**
   * 设置会话身份：后续所有加密/签名默认以此 userId 为发送者。
   * @param {string} userId 我方 userId
   * @param {string} [version] 身份公钥版本（应传 X 侧最新版本，用于解密对齐）
   */
  setIdentity(userId, version) {
    this.#userId = String(userId);
    if (version) this.signingKeyVersion = String(version);
    this.#chat.setIdentity(this.#userId, this.signingKeyVersion);
  }

  get userId() {
    return this.#userId;
  }

  /** 开启会话密钥缓存：批量解密时缓存密钥，供后续单条解密/加密复用。 */
  setCacheKeys(enabled) {
    this.#chat.setCacheKeys(Boolean(enabled));
  }

  /**
   * 是否拒绝验签失败的事件。默认 true（严格）。
   * 设为 false 时，签名无法验证（如 key change 用了未发布的签名公钥版本）
   * 的事件仍会被解密并标记 verified:false —— 用于 demo 演示解密能力。
   */
  setRejectUnverified(reject) {
    this.#chat.setRejectUnverified(Boolean(reject));
  }

  /**
   * 登记某发送者的签名公钥（来自 X 公钥接口）。内部按 userId 去重合并，
   * 每次变更后全量重设到底层（setSigningKeys 会替换旧集合）。
   * @param {string} userId
   * @param {Array<object>} entries chat-xdk 签名密钥条目数组
   */
  addSigningKeys(userId, entries) {
    this.#signingKeys.set(String(userId), entries);
    this.#chat.setSigningKeys([...this.#signingKeys.values()].flat());
  }

  /** 是否已登记该发送者的签名密钥。 */
  hasSigningKeysFor(userId) {
    return this.#signingKeys.has(String(userId));
  }

  // -- 解密：两条路径 ------------------------------------------------------

  /**
   * 批量解密（初始加载）。自动从 KeyChange 事件提取会话密钥填入缓存，
   * 单条错误收集在结果里，不抛异常。
   * @param {string[]} eventsB64 base64 编码的原始事件数组
   */
  decryptBatch(eventsB64) {
    return this.#chat.decryptEvents(eventsB64);
  }

  /**
   * 单条解密（webhook / 实时）。会话密钥从缓存解析，签名密钥从登记的 store 解析。
   * 解密失败会抛异常。
   * @param {string} eventB64 base64 编码的单个原始事件
   */
  decryptOne(eventB64) {
    return this.#chat.decryptEvent(eventB64);
  }

  // -- 媒体（图片 / 视频附件）-------------------------------------------------

  /**
   * 从原始 KeyChange 事件提取并解密会话密钥表（keyVersion → 原始会话密钥）。
   * 媒体下载后的 decryptStream 需要按消息 keyVersion 找到对应会话密钥。
   * @param {string[]} eventsB64 原始 KeyChange 事件 base64 数组
   */
  extractConversationKeys(eventsB64) {
    return this.#chat.extractConversationKeys(eventsB64);
  }

  /**
   * 解密流式加密载荷（媒体字节）。下载的媒体是加密原始字节，需此方法还原明文。
   * @param {Uint8Array} encrypted 加密的媒体字节
   * @param {Uint8Array} conversationKey 会话密钥（extractConversationKeys 按 keyVersion 取）
   */
  decryptStream(encrypted, conversationKey) {
    return this.#chat.decryptStream(encrypted, conversationKey);
  }

  // -- 加密（回复）--------------------------------------------------------

  /**
   * 加密并签名一条消息，返回可直接提交给 X Chat API 的字段。
   * @param {{ conversationId: string, text: string, replyToEvent?: string }} p
   */
  encryptMessage({ conversationId, text, replyToEvent }) {
    const params = { conversationId, text };
    const payload = replyToEvent
      ? this.#chat.encryptReply({ ...params, replyToEvent })
      : this.#chat.encryptMessage(params);
    return {
      message_id: payload.messageId,
      encoded_message_create_event: payload.encryptedContent,
      encoded_message_event_signature: payload.encodedEventSignature,
    };
  }

  /**
   * 发起 1:1 会话密钥交换负载（首次与对方通信前需要）。
   * @param {Array<{userId:string, publicKey:string, keyVersion:string}>} publicKeys
   * @param {string} [conversationId] 群聊需传；1:1 省略则由 SDK 推导
   */
  prepareConversationKeyChange(publicKeys, conversationId) {
    return this.#chat.prepareConversationKeyChange({ publicKeys, conversationId });
  }
}

module.exports = { ensureWasm, ChatCrypto, SIGNING_KEY_VERSION };
