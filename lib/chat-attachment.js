/**
 * X Chat 附件归一化与类型判定工具（CommonJS）
 *
 * 背景：chat-xdk 解密后的附件在两种结构里字段命名不一致——
 *   - event.content.attachments[i].media  —— 嵌套版，判别键是 media.type
 *   - event.attachments[i]                —— 扁平版，判别键是 mediaType
 * 本模块把两种结构归一化成一个中间模型，并据此做「mediaType + 扩展名 + 魔数」
 * 三层类型判定，供服务端（媒体代理）与前端（渲染）共用。
 */
"use strict";

/** 扩展名 → MIME 映射（file 类附件按 filename 扩展名判定具体格式）。 */
const MIME_BY_EXT = {
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  json: "application/json",
  csv: "text/csv",
  log: "text/plain",
  pdf: "application/pdf",
  zip: "application/zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ppt: "application/vnd.ms-powerpoint",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  mp4: "video/mp4",
  m4v: "video/x-m4v",
  mov: "video/quicktime",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  svg: "image/svg+xml",
};

/** 取文件名扩展名（小写，无点）。 */
function extOf(filename) {
  const m = /\.([A-Za-z0-9]+)$/.exec(filename || "");
  return m ? m[1].toLowerCase() : "";
}

/**
 * 三级判定的前两级（mediaType + 扩展名），产出「渲染类别」：
 *   image | gif | video | text | pdf | file
 * 魔数兜底（第三级）在解密拿到字节后由 sniffMime 完成。
 */
function classify(rawType, ext) {
  const t = String(rawType || "").toLowerCase();
  if (t === "image") return "image";
  if (t === "gif") return "gif";
  if (t === "video") return "video";
  if (ext === "md" || ext === "markdown" || ext === "txt") return "text";
  if (ext === "pdf") return "pdf";
  return "file";
}

/**
 * 把一条附件（嵌套或扁平结构）归一化成统一中间模型。
 * @param {object} a event.content.attachments[i] 或 event.attachments[i]
 * @returns {object|null}
 */
function normalizeAttachment(a) {
  if (!a) return null;
  const m = a.media ? a.media : a; // 嵌套版取 .media，扁平版直接用自身
  const filename = m.filename || "";
  const ext = extOf(filename);
  const rawType = m.type || m.mediaType || "";
  return {
    attachmentId: m.attachmentId || null,
    mediaHashKey: m.mediaHashKey || null,
    type: rawType, // 原始 mediaType/type（image/gif/video/file），保留兼容
    kind: classify(rawType, ext), // 渲染类别：image/gif/video/text/pdf/file
    filename,
    ext,
    mime: MIME_BY_EXT[ext] || "application/octet-stream",
    filesizeBytes: m.filesizeBytes || 0,
    width: m.dimensions?.width ?? null,
    height: m.dimensions?.height ?? null,
    durationMillis: m.durationMillis ?? null,
  };
}

/**
 * 魔数嗅探（解密后对明文字节做兜底判定）。
 * @param {Buffer|Uint8Array} bytes
 * @returns {string} MIME
 */
function sniffMime(bytes) {
  if (!bytes || bytes.length < 8) return "application/octet-stream";
  const b = bytes;
  // ZIP 与 OOXML(docx/xlsx/pptx) 同为 PK\x03\x04，需靠扩展名二次区分
  if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return "application/zip";
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return "application/pdf"; // %PDF
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";      // PNG
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";                     // JPEG
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";     // GIF8
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return "video/mp4";     // ....ftyp
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "video/webm";    // EBML
  return "application/octet-stream";
}

module.exports = { MIME_BY_EXT, extOf, classify, normalizeAttachment, sniffMime };
