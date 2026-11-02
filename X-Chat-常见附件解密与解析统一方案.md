# X 私信附件/媒体解密与解析统一方案（新版 Chat E2EE + 旧版 DM）

> 基于 `x-binding-demo` 项目与 `.data/webhook-events.log` 今日（2026-08-24）真实推送日志的解密实测，
> 评估「前端私信工作台附件展示不正常」问题的统一处理方案，并给出可落地的解密 + 解析技术文档。
>
> 覆盖两条私信通道：**新版 Chat 加密私信（E2EE，含 md/mp4/pdf/zip/docx 加密附件）** 与
> **旧版 DM 明文私信（仅文本/表情/图片/视频，无文件附件）**。

---

## 〇、结论先行

### 两条私信通道总览

| 维度 | 新版 Chat 加密私信（E2EE） | 旧版 DM 明文私信 |
|------|--------------------------|----------------|
| 事件类型 | `chat.received` / `chat.sent` | `dm.received` / `dm.sent` |
| 消息内容 | `payload.encoded_event`（密文）+ `conversation_key_change_event` | `message_data.text`（明文）+ `message_data.entities` |
| 是否加密 | 端到端加密，需 Juicebox PIN 解锁 + WASM 解密 | 明文，无需解密 |
| 支持的附件形态 | 任意文件附件（md/mp4/pdf/zip/docx 等加密 media） | **仅文本、表情、图片、视频**（官方客户端不支持文件附件） |
| 媒体获取 | `client.chat.mediaDownload` 下载密文 → `cc.decryptStream` 解密 | X API v2 `dm_events`（media 扩展）反查直接地址 |
| 媒体鉴权 | 会话密钥解密（服务端持有密钥） | 视频/动图=公开 CDN；**照片=OAuth 1.0a**（OAuth2 被拒） |

### 新版 Chat 加密私信（E2EE）

1. **可统一处理。** 实测确认：X 新版 Chat（E2EE）里，`md / mp4 / pdf / zip / docx` 五种附件**走的都是同一条「加密 media 附件」链路**，与图片/视频没有任何结构性差异——它们都是解密消息里的 `media` 类型附件，仅凭 `mediaType`（或 `type`）字段 + `filename` 扩展名即可区分。
2. **解密链路已打通。** 项目里 `server.js` 的 `/api/x/chat/media` 端点已经能**下载加密媒体 → 解密 → 返回明文字节**（本次实测 md / mp4 / pdf / zip / docx 五类文件全部解密成功，魔数正确）。**问题不在解密，而在「类型判定 + 前端渲染 + 响应头」这一环。**
3. **根因定位。** 前端 `public/app.js` 两处渲染逻辑只把 `type === "video"` 当 `<video>`，其余一律当 `<img>`，于是 `file` 类型（md/pdf/zip/docx）被当作图片加载二进制 → 破图；媒体代理对 `file` 一律返回 `application/octet-stream` 且不带文件名，浏览器无法按文件名下载/预览。
4. **统一方案。** 建立一条「**解密 → 归一化元数据 → 类型判定（mediaType + 扩展名 + 魔数）→ 分类渲染/下载**」的管线，即可用一套代码覆盖所有附件格式。

### 旧版 DM 明文私信

5. **无文件附件。** 官方客户端发送旧版 DM 仅支持**文本、表情（Unicode 内嵌）、图片、视频**，不支持 md/pdf/zip/docx 等附件文件。
6. **媒体需二次反查。** webhook 的 `message_data` 不带 `attachment.media`，图片/视频以 `entities.urls` 的 `t.co` 短链（`expanded_url = twitter.com/messages/media/<id>`）标识，需调 `dm_events`（media 扩展）反查直接媒体地址。
7. **下载鉴权实测。** 视频/动图在公开 CDN（免鉴权，可直接内联播放）；照片走 `ton.twitter.com`，仅接受 **OAuth 1.0a**（OAuth2 被拒：`You are not permitted to use OAuth2 on this endpoint`），OAuth2 环境照片无法内联预览，兜底跳转 X 查看。

---

## 一、日志实测：五种附件在解密消息里的真实结构

对 `.data/webhook-events.log` 中今日全部 53 条 `chat.received/chat.sent` 事件做批量解密后，含附件的消息结构如下（已脱敏为字段名）：

### 1.1 解密后的顶层事件结构（`chat-xdk` 返回）

```
Event {
  type: "message"
  senderId: "2079439120540274688"          // 发送方
  conversationId: "2046970020232830976:2079439120540274688"
  createdAtMsec: 1787545152505
  verified: true | false
  keyVersion: "1785821462609"              // ★ 本消息及附件的加密会话密钥版本
  content: MessageContent {
    contentType: null                       // 文本类消息此处可能为空，text 字段有值
    text: "给你发个 md 文档"                 // 明文文本
    attachments: [ { media: {...} } ]       // ★ 原始嵌套结构（见 1.2）
  }
  attachments: [ AttachmentInfo ]           // ★ 扁平化结构（见 1.3，与上面是同一批附件）
  mediaHashes: [ { source: "media", mediaHashKey: "..." } ]
}
```

### 1.2 `event.content.attachments[]` —— 原始嵌套结构（`{ media: {...} }`）

这是 `server.js` 的 `extractChatAttachments()` 当前实际读取的路径（`a.media.*`）：

```jsonc
// md
{ "media": {
    "mediaHashKey": "iaG6rXqIWY",           // 下载加密媒体的句柄
    "attachmentId": "<attachment-id>",
    "type": "file",                          // ★ 判别键：image / gif / video / file
    "filename": "prompt.md",                 // ★ 原始文件名（含扩展名）
    "filesizeBytes": 2777,                   // 注意：加密后大小（见 §6 大小对比）
    "dimensions": null,                      // 图片/视频有 {width,height}
    "durationMillis": null,                  // 视频/gif 有
    "legacyMediaUrlHttps": null, "legacyMediaPreviewUrl": null
} }
```

### 1.3 `event.attachments[]` —— 扁平化结构（判别键为 `mediaType`）

chat-xdk 同时提供了扁平化版本，字段略有差异（判别键从 `type` 变为 `mediaType`，但 `attachment_type` 仍是 snake_case）：

```jsonc
{ "attachment_type": "media",
  "mediaHashKey": "iaG6rXqIWY",
  "mediaType": "file",                       // ★ 判别键（扁平版用 mediaType，不是 type）
  "filename": "prompt.md",
  "filesizeBytes": 2777,
  "attachmentId": "<attachment-id>",
  "dimensions": null, "durationMillis": null }
```

> ⚠️ 注意两种结构判别字段命名不一致：嵌套版是 `media.type`，扁平版是 `mediaType`。统一方案应做一层**归一化**，把两者都映射到同一张表（见 §4）。

### 1.4 五种格式实测快照

| 消息文本         | mediaType/type | filename                                    | filesizeBytes(加密) | 解密后字节 | 魔数                                              | 判定  |
| ---------------- | -------------- | ------------------------------------------- | ------------------- | ---------- | ------------------------------------------------- | ----- |
| 给你发个 md 文档 | `file`       | `prompt.md`                               | 2,777               | 2,702      | 纯 UTF-8 文本                                     | 文本  |
| 给你发个 mp4     | `video`      | `视频.mp4`                                | 3,305,898           | 3,251,882  | `00 00 00 20 66 74 79 70 ...`（`ftyp`，isom） | 视频  |
| 这是个pdf        | `file`       | `基于LLM的多方对话意图识别与越界检测.pdf` | 337,735             | 332,186    | `%PDF-1.3`                                      | PDF   |
| 这是个 zip 包    | `file`       | `豆包插件v1.35.0.zip`                     | 21,035,903          | 20,692,343 | `50 4B 03 04`（`PK..`）                       | ZIP   |
| 这是个 word      | `file`       | `专利交底书撰写助手.docx`                 | 6,300,538           | 6,197,613  | `50 4B 03 04`（`PK..`）                       | OOXML |

> 结论：**mp4 的 `mediaType` 是 `video`，其余四类的 `mediaType` 是 `file`**；`file` 类必须靠 `filename` 扩展名（必要时靠魔数兜底）二次判定具体格式。

---

## 二、附件接收 + 解密完整链路

X Chat 的附件不是「明文 URL 直接下载」，而是「**加密媒体字节 + 会话密钥**」两段式。完整链路如下：

```
1. Webhook 收到 chat.received
   ├─ payload.encoded_event                     ← 消息密文（base64）
   └─ payload.conversation_key_change_event     ← 会话密钥交换密文（含加密的会话密钥表）

2. chat-xdk 解密消息元数据
   cc.decryptBatch([keyChangeEvent, encodedEvent])
   → 得到明文 Event：content.text + content.attachments[] + keyVersion

3. 拿到附件的 mediaHashKey / attachmentId / filename / type

4. 下载「加密」媒体字节（X Chat API）
   client.chat.mediaDownload(pathConversationId(conversationId), mediaHashKey)
   → 返回加密的原始字节（Buffer）

5. 提取「会话密钥」（按消息 keyVersion 取）
   cc.extractConversationKeys([keyChangeEvent])  → { keys: { <keyVersion>: <会话密钥> } }
   conversationKey = keys[ event.keyVersion ]

6. 解密媒体字节
   cc.decryptStream(new Uint8Array(encryptedBuffer), conversationKey)
   → 返回明文字节 Uint8Array

7. 类型判定（mediaType + 扩展名 + 魔数）→ 返回正确 Content-Type / 或交给前端渲染
```

其中第 4~6 步在项目里已经实现，位于 `server.js` 的 `/api/x/chat/media`（[server.js#L1470-L1553](server.js#L1470-L1553)）。本次实测确认第 2/4/5/6 步均正常，五种文件解密后字节的魔数与格式完全匹配。

---

## 三、现状问题根因

### 3.1 前端渲染只认 video，其余全当图片

`public/app.js` 两处渲染（私信工作台 `renderMessagesForUser`，XChat 面板 `renderChatDecrypted`）：

```js
// public/app.js 现状（两处相同逻辑）
if (att.type === "video") {
  return `<video controls ... src="${url}"></video>`;
}
return `<img ... src="${url}" />`;   // ← md/pdf/zip/docx 走到这里
```

- `file` 类型的 md/pdf/zip/docx → 被 `<img>` 加载二进制 → **破图/空白**。
- `video` 类型的 mp4 → 走 `<video>`，但存在次要体验问题（见 3.3）。

### 3.2 媒体代理响应头不完整

`/api/x/chat/media` 的 Content-Type 推断只覆盖了图片/视频（[server.js#L1526-L1536](server.js#L1526-L1536)）：

```js
if (att.type === "video") contentType = "video/mp4";
else if (bytes[0]===0xff && bytes[1]===0xd8) contentType = "image/jpeg";
else if (bytes[0]===0x89 && bytes[1]===0x50) contentType = "image/png";
else if (att.type === "image") contentType = "image/jpeg";
// 其余（file）→ 落到默认 application/octet-stream
```

- `file` 类型无扩展名 → MIME 映射，一律 `application/octet-stream`（浏览器只会「另存为」且无名）。
- **没有 `Content-Disposition`**，即使浏览器下载也拿不到 `filename`。
- **没有 HTTP Range 支持**（Express `res.send` 不自动处理 Range），大视频无法拖动/seek。

### 3.3 mp4 为什么也「展示不正常」

mp4 的 `type==="video"` 本应命中 `<video>` 分支，实测其解密字节也正确（`ftyp` 头）。仍可能表现异常的原因：

1. `<video preload="none">` 无 poster，未播放时是黑屏，观感像「坏了」；
2. 代理端点不支持 **Range 请求**，无法 seek、部分浏览器无法流式播放；
3. 个别 mp4 编码（如 H.265/HEVC）浏览器不支持解码；
4. Content-Type 虽为 `video/mp4`，但无 `Accept-Ranges` 时 Safari 等可能拒绝播放。

统一方案里把 video 纳入同一条管线，并（可选）补齐 Range 即可根治。

---

## 四、统一方案：一条「解密 → 归一化 → 判定 → 渲染」管线

### 4.1 归一化附件元数据

把两种结构（`content.attachments[].media.*` 与 `attachments[].*`）统一映射成一个中间模型：

```js
// lib 建议新增 lib/chat-attachment.js（示意）
const MIME_BY_EXT = {
  md:  "text/markdown",
  txt: "text/plain",
  pdf: "application/pdf",
  zip: "application/zip",
  docx:"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  pptx:"application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  mp4: "video/mp4", mov:"video/quicktime",
  jpg: "image/jpeg", jpeg:"image/jpeg", png:"image/png", gif:"image/gif", webp:"image/webp",
};

function extOf(filename) {
  const m = /\.([A-Za-z0-9]+)$/.exec(filename || "");
  return m ? m[1].toLowerCase() : "";
}

function classify(rawType, ext) {
  const t = String(rawType || "").toLowerCase();
  if (t === "image") return "image";
  if (t === "gif")   return "gif";
  if (t === "video") return "video";
  // file 类按扩展名细分，便于前端决定是否可内嵌预览
  if (ext === "md" || ext === "txt") return "text";
  if (ext === "pdf") return "pdf";
  return "file";               // zip / docx / 其他
}

// 输入：event.content.attachments[i].media 或 event.attachments[i]
// 输出：统一中间模型
function normalizeAttachment(a) {
  const m = a && a.media ? a.media : a;        // 兼容两种结构
  const filename = m.filename || "";
  const ext = extOf(filename);
  const rawType = m.type || m.mediaType || "";
  return {
    attachmentId: m.attachmentId,
    mediaHashKey: m.mediaHashKey,
    rawType,                                   // 原始 image/gif/video/file
    kind: classify(rawType, ext),              // image|gif|video|text|pdf|file
    filename, ext,
    mime: MIME_BY_EXT[ext] || "application/octet-stream",
    filesizeBytes: m.filesizeBytes || 0,
    dimensions: m.dimensions || null,
    durationMillis: m.durationMillis ?? null,
  };
}
```

### 4.2 类型判定三层兜底

| 优先级 | 来源                                          | 说明                                     |
| ------ | --------------------------------------------- | ---------------------------------------- |
| 1      | `rawType`（`media.type` / `mediaType`） | 区分 image / gif / video / file          |
| 2      | `filename` 扩展名                           | `file` 类二次细分：md/pdf/zip/docx/... |
| 3      | 解密后字节魔数                                | 无扩展名或扩展名不可信时兜底             |

魔数嗅探函数（解密后对明文字节做）：

```js
function sniffMime(bytes) {
  const b = bytes;
  if (b[0]===0x50 && b[1]===0x4b && b[2]===0x03 && b[3]===0x04) {
    // ZIP 与 OOXML(docx/xlsx/pptx) 同为 PK\x03\x04，需靠扩展名区分
    return "application/zip";
  }
  if (b[0]===0x25 && b[1]===0x50 && b[2]===0x44 && b[3]===0x46) return "application/pdf"; // %PDF
  if (b[0]===0x89 && b[1]===0x50 && b[2]===0x4e && b[3]===0x47) return "image/png";      // PNG
  if (b[0]===0xff && b[1]===0xd8 && b[2]===0xff) return "image/jpeg";                    // JPEG
  if (b[0]===0x47 && b[1]===0x49 && b[2]===0x46) return "image/gif";                     // GIF
  if (b[4]===0x66 && b[5]===0x74 && b[6]===0x79 && b[7]===0x70) return "video/mp4";      // ....ftyp
  return "application/octet-stream";
}
```

### 4.3 媒体代理端点增强

对 `server.js` 的 `/api/x/chat/media` 做三点增强：

```js
// 1) 用归一化模型替代手写 if/else
const norm = normalizeAttachment(att);
const contentType = norm.mime !== "application/octet-stream"
  ? norm.mime
  : sniffMime(bytes);

// 2) 带文件名响应头（inline 预览；download=1 强制下载）
res.setHeader("Content-Type", contentType);
const fn = encodeURIComponent(norm.filename || "attachment");
res.setHeader("Content-Disposition",
  `inline; filename*=UTF-8''${fn}`);
if (req.query.download === "1") {
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${fn}`);
}

// 3) 可选：支持 Range（视频 seek / 断点续传，大文件建议）
// 用 res.sendFile + Accept-Ranges，或手写 206 分段响应；生产可改存对象存储走 CDN。
```

### 4.4 前端分类渲染

`public/app.js` 两处渲染统一改为按 `kind` 分流：

```js
function renderAttachment(att, url) {
  switch (att.kind) {
    case "image":
    case "gif":
      return `<img loading="lazy" src="${url}" ... />`;
    case "video":
      return `<video controls preload="metadata" src="${url}" ...></video>`;
    case "text":      // md / txt：可选直接内嵌预览
      return `<a href="${url}" download="${escapeAttr(att.filename)}">📄 ${escapeHtml(att.filename)}</a>`;
    case "pdf":       // 浏览器原生内嵌或 pdf.js
      return `<a href="${url}" target="_blank">📕 ${escapeHtml(att.filename)}</a>
              <iframe src="${url}" style="width:100%;height:360px"></iframe>`;
    default:          // file：zip / docx / 其他 → 下载卡片
      return `<div class="file-card">
                <span>📦 ${escapeHtml(att.filename)}</span>
                <span>${formatSize(att.filesizeBytes)}</span>
                <a href="${url}&download=1">下载</a>
              </div>`;
  }
}
```

> 说明：`md` 若要「渲染」成富文本，前端用 `marked` 之类把 fetch 到的文本转 HTML 即可（注意 XSS 转义）；`pdf` 用浏览器原生 iframe 或 `pdf.js`；`docx/zip` 默认提供下载，若需「预览内容」需服务端解析（见 §5）。

---

## 五、各格式「解析」方法

> 「解析」分两档：**A 档（够用）** = 正确判定类型 + 正确 Content-Type/文件名 + 前端正确渲染/下载；**B 档（深度）** = 提取正文/预览内容。以下给出各格式的 A/B 做法。

### 5.1 md（Markdown）

- **判定**：`mediaType=file` + 扩展名 `md`；字节为 UTF-8 纯文本。
- **A 档**：Content-Type `text/markdown; charset=utf-8`，前端 fetch 文本后用 `marked`/`markdown-it` 渲染，或直接 `<pre>` 显示原文。
- **B 档**：无额外解析，本质就是文本；注意处理非 UTF-8 编码（按 BOM/魔数识别，兜底 UTF-8）。

### 5.2 mp4（视频）

- **判定**：`mediaType=video` + 扩展名 `mp4`；字节 `....ftyp`（ISO Base Media File Format）。
- **A 档**：Content-Type `video/mp4`，前端 `<video controls preload="metadata">`；服务端补 **Range** 支持（`Accept-Ranges: bytes`）以支持拖动。
- **B 档**：可选生成缩略图/首帧（服务端 `ffmpeg` 抽帧，或前端 `<video>` 截帧 canvas），转码由客户端能力兜底（H.264/AAC 兼容性最好）。

### 5.3 pdf

- **判定**：`mediaType=file` + 扩展名 `pdf`；字节 `%PDF-`。
- **A 档**：Content-Type `application/pdf`，浏览器原生 `<iframe src>` 内嵌预览或 `pdf.js` 渲染（纯前端，无需服务端解析）。
- **B 档**：服务端用 `pdf-parse` / `pdfjs-dist` 提取文本（供客服检索/摘要），或抽首页缩略图。

### 5.4 zip

- **判定**：`mediaType=file` + 扩展名 `zip`；字节 `PK\x03\x04`。
- **A 档**：Content-Type `application/zip` + `Content-Disposition: attachment`，前端下载卡片。
- **B 档**：服务端用 `adm-zip` / `yauzl` 列出条目或提取文本；⚠️ **必须做 Zip-Slip 防护**（校验 `../`、绝对路径、符号链接），否则解压可能覆盖服务器文件。大 zip 不建议服务端整体解压。

### 5.5 docx（Word / OOXML）

- **判定**：`mediaType=file` + 扩展名 `docx`；字节 `PK\x03\x04`（本质是 ZIP 容器）。
- **A 档**：Content-Type `application/vnd.openxmlformats-officedocument.wordprocessingml.document`，前端下载卡片。
- **B 档**：服务端把 docx 当 zip 打开，读取 `word/document.xml`，用 `mammoth`（保留格式转 HTML）或正则剥 `<w:t>` 提取纯文本；同样注意解压路径安全。也可纯前端用 `jszip` + `mammoth` 在浏览器内解析。

---

## 六、实测数据附录

### 6.1 加密大小 vs 解密大小（`filesizeBytes` 是加密后大小）

| 文件      | filesizeBytes（元数据） | 解密后字节 | 差值（加密开销） |
| --------- | ----------------------- | ---------- | ---------------- |
| prompt.md | 2,777                   | 2,702      | -75              |
| 视频.mp4  | 3,305,898               | 3,251,882  | -54,016          |
| ….pdf    | 337,735                 | 332,186    | -5,549           |
| ….zip    | 21,035,903              | 20,692,343 | -343,560         |
| ….docx   | 6,300,538               | 6,197,613  | -102,925         |

> UI 展示文件大小时建议用**解密后字节数**（下载后为准），或直接标注元数据大小为「约」值。

### 6.2 关键 API 速查

| 能力             | 方法                                                            | 位置                        |
| ---------------- | --------------------------------------------------------------- | --------------------------- |
| 批量解密消息     | `chat.decryptEvents(eventsB64)` / `ChatCrypto.decryptBatch` | `lib/chat-crypto.js#L209` |
| 单条解密         | `chat.decryptEvent(b64)` / `ChatCrypto.decryptOne`          | `lib/chat-crypto.js#L218` |
| 提取会话密钥表   | `chat.extractConversationKeys(eventsB64)`                     | `lib/chat-crypto.js#L229` |
| 解密媒体字节     | `chat.decryptStream(encrypted, conversationKey)`              | `lib/chat-crypto.js#L238` |
| 下载加密媒体     | `client.chat.mediaDownload(convIdPath, mediaHashKey)`         | `server.js#L1520`         |
| 会话 ID 路径转换 | `pathConversationId()`（`:` → `-`）                      | `lib/x-chat-api.js#L15`   |

### 6.3 chat-xdk 类型定义要点（`@xdevplatform/chat-xdk/index.d.ts`）

- `Event.keyVersion`：消息及媒体加密所用的会话密钥版本，解密媒体时用它在 `extractConversationKeys` 的结果里取键。
- `AttachmentInfo`：`attachmentType / mediaHashKey / mediaType / filename / filesizeBytes / attachmentId / dimensions / durationMillis`。
- `MediaHashReference`：`{ source, mediaHashKey }`。
- `decryptStream(encrypted: Uint8Array, conversationKey: Uint8Array): Uint8Array`。

---

## 七、落地改造清单

| # | 文件                               | 改动                                                                                     | 工作量 |
| - | ---------------------------------- | ---------------------------------------------------------------------------------------- | ------ |
| 1 | `server.js`                      | `extractChatAttachments` 改用归一化模型，补 `kind/ext/mime`                          | 小     |
| 2 | `server.js`                      | `/api/x/chat/media` 补 Content-Type 映射 + `Content-Disposition` + `download` 参数 | 小     |
| 3 | `server.js`                      | （可选）媒体端点补 Range /`Accept-Ranges`（视频 seek）                                 | 中     |
| 4 | `public/app.js`                  | 两处渲染改按`kind` 分支（img / video / 文本 / pdf / 下载卡片）                         | 小     |
| 5 | （可选）`lib/chat-attachment.js` | 抽出归一化 + MIME + 魔数工具，供服务端/前端共用                                          | 小     |
| 6 | （可选）新增预览端点               | `md` 直出、`docx` 提取文本、`zip` 列目录                                           | 中     |
| 7 | `server.js`（旧 DM）             | 解析 `entities.urls` 提取媒体信号，新增 `resolveDmMedia` 调 `dm_events` 反查媒体元数据 | 小     |
| 8 | `server.js`（旧 DM）             | 新增 `/api/x/dm/media` 代理端点（视频公开 CDN 转发 + Range；照片 OAuth1 受限兜底）      | 中     |
| 9 | `public/app.js`（旧 DM）         | 工作台 DM 附件改走 `/api/x/dm/media`；照片渲染「在 X 中查看」卡片、视频内联            | 小     |

---

## 八、旧版 DM 明文私信（文本/表情/图片/视频）

### 8.1 结论：无文件附件，仅文本/表情/图片/视频

经官方客户端实测：旧版 DM（`dm.received` / `dm.sent`）的 `message_data` 只包含：

- `text`：明文文本，表情以 Unicode 字符直接内嵌在 `text` 里；
- `entities`：`hashtags` / `symbols` / `user_mentions` / `urls`。

**官方客户端发送旧版 DM 不支持附件文件**（md / pdf / zip / docx 等无法通过 DM 发送）。图片、视频不是以 `attachment` 字段出现在 webhook，而是以 `entities.urls` 里的 `t.co` 短链标识，需二次反查。

### 8.2 Webhook 载荷结构（实测）

```json
{
  "data": {
    "event_type": "dm.received",
    "filter": { "user_id": "1020239807476248577" },
    "payload": {
      "direct_message_events": [{
        "type": "message_create",
        "id": "2091798918002581875",
        "message_create": {
          "target": { "recipient_id": "1020239807476248577" },
          "sender_id": "2079439120540274688",
          "message_data": {
            "text": "这是文本+图片混合消息 https://t.co/QG1kkjvdKJ",
            "entities": {
              "hashtags": [], "symbols": [], "user_mentions": [],
              "urls": [{
                "url": "https://t.co/QG1kkjvdKJ",
                "expanded_url": "https://twitter.com/messages/media/2091798918002581875",
                "display_url": "pic.twitter.com/QG1kkjvdKJ",
                "indices": [12, 35]
              }]
            }
          }
        }
      }]
    }
  }
}
```

关键点：webhook **不携带 `attachment.media`**，媒体信号只在 `entities.urls`：`expanded_url`（`twitter.com/messages/media/<消息id>`）与 `display_url`（`pic.twitter.com/<code>`）。

### 8.3 媒体反查：`dm_events`（media 扩展）

用绑定账号 token 调 X API v2，按消息 id 反查直接媒体地址：

```
GET /2/dm_conversations/with/{peer_id}/dm_events
    ?dm_event.fields=attachments
    &media.fields=type,url,preview_image_url,duration_ms,width,height,alt_text,variants
    &expansions=attachments.media_keys
    &max_results=50
```

`data[].attachments.media_keys[]` → `includes.media[]`。实测照片 / 视频各一：

```json
"includes": {
  "media": [
    {
      "media_key": "18_2091799262539468800",
      "type": "video",
      "duration_ms": 15200, "width": 2560, "height": 1440,
      "preview_image_url": "https://pbs.twimg.com/dm_video_preview/.../img/....jpg",
      "variants": [
        { "bit_rate": 256000,  "content_type": "video/mp4", "url": "https://video.twimg.com/dm_video/.../320x180/....mp4?tag=1" },
        { "bit_rate": 2176000, "content_type": "video/mp4", "url": "https://video.twimg.com/dm_video/.../1280x720/....mp4?tag=1" },
        { "content_type": "application/x-mpegURL", "url": "https://video.twimg.com/dm_video/.../pl/....m3u8?tag=1" }
      ]
    },
    {
      "media_key": "5_2091798906669580289",
      "type": "photo",
      "url": "https://ton.twitter.com/1.1/ton/data/dm/2091798918002581875/2091798906669580289/g7ekozfB.jpg",
      "width": 1000, "height": 563
    }
  ]
}
```

### 8.4 媒体类型与下载鉴权（实测结论）

| media type | media_key 前缀 | 直接地址 | 下载鉴权（实测） |
|-----------|--------------|---------|----------------|
| photo（图片） | `5_` | `ton.twitter.com/1.1/ton/data/dm/...jpg` | **需 OAuth 1.0a**（OAuth2 被拒；无鉴权 302→401） |
| video（视频） | `18_` | `video.twimg.com/dm_video/.../avc1/....mp4?tag=1`（`variants` 取 `video/mp4` 码率最高者） | **公开 CDN，免鉴权**（实测 200） |
| video 缩略图 | — | `pbs.twimg.com/dm_video_preview/.../img/....jpg` | 公开，免鉴权 |
| animated_gif（动图） | `3_` | `variants` 中 `video/mp4` | 公开 CDN（与视频一致） |

处理策略：

1. **视频/动图**：选 `variants` 中 `content_type == "video/mp4"` 且 `bit_rate` 最高的地址，服务端代理转发（支持 HTTP Range，可拖动）。
2. **照片**：`ton.twitter.com` 仅接受 OAuth 1.0a，OAuth2 环境无法内联；兜底用 `expanded_url` 跳转到 X 查看。

> ⚠️ 照片内联需服务端补 OAuth 1.0a 用户上下文签名（App consumer key/secret + 用户 OAuth1 token/secret）。OAuth2 PKCE 拿不到 OAuth1 用户凭证，是 X API 的硬性边界。

> 💡 Java 移植：旧版 DM 媒体反查/下载纯 REST、**不依赖 WASM**，可直接用 Java 实现；仅照片内联需 OAuth 1.0a 签名。

### 8.5 前端展示口径（两视图分离）

| 通道 | 面板 | 展示 |
|------|------|------|
| 旧版 DM 明文 | 私信工作台 `/api/x/dm/local-events` | 文本/表情直接显示；图片→「在 X 中查看」卡片；视频→`<video>` 内联（含缩略图 poster） |
| 新版 Chat 加密 | 解密面板 `/api/x/chat/local-events` | 解密后明文 + 解密附件 |

私信工作台对加密 Chat 消息**只显示密文占位（🔒）**，解密明文仅在解密面板展示，两视图严格分离。

---

## 九、安全与合规注意

1. **Zip-Slip**：服务端解压 zip/docx 时必须校验条目路径（拒绝 `../`、绝对路径、软链），否则任意文件写入。
2. **文件名注入**：`Content-Disposition` 的 `filename` 必须用 `encodeURIComponent`（`filename*=UTF-8''...`），防止 CRLF/引号注入。
3. **大小限制**：媒体按需下载并缓存在内存（当前 `mediaCache` 上限 30 个），大文件建议转存对象存储/CDN，避免 OOM。
4. **内容安全**：md 渲染成 HTML 前必须做 XSS 转义（`marked` 默认允许部分 HTML，需配 `sanitize` 或白名单）。
5. **解密即削弱 E2EE**：服务端持有 PIN 与明文，属既有架构权衡（README 已声明），附件解析同理，生产需评估合规。
6. **验签**：当前 `setRejectUnverified(false)`，附件明文应视为「可能未验证」，生产建议严格验签后再提供下载。

---

## 十、总结

两条私信通道形态不同、处理链路也不同，应分开处理：

**新版 Chat 加密私信（E2EE）**：五种常见附件**本质同源**（都是加密 media 附件），解密链路已具备，问题集中在「类型判定 + 响应头 + 前端渲染」：

- 用 `mediaType/type`（image/gif/video/file）+ `filename` 扩展名 + 解密后魔数做**三层判定**；
- 服务端统一归一化元数据、按扩展名给 MIME、带 `Content-Disposition` 文件名；
- 前端按 `kind` 分类：图片/gif 内嵌、视频 `<video>`、md/文本 内嵌预览、pdf 原生 iframe/pdf.js、zip/docx 下载卡片（可选深度解析）。

按此统一方案改造，即可用一套管线稳定覆盖 md / mp4 / pdf / zip / docx 及未来任意文件格式的接收、解密与展示。

**旧版 DM 明文私信**：无文件附件，仅文本/表情/图片/视频：

- 文本/表情直接展示（无需解密）；
- 图片/视频经 `dm_events`（media 扩展）反查直接地址：视频/动图走公开 CDN 内联播放，照片因 `ton.twitter.com` 仅支持 OAuth 1.0a（OAuth2 被拒）需跳转 X 查看（或补 OAuth 1.0a 后内联）。
