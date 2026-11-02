// X 智能客服集成 Demo - 前端逻辑

(function () {
  "use strict";

  const navBtns = document.querySelectorAll(".nav-btn");
  const pages = document.querySelectorAll(".page");

  // 页面 1: 账号绑定
  const btnBind = document.getElementById("btn-bind");
  const btnRefresh = document.getElementById("btn-refresh");
  const btnUnbind = document.getElementById("btn-unbind");
  const btnUnbindAll = document.getElementById("btn-unbind-all");
  const btnBindAnother = document.getElementById("btn-bind-another");
  const btnBackToList = document.getElementById("btn-back-to-list");
  const checkboxes = [
    document.getElementById("prereq-1"),
    document.getElementById("prereq-2"),
    document.getElementById("prereq-3"),
  ];
  const bindingCard = document.getElementById("binding-card");
  const bindingStatus = document.getElementById("binding-status");
  const statusContent = document.getElementById("status-content");
  const bindingsListCard = document.getElementById("bindings-list-card");
  const bindingsList = document.getElementById("bindings-list");

  // 页面 2: 私信
  const btnWebhookRegister = document.getElementById("btn-webhook-register");
  const btnDmSubscribe = document.getElementById("btn-dm-subscribe");
  const btnChatSubscribe = document.getElementById("btn-chat-subscribe");
  const btnDmFetch = document.getElementById("btn-dm-fetch");
  const messagesStatus = document.getElementById("messages-status");

  // XChat 加密私信解密面板（全自动：无手动按钮）
  const chatIdentityStatus = document.getElementById("chat-identity-status");
  const chatDecryptStatus = document.getElementById("chat-decrypt-status");
  const chatDecryptList = document.getElementById("chat-decrypt-list");

  // 页面 3: 评论回复
  const btnMentionSubscribe = document.getElementById("btn-mention-subscribe");
  const btnFetchMentions = document.getElementById("btn-fetch-mentions");
  const mentionsList = document.getElementById("mentions-list");
  const mentionsStatus = document.getElementById("mentions-status");
  const replyForm = document.getElementById("reply-form");
  const selectedMention = document.getElementById("selected-mention");
  const replyText = document.getElementById("reply-text");
  const btnSendReply = document.getElementById("btn-send-reply");
  const btnCancelReply = document.getElementById("btn-cancel-reply");

  const toast = document.getElementById("toast");

  let currentUserId = null;
  let replyTargetId = null;
  let currentPeerId = null; // 当前会话对方 userId（收到私信时自动记录，用于直接回复）
  const peerNameCache = new Map(); // userId -> username（回填用户名，避免重复查询）

  // DM 多账号独立聊天
  let activeDmUserId = null; // 当前 DM Tab 选中的账号
  const dmPeerMap = new Map(); // ownerUserId -> { peerId, peerName, peerAvatar }
  const dmEventCache = new Map(); // ownerUserId -> events[]
  const boundUserIds = new Set(); // 所有已绑定账号 ID（用于消息分发）

  function init() {
    const params = new URLSearchParams(window.location.search);
    if (params.get("bound") === "true") {
      currentUserId = params.get("user_id");
      if (currentUserId) {
        localStorage.setItem("x_bound_user_id", currentUserId);
        showToast("绑定成功！", "success");
      }
      window.history.replaceState({}, document.title, window.location.pathname);
    }
    if (params.get("error")) {
      showToast(`授权失败: ${params.get("error")}`, "error");
      window.history.replaceState({}, document.title, window.location.pathname);
    }
    const savedUserId = localStorage.getItem("x_bound_user_id");
    if (savedUserId) currentUserId = savedUserId;

    // 加载所有已绑定账号列表
    loadAllBindings();

    navBtns.forEach((btn) => {
      btn.addEventListener("click", (e) =>
        switchPage(e.target.getAttribute("data-page"))
      );
    });

    checkboxes.forEach((cb) => cb.addEventListener("change", updateBindButton));
    updateBindButton();
    btnBind?.addEventListener("click", startBinding);
    btnRefresh?.addEventListener("click", refreshToken);
    btnUnbind?.addEventListener("click", unbindAccount);
    btnUnbindAll?.addEventListener("click", unbindAllAccounts);
    btnBindAnother?.addEventListener("click", showBindingCard);
    btnBackToList?.addEventListener("click", showBindingsList);

    btnWebhookRegister?.addEventListener("click", registerWebhook);
    btnDmSubscribe?.addEventListener("click", subscribeDmEvents);
    btnChatSubscribe?.addEventListener("click", subscribeChatEvents);
    btnDmFetch?.addEventListener("click", fetchDmEvents);
    setInterval(pollLocalEvents, 4000); // 定时拉取 Webhook 推送的私信事件
    setInterval(pollLocalMentions, 4000); // 定时拉取 Webhook 推送的提及事件
    setInterval(refreshChatEvents, 4000); // 定时自动展示已解密的 Chat 事件

    // PIN 热更新
    const pinBtn = document.getElementById("chat-pin-btn");
    const pinInput = document.getElementById("chat-pin-input");
    const pinMsg = document.getElementById("chat-pin-msg");
    pinBtn?.addEventListener("click", async () => {
      const pin = pinInput.value.trim();
      if (!pin || pin.length < 4) {
        pinMsg.textContent = "PIN 至少 4 位";
        pinMsg.style.color = "#ef4444";
        return;
      }
      pinBtn.disabled = true;
      pinMsg.textContent = "更新中...";
      pinMsg.style.color = "#888";
      try {
        const res = await fetch("/api/x/chat/update-pin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pin }),
        });
        const data = await res.json();
        if (data.success) {
          pinMsg.textContent = "✓ 已更新，将自动重新解锁";
          pinMsg.style.color = "#10b981";
          pinInput.value = "";
        } else {
          pinMsg.textContent = data.hint || data.error || "更新失败";
          pinMsg.style.color = "#ef4444";
        }
      } catch {
        pinMsg.textContent = "网络错误";
        pinMsg.style.color = "#ef4444";
      }
      pinBtn.disabled = false;
    });

    btnMentionSubscribe?.addEventListener("click", subscribeMentions);
    btnFetchMentions?.addEventListener("click", fetchMentions);
    btnSendReply?.addEventListener("click", sendReply);
    btnCancelReply?.addEventListener("click", () => {
      replyForm.style.display = "none";
      replyTargetId = null;
    });
  }

  function switchPage(pageName) {
    pages.forEach((p) => p.classList.remove("active"));
    document.getElementById(`page-${pageName}`)?.classList.add("active");
    navBtns.forEach((btn) => btn.classList.remove("active"));
    document.querySelector(`[data-page="${pageName}"]`)?.classList.add("active");
    // 切换到私信页面时加载账号 Tab
    if (pageName === "messages") {
      renderDmAccountTabs();
    }
  }

  // ========== 页面 1: 账号绑定（多账号管理）==========

  // 视图切换：显示绑定列表
  function showBindingsList() {
    bindingCard.style.display = "none";
    bindingStatus.style.display = "none";
    loadAllBindings();
  }

  // 视图切换：显示绑定新账号卡片
  function showBindingCard() {
    bindingsListCard.style.display = "none";
    bindingStatus.style.display = "none";
    bindingCard.style.display = "block";
    // 重置 checkbox 状态
    checkboxes.forEach((cb) => (cb.checked = false));
    updateBindButton();
  }

  // 视图切换：显示账号详情
  function showBindingDetail(userId) {
    bindingsListCard.style.display = "none";
    bindingCard.style.display = "none";
    bindingStatus.style.display = "block";
    btnBackToList.style.display = "inline-block";
    loadStatus(userId);
  }

  function updateBindButton() {
    btnBind.disabled = !checkboxes.every((cb) => cb.checked);
  }

  async function startBinding() {
    try {
      const res = await fetch("/api/x/auth");
      const { authUrl } = await res.json();
      window.location.href = authUrl;
    } catch (err) {
      showToast(`授权失败: ${err.message}`, "error");
    }
  }

  // 加载所有已绑定账号并渲染列表
  async function loadAllBindings() {
    try {
      const res = await fetch("/api/x/bindings");
      const data = await res.json();
      if (data.bindings && data.bindings.length > 0) {
        bindingsListCard.style.display = "block";
        bindingCard.style.display = "none";
        bindingStatus.style.display = "none";
        renderBindingsList(data.bindings);
        // 如果 currentUserId 不在列表中，选中第一个
        const ids = data.bindings.map((b) => b.userId);
        if (!ids.includes(currentUserId)) {
          currentUserId = data.bindings[0].userId;
          localStorage.setItem("x_bound_user_id", currentUserId);
        }
        autoUnlockAndDecrypt();
      } else {
        // 无绑定，显示绑定卡片
        bindingsListCard.style.display = "none";
        bindingCard.style.display = "block";
        bindingStatus.style.display = "none";
        localStorage.removeItem("x_bound_user_id");
        currentUserId = null;
      }
    } catch (err) {
      showToast(`加载绑定列表失败: ${err.message}`, "error");
    }
  }

  // 渲染多账号绑定列表
  function renderBindingsList(bindings) {
    if (!bindingsList) return;
    if (!bindings.length) {
      bindingsList.innerHTML = '<div class="binding-empty">暂无已绑定账号</div>';
      return;
    }
    bindingsList.innerHTML = bindings
      .map((b) => {
        const user = b.user || {};
        const avatar = user.avatar || user.profile_image_url || "";
        const name = user.name || user.username || "未知";
        const username = user.username ? `@${user.username}` : b.userId;
        const statusClass = b.tokenStatus === "active" ? "active" : "expired";
        const statusText = b.tokenStatus === "active" ? "有效" : "已过期";
        const boundAt = b.boundAt
          ? new Date(b.boundAt).toLocaleString("zh-CN")
          : "";
        return `<div class="binding-item" data-user-id="${b.userId}">
          <img class="binding-avatar" src="${escapeAttr(avatar)}" alt=""
            onerror="this.style.visibility='hidden'">
          <div class="binding-info">
            <div class="binding-name">${escapeHtml(name)}</div>
            <div class="binding-username">${escapeHtml(username)} · 绑定于 ${boundAt}</div>
          </div>
          <div class="binding-meta">
            <span class="binding-badge ${statusClass}">${statusText}</span>
            <button class="btn-unbind-one" data-user-id="${b.userId}" onclick="event.stopPropagation()">解绑</button>
          </div>
        </div>`;
      })
      .join("");

    // 绑定点击事件：查看详情
    bindingsList.querySelectorAll(".binding-item").forEach((el) => {
      el.addEventListener("click", () => {
        const userId = el.dataset.userId;
        currentUserId = userId;
        localStorage.setItem("x_bound_user_id", userId);
        showBindingDetail(userId);
      });
    });

    // 绑定解绑按钮事件
    bindingsList.querySelectorAll(".btn-unbind-one").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        unbindSingleAccount(btn.dataset.userId);
      });
    });
  }

  // 加载单个账号状态详情
  async function loadStatus(userId) {
    try {
      const res = await fetch(`/api/x/status?user_id=${userId}`);
      const data = await res.json();
      if (data.bound) {
        renderStatus(data);
        autoUnlockAndDecrypt();
      } else {
        showToast("该账号未绑定", "error");
        showBindingsList();
      }
    } catch (err) {
      showToast(`加载状态失败: ${err.message}`, "error");
    }
  }

  function renderStatus(data) {
    const { user, tokenStatus, expiresAt, scope } = data;
    const rows = [
      ["用户名", "@" + user.username],
      ["昵称", user.name],
      ["粉丝", user.followers ?? "-"],
      ["Token 状态", tokenStatus],
      ["过期时间", new Date(expiresAt).toLocaleString("zh-CN")],
      ["授权范围", scope],
    ];
    statusContent.innerHTML =
      '<table style="width:100%;border-collapse:collapse">' +
      rows
        .map(
          ([k, v]) =>
            `<tr><td style="padding:8px 0;border-bottom:1px solid #333;color:#888;width:120px">${k}</td><td style="padding:8px 0;border-bottom:1px solid #333">${escapeHtml(
              String(v)
            )}</td></tr>`
        )
        .join("") +
      "</table>";
  }

  async function refreshToken() {
    try {
      const res = await fetch("/api/x/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: currentUserId }),
      });
      const data = await res.json();
      showToast(data.success ? "Token 已刷新" : "刷新失败", data.success ? "success" : "error");
      if (data.success) loadStatus(currentUserId);
    } catch (err) {
      showToast(`刷新失败: ${err.message}`, "error");
    }
  }

  // 解绑单个账号（从列表中的解绑按钮触发）
  async function unbindSingleAccount(userId) {
    const binding = await getBindingInfo(userId);
    const name = binding?.user?.username ? `@${binding.user.username}` : userId;
    if (!confirm(`确定要解绑 ${name} 吗？`)) return;
    try {
      const res = await fetch("/api/x/unbind", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId }),
      });
      const data = await res.json();
      if (data.success) {
        if (currentUserId === userId) {
          localStorage.removeItem("x_bound_user_id");
          currentUserId = null;
        }
        showToast(`已解绑 ${name}`, "success");
        loadAllBindings();
      } else {
        showToast("解绑失败", "error");
      }
    } catch (err) {
      showToast(`解绑失败: ${err.message}`, "error");
    }
  }

  // 获取单个绑定信息（轻量查询）
  async function getBindingInfo(userId) {
    try {
      const res = await fetch(`/api/x/status?user_id=${userId}`);
      return await res.json();
    } catch {
      return null;
    }
  }

  // 解绑当前查看详情的账号（从详情面板触发）
  async function unbindAccount() {
    if (!currentUserId) return;
    await unbindSingleAccount(currentUserId);
  }

  // 一键解绑所有账号
  async function unbindAllAccounts() {
    if (!confirm("确定要一键解绑所有账号吗？\n\n此操作将清除所有已绑定的 X 账号，便于重新演示绑定流程。")) return;
    try {
      const res = await fetch("/api/x/unbind-all", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json();
      if (data.success) {
        localStorage.removeItem("x_bound_user_id");
        currentUserId = null;
        showToast(`已解绑 ${data.unboundCount} 个账号`, "success");
        loadAllBindings();
      } else {
        showToast("解绑失败", "error");
      }
    } catch (err) {
      showToast(`解绑失败: ${err.message}`, "error");
    }
  }

  // ========== 页面 2: 私信收发（多账号独立聊天窗口）==========
  function requireBinding() {
    if (!currentUserId) {
      showToast("请先在「账号绑定」页面完成绑定", "error");
      return false;
    }
    return true;
  }

  // 渲染账号切换 Tab
  async function renderDmAccountTabs() {
    const tabsContainer = document.getElementById("dm-account-tabs");
    const panelsContainer = document.getElementById("dm-panels");
    if (!tabsContainer || !panelsContainer) return;

    try {
      const res = await fetch("/api/x/bindings");
      const data = await res.json();
      const bindings = data.bindings || [];

      // 记录所有绑定账号 ID，供消息分发使用
      boundUserIds.clear();
      for (const b of bindings) boundUserIds.add(b.userId);

      if (bindings.length === 0) {
        tabsContainer.style.display = "none";
        panelsContainer.innerHTML = '<div class="binding-empty">请先在「账号绑定」页面绑定 X 账号</div>';
        return;
      }

      // 默认选中第一个
      if (!activeDmUserId || !bindings.find((b) => b.userId === activeDmUserId)) {
        activeDmUserId = bindings[0].userId;
      }

      // 渲染 Tab 栏
      tabsContainer.style.display = "block";
      tabsContainer.innerHTML = `<div class="dm-tabs">${bindings
        .map((b) => {
          const user = b.user || {};
          const avatar = user.avatar || "";
          const name = user.username ? `@${user.username}` : b.userId.slice(0, 8);
          const active = b.userId === activeDmUserId ? " active" : "";
          return `<button class="dm-tab${active}" data-user-id="${b.userId}">
            <img class="dm-tab-avatar" src="${escapeAttr(avatar)}" alt="" onerror="this.style.visibility='hidden'">
            <span>${escapeHtml(name)}</span>
          </button>`;
        })
        .join("")}</div>`;

      // Tab 点击事件
      tabsContainer.querySelectorAll(".dm-tab").forEach((tab) => {
        tab.addEventListener("click", () => {
          activeDmUserId = tab.dataset.userId;
          // 更新 Tab 样式
          tabsContainer.querySelectorAll(".dm-tab").forEach((t) => t.classList.remove("active"));
          tab.classList.add("active");
          // 切换面板
          switchDmPanel(activeDmUserId);
        });
      });

      // 为每个账号创建独立面板
      for (const b of bindings) {
        ensureDmPanel(b.userId, b.user);
      }

      // 显示当前选中账号的面板
      switchDmPanel(activeDmUserId);
    } catch (err) {
      setStatus(messagesStatus, `❌ 加载账号列表失败: ${err.message}`, "error");
    }
  }

  // 确保某个账号的聊天面板 DOM 存在
  function ensureDmPanel(userId, user) {
    const panelsContainer = document.getElementById("dm-panels");
    if (!panelsContainer) return;
    const panelId = `dm-panel-${userId}`;
    if (document.getElementById(panelId)) return;

    const info = user || {};
    const displayName = info.username ? `@${info.username}` : userId;
    const peerInfo = dmPeerMap.get(userId);
    const peerBarHtml = peerInfo
      ? `<div class="dm-peer-bar" style="display:flex;align-items:center;gap:10px;padding:12px 15px;background:#141414;border-bottom:1px solid #2a2a2a">
          <img src="${escapeAttr(peerInfo.peerAvatar || "")}" alt="" style="width:36px;height:36px;border-radius:50%;background:#2a2a2a;object-fit:cover" onerror="this.style.visibility='hidden'">
          <div style="line-height:1.3">
            <div style="font-weight:600;color:#f0f0f0">${escapeHtml(peerInfo.peerName || "")}</div>
            <div style="font-size:12px;color:#888">${escapeHtml(peerInfo.peerId ? "对方 ID: " + peerInfo.peerId : "")}</div>
          </div></div>`
      : `<div class="dm-peer-bar" style="display:none;align-items:center;gap:10px;padding:12px 15px;background:#141414;border-bottom:1px solid #2a2a2a"></div>`;

    const panel = document.createElement("div");
    panel.id = panelId;
    panel.className = "dm-panel";
    panel.style.display = "none";
    panel.innerHTML = `
      <div style="padding:8px 12px;background:#1a1a1a;border-bottom:1px solid #2a2a2a;font-size:12px;color:#888">
        当前账号：${escapeHtml(displayName)}
      </div>
      ${peerBarHtml}
      <div class="dm-messages" style="flex:1;overflow-y:auto;padding:15px;background:#0f0f0f;min-height:300px;max-height:400px"></div>
      <div style="padding:15px;background:#141414;border-top:1px solid #2a2a2a;display:flex;gap:10px">
        <input type="text" class="dm-recipient-input" placeholder="对方用户名（自动填充或手动输入）" style="flex:1">
        <input type="text" class="dm-text-input" placeholder="消息内容" style="flex:2">
        <button class="btn btn-primary dm-send-btn">发送</button>
      </div>`;

    panelsContainer.appendChild(panel);

    // 绑定发送按钮
    panel.querySelector(".dm-send-btn").addEventListener("click", () => sendDmForUser(userId));
    panel.querySelector(".dm-text-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") sendDmForUser(userId);
    });
  }

  // 切换显示指定账号的聊天面板
  function switchDmPanel(userId) {
    const panelsContainer = document.getElementById("dm-panels");
    if (!panelsContainer) return;
    panelsContainer.querySelectorAll(".dm-panel").forEach((p) => (p.style.display = "none"));
    const panel = document.getElementById(`dm-panel-${userId}`);
    if (panel) panel.style.display = "flex";
    panel.style.flexDirection = "column";
    // 更新当前会话上下文
    currentUserId = userId;
    activeDmUserId = userId;
    const peer = dmPeerMap.get(userId);
    if (peer) currentPeerId = peer.peerId;
    // 滚动到底部
    const msgContainer = panel?.querySelector(".dm-messages");
    if (msgContainer) {
      requestAnimationFrame(() => (msgContainer.scrollTop = msgContainer.scrollHeight));
    }
  }

  // 渲染某个账号的消息列表
  function renderMessagesForUser(userId, events) {
    const panel = document.getElementById(`dm-panel-${userId}`);
    if (!panel) return;
    const msgContainer = panel.querySelector(".dm-messages");
    if (!msgContainer) return;

    msgContainer.innerHTML = events
      .slice()
      .reverse()
      .map((e) => {
        const senderId = e.sender_id || e.senderId;
        const ts = e.created_at || e.createdAt;
        const isSelf = senderId === userId;
        const isChat = e.type === "chat.received" || e.type === "chat.sent";
        const isEncrypted = e.encrypted || (isChat && !e.text);
        const align = isSelf ? "flex-end" : "flex-start";
        const bg = isSelf ? "#1d9bf0" : "#2a2a2a";
        const color = isSelf ? "#000" : "#f0f0f0";

        let body;
        // 私信工作台口径：加密（Chat）消息一律只显示密文占位，解密明文不在此展示；
        // 仅「无需解密的明文」（旧版 DM）直接展示文本。
        if (isEncrypted) {
          body = `<div style="display:flex;align-items:center;gap:6px;font-style:italic;opacity:0.85">
            <span>🔒</span><span>[端到端加密消息]</span>
          </div>
          <div style="font-size:11px;opacity:0.55;margin-top:4px">来自 ${escapeHtml(senderId || "?")}</div>`;
        } else {
          // 媒体消息：正文里的 t.co 链接是媒体占位，媒体已单独渲染，这里从正文剔除
          let text = e.text || "";
          if (e.hasMedia && Array.isArray(e.urls)) {
            for (const u of e.urls) {
              if (u.url) text = text.split(u.url).join("").trim();
            }
          }
          body = text ? escapeHtml(text) : "";
        }

        // 附件：仅在「无需解密的明文」（旧版 DM）时渲染；加密消息的附件明文只在解密面板展示
        if (!isEncrypted && e.attachments && e.attachments.length) {
          const ownerId = e.ownerUserId || e.owner_user_id || userId;
          body += e.attachments.map((att) => {
            // Chat 加密附件走 /api/x/chat/media；旧 DM 明文媒体走 /api/x/dm/media
            const isChatAtt = att.attachmentId && !att.mediaKey;
            const url = isChatAtt
              ? `/api/x/chat/media?user_id=${encodeURIComponent(ownerId)}&conversation_id=${encodeURIComponent(e.conversationId || "")}&attachment_id=${encodeURIComponent(att.attachmentId)}`
              : `/api/x/dm/media?message_id=${encodeURIComponent(e.id)}&media_key=${encodeURIComponent(att.mediaKey)}`;
            return renderAttachmentHtml(att, url);
          }).join("");
          if (!body.trim()) body = '<span style="opacity:0.6">[媒体消息]</span>';
        } else if (!body && !isEncrypted) {
          body = "[非文本消息]";
        }

        const badge = isChat
          ? `<span style="font-size:10px;padding:1px 6px;border-radius:8px;background:rgba(255,255,255,0.15);margin-left:6px">Chat</span>`
          : "";

        return `<div style="display:flex;justify-content:${align};margin-bottom:10px">
          <div style="max-width:72%;padding:10px 14px;border-radius:12px;background:${bg};color:${color}">
            ${body}
            <div style="font-size:11px;opacity:0.6;margin-top:4px">${ts ? new Date(ts).toLocaleString("zh-CN") : ""}${badge}</div>
          </div></div>`;
      })
      .join("");

    requestAnimationFrame(() => (msgContainer.scrollTop = msgContainer.scrollHeight));
    autoFillPeerForUser(userId, events);
  }

  // 从事件列表中找到对方用户 ID
  // 逻辑：遍历最近消息，优先取 recipientId（自己发的私信的接收方），其次 senderId（对方发来的）
  function findPeerFromEvents(userId, events) {
    for (const e of events.slice().reverse()) {
      const senderId = e.sender_id || e.senderId;
      const recipientId = e.recipient_id || e.recipientId;
      // 自己发的消息 → 对方是 recipientId
      if (senderId === userId && recipientId && recipientId !== userId) {
        return recipientId;
      }
      // 对方发的消息 → 对方是 senderId
      if (senderId && senderId !== userId) {
        return senderId;
      }
    }
    // 兜底：遍历所有消息找任何非自己的 ID（可能是 conversationId 等）
    for (const e of events) {
      const recipientId = e.recipient_id || e.recipientId;
      if (recipientId && recipientId !== userId) return recipientId;
    }
    return null;
  }

  // 自动回填某个账号的对方信息
  async function autoFillPeerForUser(userId, events) {
    // 从最近消息中找对方：优先 recipientId（自己发的消息），其次 senderId（对方发的消息）
    const peer = findPeerFromEvents(userId, events);
    if (!peer) return;

    const panel = document.getElementById(`dm-panel-${userId}`);
    if (!panel) return;

    // 更新 peerMap
    const cached = dmPeerMap.get(userId);
    if (cached && cached.peerId === peer) return;

    const recipientInput = panel.querySelector(".dm-recipient-input");
    const peerBar = panel.querySelector(".dm-peer-bar");

    // 已缓存直接回填
    if (peerNameCache.has(peer)) {
      const info = peerNameCache.get(peer);
      dmPeerMap.set(userId, { peerId: peer, peerName: info.name, peerAvatar: info.avatar });
      if (recipientInput) recipientInput.value = info.username;
      if (peerBar) {
        peerBar.style.display = "flex";
        peerBar.innerHTML = `
          <img src="${escapeAttr(info.avatar)}" alt="" style="width:36px;height:36px;border-radius:50%;background:#2a2a2a;object-fit:cover" onerror="this.style.visibility='hidden'">
          <div style="line-height:1.3">
            <div style="font-weight:600;color:#f0f0f0">${escapeHtml(info.name)}</div>
            <div style="font-size:12px;color:#888">@${escapeHtml(info.username)}</div>
          </div>`;
      }
      return;
    }

    try {
      const res = await fetch(`/api/x/users/${peer}?user_id=${userId}`);
      const data = await res.json();
      if (data?.data?.username) {
        const info = {
          username: data.data.username,
          name: data.data.name || data.data.username,
          avatar: data.data.profile_image_url || "",
        };
        peerNameCache.set(peer, info);
        dmPeerMap.set(userId, { peerId: peer, peerName: info.name, peerAvatar: info.avatar });
        if (recipientInput) recipientInput.value = info.username;
        if (peerBar) {
          peerBar.style.display = "flex";
          peerBar.innerHTML = `
            <img src="${escapeAttr(info.avatar)}" alt="" style="width:36px;height:36px;border-radius:50%;background:#2a2a2a;object-fit:cover" onerror="this.style.visibility='hidden'">
            <div style="line-height:1.3">
              <div style="font-weight:600;color:#f0f0f0">${escapeHtml(info.name)}</div>
              <div style="font-size:12px;color:#888">@${escapeHtml(info.username)}</div>
            </div>`;
        }
      }
    } catch {
      /* 查不到不影响回复 */
    }
  }

  // 轮询所有账号的本地缓存事件
  async function pollLocalEvents() {
    if (!currentUserId) return;
    try {
      // 拉取所有事件（不带 user_id，获取全部）
      const res = await fetch("/api/x/dm/local-events");
      const data = await res.json();
      if (!data.events || !data.events.length) return;

      // 一条对话在双方账号面板都完整显示：
      //   只要某绑定账号是消息的 senderId 或 recipientId，该消息就进入其面板。
      //   isSelf 由「发送方 === 面板账号」决定，故收发方向在两个面板里天然相反。
      const grouped = new Map(); // panelUserId -> events[]
      for (const e of data.events) {
        const senderId = e.sender_id || e.senderId;
        const recipientId = e.recipient_id || e.recipientId;
        for (const uid of boundUserIds) {
          if (senderId === uid || recipientId === uid) {
            if (!grouped.has(uid)) grouped.set(uid, []);
            grouped.get(uid).push(e);
          }
        }
      }

      // 确保面板存在并渲染
      for (const [userId, events] of grouped) {
        ensureDmPanel(userId);
        dmEventCache.set(userId, events);
        renderMessagesForUser(userId, events);
      }

      // 如果还没有选中账号，选中第一个有消息的
      if (!activeDmUserId && grouped.size > 0) {
        activeDmUserId = [...grouped.keys()][0];
        switchDmPanel(activeDmUserId);
      }
    } catch {
      // 静默失败，下次轮询重试
    }
  }

  async function registerWebhook() {
    try {
      const res = await fetch("/api/x/webhook/register", { method: "POST" });
      const data = await res.json();
      if (data.success) {
        setStatus(messagesStatus, `✅ Webhook 已注册: ${data.webhook.id}`, "success");
      } else {
        setStatus(messagesStatus, `❌ 注册失败: ${data.detail || data.error}`, "error");
      }
    } catch (err) {
      setStatus(messagesStatus, `❌ ${err.message}`, "error");
    }
  }

  async function subscribeDmEvents() {
    if (!requireBinding()) return;
    try {
      const res = await fetch("/api/x/webhook/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: activeDmUserId || currentUserId, events: ["dm.received", "dm.sent"] }),
      });
      const data = await res.json();
      if (data.success) {
        setStatus(messagesStatus, "✅ 已订阅 DM 事件（dm.received / dm.sent）", "success");
      } else {
        setStatus(messagesStatus, `❌ 订阅失败: ${data.detail || data.error}`, "error");
      }
    } catch (err) {
      setStatus(messagesStatus, `❌ ${err.message}`, "error");
    }
  }

  async function subscribeChatEvents() {
    if (!requireBinding()) return;
    try {
      const res = await fetch("/api/x/activity/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: activeDmUserId || currentUserId,
          events: ["chat.received", "chat.sent"],
        }),
      });
      const data = await res.json();
      if (data.success) {
        setStatus(messagesStatus, "✅ 已订阅 Chat 事件（chat.received / chat.sent）· 注意 E2EE 无明文", "success");
      } else {
        setStatus(messagesStatus, `❌ 订阅失败: ${data.detail || data.error}`, "error");
      }
    } catch (err) {
      setStatus(messagesStatus, `❌ ${err.message}`, "error");
    }
  }

  async function fetchDmEvents() {
    if (!requireBinding()) return;
    const userId = activeDmUserId || currentUserId;
    try {
      const res = await fetch(`/api/x/dm/events?user_id=${userId}`);
      const data = await res.json();
      if (data.data) {
        ensureDmPanel(userId);
        dmEventCache.set(userId, data.data);
        renderMessagesForUser(userId, data.data);
        setStatus(messagesStatus, `✅ 拉取到 ${data.data.length} 条消息`, "success");
      } else {
        setStatus(messagesStatus, `❌ ${data.detail || data.error || "无数据"}`, "error");
      }
    } catch (err) {
      setStatus(messagesStatus, `❌ ${err.message}`, "error");
    }
  }

  async function sendDmForUser(userId) {
    const panel = document.getElementById(`dm-panel-${userId}`);
    if (!panel) return;
    const recipientInput = panel.querySelector(".dm-recipient-input");
    const textInput = panel.querySelector(".dm-text-input");
    const recipient = (recipientInput?.value || "").trim();
    const text = (textInput?.value || "").trim();
    if (!text) {
      showToast("请填写消息内容", "error");
      return;
    }
    try {
      let participantId = dmPeerMap.get(userId)?.peerId;
      if (!participantId) {
        if (!recipient) {
          showToast("请在左侧输入框填写对方用户名", "error");
          return;
        }
        const userRes = await fetch(`/api/x/users/by/username/${recipient}?user_id=${userId}`);
        const userData = await userRes.json();
        if (!userData.data) {
          showToast(`找不到用户 @${recipient}`, "error");
          return;
        }
        participantId = userData.data.id;
      }

      const res = await fetch("/api/x/dm/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId, participant_id: participantId, text }),
      });
      const data = await res.json();
      if (data.success) {
        showToast("私信已发送", "success");
        textInput.value = "";
        const msgContainer = panel.querySelector(".dm-messages");
        if (msgContainer) {
          msgContainer.innerHTML += `<div style="display:flex;justify-content:flex-end;margin-bottom:10px">
            <div style="max-width:70%;padding:10px 14px;border-radius:12px;background:#1d9bf0;color:#000">
            ${escapeHtml(text)}<div style="font-size:11px;opacity:0.6;margin-top:4px">刚刚</div></div></div>`;
          requestAnimationFrame(() => (msgContainer.scrollTop = msgContainer.scrollHeight));
        }
      } else {
        showToast(`发送失败: ${data.detail || data.error}`, "error");
      }
    } catch (err) {
      showToast(`发送失败: ${err.message}`, "error");
    }
  }

  async function sendDm() {
    await sendDmForUser(activeDmUserId || currentUserId);
  }

  // ========== 页面 3: 评论回复 ==========
  async function subscribeMentions() {
    if (!requireBinding()) return;
    try {
      const res = await fetch("/api/x/activity/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: currentUserId,
          events: ["post.mention.create", "post.create"],
        }),
      });
      const data = await res.json();
      if (data.success) {
        setStatus(mentionsStatus, "✅ 已订阅提及事件（post.mention.create / post.create）", "success");
      } else {
        setStatus(mentionsStatus, `❌ 订阅失败: ${data.detail || data.error}`, "error");
      }
    } catch (err) {
      setStatus(mentionsStatus, `❌ ${err.message}`, "error");
    }
  }

  // 统一提及数据源：按 tweet id 去重合并（拉取 + 实时轮询共用），避免重复与覆盖
  const mentionMap = new Map();

  function mergeMentions(list, isRealtime) {
    for (const m of list) {
      if (!m.id) continue;
      const prev = mentionMap.get(m.id) || {};
      mentionMap.set(m.id, {
        id: m.id,
        text: m.text ?? prev.text,
        author_id: m.author_id ?? m.authorId ?? prev.author_id,
        realtime: isRealtime || prev.realtime || false,
      });
    }
    renderMentions([...mentionMap.values()]);
  }

  async function fetchMentions() {
    if (!requireBinding()) return;
    try {
      const res = await fetch(`/api/x/mentions?user_id=${currentUserId}`);
      const data = await res.json();
      if (data.data && data.data.length) {
        mergeMentions(data.data, false);
        setStatus(mentionsStatus, `✅ 拉取到 ${data.data.length} 条提及（列表共 ${mentionMap.size} 条）`, "success");
      } else if (mentionMap.size === 0) {
        mentionsList.innerHTML =
          '<div style="padding:15px;text-align:center;color:#999">暂无提及</div>';
        setStatus(mentionsStatus, data.detail || data.error || "暂无提及", "");
      } else {
        setStatus(mentionsStatus, `API 无新增，列表共 ${mentionMap.size} 条`, "");
      }
    } catch (err) {
      setStatus(mentionsStatus, `❌ ${err.message}`, "error");
    }
  }

  function renderMentions(mentions) {
    mentionsList.innerHTML = mentions
      .map((m) => {
        const rtBadge = m.realtime
          ? `<span style="font-size:10px;padding:1px 6px;border-radius:8px;background:#1d9bf0;color:#000;margin-left:6px">实时推送</span>`
          : "";
        const author = m.author_id
          ? `<span style="color:#666;margin-left:8px">author: ${escapeHtml(m.author_id)}</span>`
          : "";
        return `<div style="padding:15px;border-bottom:1px solid #2a2a2a">
      <div style="display:flex;justify-content:space-between;align-items:start">
        <div style="flex:1">
          <div style="color:#888;font-size:13px;margin-bottom:6px">Tweet ID: ${m.id}${rtBadge}${author}</div>
          <div>${escapeHtml(m.text || "")}</div>
        </div>
        <button class="btn btn-secondary" style="margin-left:10px" onclick="window.__reply('${m.id}','${escapeAttr(m.text || "")}')">回复</button>
      </div></div>`;
      })
      .join("");
  }

  // 轮询本地缓存的 Webhook 推送提及事件，实时刷新列表
  async function pollLocalMentions() {
    if (!currentUserId) return;
    const page = document.getElementById("page-replies");
    if (!page || !page.classList.contains("active")) return;
    try {
      const res = await fetch("/api/x/mentions/local-events");
      const data = await res.json();
      if (data.events && data.events.length) {
        mergeMentions(
          data.events.map((e) => ({
            id: e.id,
            text: e.text,
            author_id: e.authorId,
          })),
          true
        );
      }
    } catch {
      // 静默失败
    }
  }

  window.__reply = function (tweetId, text) {
    replyTargetId = tweetId;
    replyForm.style.display = "block";
    selectedMention.innerHTML = `<div style="color:#888;font-size:13px">回复 Tweet ${tweetId}</div><div>${escapeHtml(text)}</div>`;
    replyText.focus();
  };

  async function sendReply() {
    if (!replyTargetId) return;
    const text = replyText.value.trim();
    if (!text) {
      showToast("请输入回复内容", "error");
      return;
    }
    try {
      const res = await fetch("/api/x/tweets/reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: currentUserId,
          in_reply_to_tweet_id: replyTargetId,
          text,
        }),
      });
      const data = await res.json();
      if (data.success) {
        showToast("评论回复已发送", "success");
        replyText.value = "";
        replyForm.style.display = "none";
        replyTargetId = null;
      } else {
        showToast(`回复失败: ${data.detail || data.error}`, "error");
      }
    } catch (err) {
      showToast(`回复失败: ${err.message}`, "error");
    }
  }

  // ========== XChat 加密私信解密（全自动）==========
  // 解锁/熔断状态按账号隔离（key=userId -> { unlocked, lockedOut, lastProbeAt }），
  // 避免一个账号 PIN 错误连累其他账号无法解锁。
  const chatUnlockState = new Map();
  // 熔断后每 30s 探测一次 identity-status（无副作用，不消耗 Juicebox 配额）。
  // 服务端因 PIN 错误熔断时 blocked=true；改对 .env PIN 并重启服务后 blocked 清空，
  // 前端探测到即自动恢复解锁 —— 无需刷新页面。
  const CHAT_UNLOCK_RETRY_MS = 30 * 1000;

  function getChatUnlockState(userId) {
    let st = chatUnlockState.get(userId);
    if (!st) {
      st = { unlocked: false, lockedOut: false, lastProbeAt: 0 };
      chatUnlockState.set(userId, st);
    }
    return st;
  }

  // 绑定后自动用 PIN 解锁真机身份，随后轮询自动展示解密文本
  async function autoUnlockAndDecrypt() {
    if (!currentUserId || !chatIdentityStatus) return;
    const st = getChatUnlockState(currentUserId);

    // 熔断态：每 30s 温和探测服务端是否已恢复（重启清空 blocked），而不是永久放弃。
    // 探测接口不触发 Juicebox 调用，服务端仍在熔断时不消耗猜测配额。
    if (st.lockedOut) {
      if (Date.now() - st.lastProbeAt < CHAT_UNLOCK_RETRY_MS) return;
      st.lastProbeAt = Date.now();
      try {
        const probe = await fetch(
          `/api/x/chat/identity-status?user_id=${encodeURIComponent(currentUserId)}`
        );
        const pdata = await probe.json();
        if (pdata.juiceboxUnlocked || !pdata.blocked) {
          st.lockedOut = false;
        } else {
          return; // 服务端仍在熔断，下个周期再探测
        }
      } catch {
        return; // 探测失败，等下个周期
      }
    }

    try {
      const res = await fetch("/api/x/chat/unlock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: currentUserId }),
      });
      const data = await res.json();
      if (data.success && data.unlocked) {
        st.unlocked = true;
        st.lockedOut = false;
        chatIdentityStatus.textContent = "🔑 真机身份已自动解锁，正在实时解密加密私信";
        chatIdentityStatus.style.color = "#10b981";
        refreshChatEvents();
      } else if (data.error === "pin_not_configured") {
        chatIdentityStatus.textContent = "未配置 PIN（服务端 .env 设 XCHAT_PIN）";
        chatIdentityStatus.style.color = "#888";
      } else if (data.error === "invalid_pin" || data.error === "juicebox_locked_out") {
        // PIN 错误：熔断该账号自动解锁以保护 Juicebox 猜测配额，
        // 但保留周期探测，服务端修复（改 .env + 重启）后 30s 内自动恢复。
        st.lockedOut = true;
        st.lastProbeAt = Date.now();
        chatIdentityStatus.textContent = `🛑 ${data.hint || "PIN 不匹配，已停止自动重试"}（服务端修复后 30 秒内自动恢复，无需刷新页面）`;
        chatIdentityStatus.style.color = "#f4212e";
      } else {
        chatIdentityStatus.textContent = `解锁失败：${data.hint || data.error}`;
        chatIdentityStatus.style.color = "#888";
      }
    } catch {
      /* 忽略，下次轮询重试 */
    }
  }

  // 轮询本地已解密的 Chat 事件并自动展示（无需手动操作）
  async function refreshChatEvents() {
    if (!currentUserId) return;
    if (!getChatUnlockState(currentUserId).unlocked) return;
    try {
      const res = await fetch("/api/x/chat/local-events");
      const data = await res.json();
      const events = (data.events || []).map((e) => ({
        senderId: e.senderId,
        text: e.decrypted ? e.text : null,
        encrypted: e.encrypted,
        decrypted: e.decrypted,
        createdAt: e.createdAt,
        ownerUserId: e.ownerUserId,
        conversationId: e.conversationId,
        attachments: e.attachments || [],
      }));
      renderChatDecrypted(events, true);
      const okCount = events.filter((e) => e.decrypted).length;
      setStatus(chatDecryptStatus, `已解密 ${okCount} / ${events.length} 条实时私信`, "");
    } catch {
      /* 静默，下次轮询重试 */
    }
  }

  function renderChatDecrypted(messages, showEncryptedState) {
    if (!chatDecryptList) return;
    if (!messages || !messages.length) {
      chatDecryptList.innerHTML =
        '<p style="color:#666;text-align:center;padding:20px">暂无消息</p>';
      return;
    }
    chatDecryptList.innerHTML = messages
      .map((m) => {
        const when = m.createdAt ? new Date(m.createdAt).toLocaleString() : "";
        let body = "";

        // 文本内容
        if (m.text != null) {
          body += `<div style="color:#e5e5e5">${escapeHtml(m.text)}</div>`;
        } else if (showEncryptedState && m.encrypted && !m.decrypted) {
          body += '<div style="color:#f59e0b">🔒 密文（尚未解密 / 无对应身份）</div>';
        }

        // 附件渲染（图片 / 视频 / 文件，按归一化 kind 分类渲染）
        if (m.attachments && m.attachments.length) {
          const userId = m.ownerUserId || currentUserId;
          const convId = m.conversationId || "";
          body += m.attachments.map((att) => {
            const url = `/api/x/chat/media?user_id=${encodeURIComponent(userId)}&conversation_id=${encodeURIComponent(convId)}&attachment_id=${encodeURIComponent(att.attachmentId)}`;
            return renderAttachmentHtml(att, url);
          }).join("");
        } else if (!m.text && m.decrypted) {
          // 已解密但无文本也无附件
          body += '<div style="color:#666">（无文本内容）</div>';
        }

        if (!body) body = '<div style="color:#666">（无文本内容）</div>';

        return `<div style="padding:8px 10px;border-bottom:1px solid #1c1c1c">
          <div style="font-size:12px;color:#888;margin-bottom:2px">发送者 ${escapeHtml(
            String(m.senderId || "?")
          )} · ${when}</div>${body}</div>`;
      })
      .join("");
  }

  // ========== 工具函数 ==========
  function setStatus(el, msg, type) {
    if (!el) return;
    el.textContent = msg;
    el.style.color =
      type === "success" ? "#10b981" : type === "error" ? "#ef4444" : "#888";
  }

  function showToast(msg, type) {
    toast.textContent = msg;
    toast.className = "toast show " + (type || "");
    setTimeout(() => (toast.className = "toast"), 3000);
  }

  function scrollToBottom() {
    // 兼容旧调用，实际滚动已在各面板内处理
    if (activeDmUserId) {
      const panel = document.getElementById(`dm-panel-${activeDmUserId}`);
      const msgContainer = panel?.querySelector(".dm-messages");
      if (msgContainer) {
        requestAnimationFrame(() => (msgContainer.scrollTop = msgContainer.scrollHeight));
      }
    }
  }

  // 附件：把字节数格式化为人类可读大小（元数据 filesizeBytes 是加密后大小，仅约值）
  function formatSize(bytes) {
    if (!bytes || bytes <= 0) return "";
    const units = ["B", "KB", "MB", "GB"];
    let i = 0;
    let n = bytes;
    while (n >= 1024 && i < units.length - 1) {
      n /= 1024;
      i++;
    }
    return n.toFixed(n >= 10 || i === 0 ? 0 : 1) + " " + units[i];
  }

  // 附件统一渲染：按归一化后的 kind 分类（image/gif/video/text/pdf/file）
  function renderAttachmentHtml(att, url) {
    const name = escapeHtml(att.filename || att.attachmentId || "附件");
    const size = att.filesizeBytes
      ? `<span style="font-size:11px;opacity:0.6;margin-left:6px">${formatSize(att.filesizeBytes)}</span>`
      : "";
    const dlUrl = `${url}&download=1`;

    switch (att.kind) {
      case "image":
      case "gif":
        // 旧 DM 照片：ton.twitter.com 需 OAuth 1.0a，本 demo 仅 OAuth2 无法内联，
        // 有 fallbackUrl 时直接渲染为「在 X 中查看」卡片
        if (att.fallbackUrl) {
          return `<div style="margin-top:6px;padding:8px 10px;background:#141414;border:1px solid #2a2a2a;border-radius:8px;display:flex;align-items:center;gap:8px">
            <span>📷</span>
            <span style="word-break:break-all">${name}</span>
            <a href="${escapeAttr(att.fallbackUrl)}" target="_blank" style="color:#1d9bf0;margin-left:auto;white-space:nowrap">在 X 中查看</a>
          </div>`;
        }
        return `<div style="margin-top:6px">
          <img loading="lazy" style="max-width:100%;max-height:280px;border-radius:8px;cursor:pointer" src="${url}"
            onclick="window.open('${url}','_blank')" alt="${name}" />
          <div style="font-size:11px;color:#666;margin-top:2px">${name}${size}</div>
        </div>`;
      case "video": {
        const poster = att.previewUrl ? `poster="${escapeAttr(att.previewUrl)}"` : "";
        return `<div style="margin-top:6px">
          <video controls preload="metadata" ${poster} style="max-width:100%;max-height:280px;border-radius:8px" src="${url}"></video>
          <div style="font-size:11px;color:#666;margin-top:2px">${name}${size}</div>
        </div>`;
      }
      case "text": // md / txt 等纯文本：提供下载 + 可选预览
        return `<div style="margin-top:6px;padding:8px 10px;background:#141414;border:1px solid #2a2a2a;border-radius:8px;display:flex;align-items:center;gap:8px">
          <span>📄</span>
          <a href="${dlUrl}" style="color:#1d9bf0;word-break:break-all">${name}</a>${size}
        </div>`;
      case "pdf": // 浏览器原生 iframe 内嵌预览
        return `<div style="margin-top:6px;padding:8px 10px;background:#141414;border:1px solid #2a2a2a;border-radius:8px">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
            <span>📕</span>
            <a href="${url}" target="_blank" style="color:#1d9bf0;word-break:break-all">${name}</a>${size}
            <a href="${dlUrl}" style="color:#888;margin-left:auto;white-space:nowrap">下载</a>
          </div>
          <iframe src="${url}" style="width:100%;height:360px;border:0;border-radius:6px;background:#fff"></iframe>
        </div>`;
      default: // file：zip / docx / 其他 → 下载卡片
        return `<div style="margin-top:6px;padding:8px 10px;background:#141414;border:1px solid #2a2a2a;border-radius:8px;display:flex;align-items:center;gap:8px">
          <span>📦</span>
          <span style="word-break:break-all">${name}</span>${size}
          <a href="${dlUrl}" style="color:#1d9bf0;margin-left:auto;white-space:nowrap">下载</a>
        </div>`;
    }
  }

  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  function escapeAttr(text) {
    return String(text).replace(/'/g, "\\'").replace(/"/g, "&quot;").replace(/\n/g, " ");
  }

  init();
})();