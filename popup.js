// =============================================================
// 豆包浏览器 - 白名单小助手 | Popup UI Logic
// =============================================================

// ---------------------------------------------------------
// 常量与存储 Key
// ---------------------------------------------------------
const STORAGE_KEYS = {
  domains: "whitelistDomains",
  enabled: "enabled",
  closeTab: "closeTabAfterRedirect",
  themeMode: "themeMode",
  lastBlocked: "lastBlocked",
  backups: "whitelistBackups",
};

const DEFAULT_DOMAINS = [
  "doubao.com",
  "chatgpt.com",
  "claude.ai",
  "m365.cloud.microsoft",
  "gemini.google.com",
  "live.com",
];

const MAX_BACKUPS = 3;

// ---------------------------------------------------------
// 工具函数
// ---------------------------------------------------------

function normalizeDomain(input) {
  const s = String(input ?? "")
    .trim()
    .toLowerCase();
  if (!s) return null;

  const stripped = s.replace(/^\*\./, "").replace(/^\.+/, "");
  if (!stripped) return null;

  if (stripped.includes("://")) {
    try {
      return new URL(stripped).hostname.replace(/^\.+/, "") || null;
    } catch {
      return null;
    }
  }

  const host = stripped.split(/[/?#]/)[0];
  if (!host || host.includes("@")) return null;
  if (!/^[a-z0-9.-]+$/.test(host)) return null;
  if (host.startsWith("-") || host.endsWith("-")) return null;
  if (!host.includes(".")) return null;
  return host;
}

function uniqDomains(list) {
  const out = [];
  const seen = new Set();
  for (const it of Array.isArray(list) ? list : []) {
    const d = normalizeDomain(it);
    if (!d) continue;
    if (seen.has(d)) continue;
    seen.add(d);
    out.push(d);
  }
  return out;
}

function getDomainInfo(domain) {
  if (!domain) return { key: "", isIp: false };

  // 1. IP 地址特殊处理
  if (/^\d+\.\d+\.\d+\.\d+$/.test(domain)) {
    return {
      key: domain, // IP 作为第一排序键
      isIp: true,
      tld: "",
      sub: "",
    };
  }

  // 2. 提取根域名逻辑 (复用之前逻辑)
  const parts = domain.split(".");
  let rootDomain = domain;
  let rootPartsCount = 2; // 默认根域名是最后两段

  if (parts.length > 2) {
    const last = parts[parts.length - 1];
    const secondLast = parts[parts.length - 2];
    const commonSLDs = ["co", "com", "net", "org", "edu", "gov", "ac"];

    if (last.length === 2 && commonSLDs.includes(secondLast)) {
      rootDomain = parts.slice(-3).join(".");
      rootPartsCount = 3;
    } else {
      rootDomain = parts.slice(-2).join(".");
    }
  }

  // 3. 提取核心词 (SLD) 和 TLD
  // 例如 google.com -> sld: google, tld: com
  // google.co.uk -> sld: google, tld: co.uk
  const rootParts = rootDomain.split(".");
  const sld = rootParts[0]; // 根域名的第一部分作为核心分组词
  const tld = rootParts.slice(1).join(".");

  // 4. 提取子域名部分
  // mail.google.com -> sub: mail
  // google.com -> sub: ""
  const sub =
    domain.length > rootDomain.length
      ? domain.slice(0, domain.length - rootDomain.length - 1) // 去掉 .rootDomain
      : "";

  return {
    key: sld, // 第一排序键：核心词 (google, baidu)
    tld: tld, // 第二排序键：后缀 (com, co.uk)
    sub: sub, // 第三排序键：子域名 (mail, www)
    isIp: false,
    original: domain,
  };
}

function formatDate(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return (
    d.getFullYear() +
    "-" +
    pad(d.getMonth() + 1) +
    "-" +
    pad(d.getDate()) +
    " " +
    pad(d.getHours()) +
    ":" +
    pad(d.getMinutes())
  );
}

function generateBackupName(domainsCount) {
  return `${formatDate(Date.now())} (${domainsCount}个)`;
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// ---------------------------------------------------------
// 防抖
// ---------------------------------------------------------
function debounce(fn, delay) {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

// ---------------------------------------------------------
// 状态提示
// ---------------------------------------------------------

/** 显示状态消息，支持自动消失 */
function setStatus(text, isError = false) {
  const activeTab = document.querySelector(".tab-content.active");
  const el = activeTab
    ? activeTab.querySelector(".status")
    : document.querySelector(".status");
  if (!el) return;
  el.textContent = text || "";
  el.classList.toggle("error", Boolean(isError));

  // 自动消失（非错误消息 3 秒后消失）
  if (text && !isError) {
    clearTimeout(el._statusTimer);
    el._statusTimer = setTimeout(() => {
      if (el.textContent === text) el.textContent = "";
    }, 3000);
  }
}

// ---------------------------------------------------------
// 主题
// ---------------------------------------------------------

function applyThemeMode(mode) {
  const v = mode === "dark" || mode === "light" ? mode : "system";
  if (v === "system") {
    delete document.documentElement.dataset.theme;
    return;
  }
  document.documentElement.dataset.theme = v;
}

// ---------------------------------------------------------
// Storage 读写
// ---------------------------------------------------------

async function getState() {
  const data = await chrome.storage.local.get([
    STORAGE_KEYS.domains,
    STORAGE_KEYS.enabled,
    STORAGE_KEYS.closeTab,
    STORAGE_KEYS.themeMode,
    STORAGE_KEYS.lastBlocked,
    STORAGE_KEYS.backups,
  ]);
  return {
    domains: uniqDomains(data[STORAGE_KEYS.domains] ?? DEFAULT_DOMAINS),
    enabled:
      typeof data[STORAGE_KEYS.enabled] === "boolean"
        ? data[STORAGE_KEYS.enabled]
        : true,
    closeTabAfterRedirect:
      typeof data[STORAGE_KEYS.closeTab] === "boolean"
        ? data[STORAGE_KEYS.closeTab]
        : false,
    themeMode:
      typeof data[STORAGE_KEYS.themeMode] === "string"
        ? data[STORAGE_KEYS.themeMode]
        : "system",
    lastBlocked: Array.isArray(data[STORAGE_KEYS.lastBlocked])
      ? data[STORAGE_KEYS.lastBlocked]
      : [],
    backups: Array.isArray(data[STORAGE_KEYS.backups])
      ? data[STORAGE_KEYS.backups]
      : [],
  };
}

async function setDomains(domains) {
  await chrome.storage.local.set({
    [STORAGE_KEYS.domains]: uniqDomains(domains),
  });
}

async function saveBackups(backups) {
  await chrome.storage.local.set({ [STORAGE_KEYS.backups]: backups });
}

// ---------------------------------------------------------
// 快捷 DOM 创建
// ---------------------------------------------------------

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, val] of Object.entries(attrs)) {
    if (key === "className") node.className = val;
    else if (key === "textContent") node.textContent = val;
    else if (key === "style" && typeof val === "object") {
      Object.assign(node.style, val);
    } else if (key.startsWith("on")) {
      node.addEventListener(key.slice(2).toLowerCase(), val);
    } else {
      node.setAttribute(key, val);
    }
  }
  for (const child of children) {
    if (typeof child === "string") {
      node.appendChild(document.createTextNode(child));
    } else if (child) {
      node.appendChild(child);
    }
  }
  return node;
}

// ---------------------------------------------------------
// 下载 & 导入
// ---------------------------------------------------------

function downloadBackup(backup) {
  const content = backup.domains.join("\n");
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `whitelist_backup_${backup.name.replace(/[:\s()]/g, "_")}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function triggerImportFile() {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".txt,.csv,.json";
    input.addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (!file) return resolve(null);
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => resolve(null);
      reader.readAsText(file);
    });
    input.click();
  });
}

// ---------------------------------------------------------
// Overflow Prompt
// ---------------------------------------------------------

let overflowPendingBackup = null;

function showOverflowPrompt(oldestBackup, newBackupDraft) {
  overflowPendingBackup = newBackupDraft;
  const overlay = document.getElementById("overflowPrompt");
  const titleEl = overlay?.querySelector(".sectionTitle");
  const nameEl = document.getElementById("overflowTargetName");

  if (overlay && titleEl && nameEl) {
    titleEl.textContent = `备份数量已达上限 (${MAX_BACKUPS}个)`;
    nameEl.textContent = `最早的备份：${oldestBackup.name}`;
    overlay.style.display = "flex";
  }
}

function closeOverflowPrompt() {
  const overlay = document.getElementById("overflowPrompt");
  if (overlay) overlay.style.display = "none";
  overflowPendingBackup = null;
}

// ---------------------------------------------------------
// Compare
// ---------------------------------------------------------

function showCompareResult(backupName, currentDomains, backupDomains) {
  const currentSet = new Set(currentDomains);
  const backupSet = new Set(backupDomains);

  const missing = backupDomains.filter((d) => !currentSet.has(d));
  const added = currentDomains.filter((d) => !backupSet.has(d));

  const diffMissingEl = document.getElementById("diffMissing");
  const diffAddedEl = document.getElementById("diffAdded");
  const overlay = document.getElementById("compareResult");

  if (diffMissingEl && diffAddedEl && overlay) {
    diffMissingEl.textContent = missing.length ? missing.join("\n") : "(无)";
    diffAddedEl.textContent = added.length ? added.join("\n") : "(无)";
    overlay.style.display = "flex";
  }
}

function closeCompareResult() {
  const overlay = document.getElementById("compareResult");
  if (overlay) overlay.style.display = "none";
}

// ---------------------------------------------------------
// Backup Editor
// ---------------------------------------------------------

let currentEditingBackupId = null;

async function openBackupEditor(backupId) {
  const state = await getState();
  const backup = state.backups.find((b) => b.id === backupId);
  if (!backup) return;

  currentEditingBackupId = backupId;
  const overlay = document.getElementById("backupEditor");
  const textarea = document.getElementById("backupEditorContent");

  if (overlay && textarea) {
    textarea.value = backup.domains.join("\n");
    overlay.style.display = "flex";
    textarea.focus();
  }
}

function closeBackupEditor() {
  const overlay = document.getElementById("backupEditor");
  if (overlay) overlay.style.display = "none";
  currentEditingBackupId = null;
}

async function saveBackupContent() {
  if (!currentEditingBackupId) return;
  const textarea = document.getElementById("backupEditorContent");
  if (!textarea) return;

  const newDomains = uniqDomains(textarea.value.split("\n"));
  const state = await getState();
  const nextBackups = state.backups.map((b) =>
    b.id === currentEditingBackupId ? { ...b, domains: newDomains } : b,
  );

  await saveBackups(nextBackups);
  closeBackupEditor();
  setStatus("备份内容已更新");
  render();
}

// ---------------------------------------------------------
// 渲染 - 拆分为独立模块
// ---------------------------------------------------------

let searchKeyword = "";

// 渲染防抖，避免 storage.onChanged 和手动调用同时触发
let renderScheduled = false;

function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    render();
  });
}

/** 渲染最近拦截列表 */
function renderLastBlocked(state) {
  const container = document.getElementById("lastBlockedList");
  if (!container) return;
  container.textContent = "";

  if (!state.lastBlocked.length) {
    container.appendChild(
      el("div", {
        className: "status",
        textContent: "暂无拦截记录",
        style: { marginTop: "0" },
      }),
    );
    return;
  }

  for (const item of state.lastBlocked) {
    const row = el(
      "div",
      {
        className: "item",
        style: { minHeight: "auto", padding: "4px 8px" },
      },
      [
        el("div", {
          className: "domain",
          textContent: item.host || "Unknown",
          title: item.url,
          style: { fontSize: "12px" },
        }),
        el("button", {
          className: "btn small",
          textContent: "📋",
          title: "复制 URL",
          style: { marginLeft: "auto" },
          onClick: async () => {
            try {
              await navigator.clipboard.writeText(item.url);
              setStatus("已复制 URL");
            } catch {
              setStatus("复制失败", true);
            }
          },
        }),
      ],
    );
    container.appendChild(row);
  }
}

/** 渲染白名单列表 */
function renderWhitelist(state) {
  const listEl = document.getElementById("list");
  if (!listEl) return;

  // 保存滚动位置
  const scrollTop = listEl.scrollTop;
  listEl.textContent = "";

  let domains = state.domains.slice().sort((a, b) => {
    const infoA = getDomainInfo(a);
    const infoB = getDomainInfo(b);

    // 1. IP 地址排在最后 (或者最前，看喜好，这里放最后)
    if (infoA.isIp !== infoB.isIp) {
      return infoA.isIp ? 1 : -1;
    }
    if (infoA.isIp) {
      return a.localeCompare(b, undefined, { numeric: true });
    }

    // 2. 按核心词 (SLD) 排序 (google, baidu)
    const cmpKey = infoA.key.localeCompare(infoB.key);
    if (cmpKey !== 0) return cmpKey;

    // 3. 按 TLD 排序 (com, co.uk)
    // 这样 google.co.uk 和 google.com 会在一起
    const cmpTld = infoA.tld.localeCompare(infoB.tld);
    if (cmpTld !== 0) return cmpTld;

    // 4. 主域名优先 (无子域名的排在前面)
    // sub: "" vs "mail"
    if (!infoA.sub && infoB.sub) return -1;
    if (infoA.sub && !infoB.sub) return 1;

    // 5. 按子域名排序
    return infoA.sub.localeCompare(infoB.sub);
  });

  if (searchKeyword) {
    const kw = searchKeyword.toLowerCase();
    domains = domains.filter((d) => d.includes(kw));
  }

  if (!domains.length) {
    listEl.appendChild(
      el("div", {
        className: "status",
        textContent: searchKeyword ? "无匹配结果" : "白名单为空",
      }),
    );
    return;
  }

  const editingDomain = listEl.dataset.editing || "";

  for (const d of domains) {
    if (editingDomain === d) {
      listEl.appendChild(createEditingItem(d, state, listEl));
    } else {
      listEl.appendChild(createDomainItem(d, state, listEl));
    }
  }

  // 恢复滚动位置
  listEl.scrollTop = scrollTop;
}

function createEditingItem(domain, state, listEl) {
  const input = el("input", { className: "input", value: domain });

  const doSave = async () => {
    const nextValue = normalizeDomain(input.value);
    if (!nextValue) {
      setStatus("域名格式不正确", true);
      return;
    }
    if (
      state.domains.some(
        (x) => x !== domain && normalizeDomain(x) === nextValue,
      )
    ) {
      setStatus("已存在：" + nextValue, true);
      return;
    }
    const next = state.domains.map((x) => (x === domain ? nextValue : x));
    await setDomains(next);
    listEl.dataset.editing = "";
    setStatus("已更新：" + domain + " → " + nextValue);
    render();
  };

  const doCancel = () => {
    listEl.dataset.editing = "";
    setStatus("");
    render();
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doSave();
    if (e.key === "Escape") doCancel();
  });

  const item = el("div", { className: "item" }, [
    input,
    el("div", { className: "actions" }, [
      el("button", {
        className: "btn small",
        textContent: "保存",
        onClick: doSave,
      }),
      el("button", {
        className: "btn small",
        textContent: "取消",
        onClick: doCancel,
      }),
    ]),
  ]);

  setTimeout(() => input.focus(), 0);
  return item;
}

function createDomainItem(domain, state, listEl) {
  return el("div", { className: "item" }, [
    el("div", { className: "domain", textContent: domain }),
    el("div", { className: "actions" }, [
      el("button", {
        className: "btn small",
        textContent: "编辑",
        onClick: () => {
          listEl.dataset.editing = domain;
          setStatus("");
          render();
        },
      }),
      el("button", {
        className: "btn remove",
        textContent: "移除",
        onClick: async () => {
          const next = state.domains.filter((x) => x !== domain);
          await setDomains(next);
          setStatus("已移除：" + domain);
          if (listEl.dataset.editing === domain) listEl.dataset.editing = "";
          render();
        },
      }),
    ]),
  ]);
}

/** 渲染备份列表 */
function renderBackups(state) {
  const backupListEl = document.getElementById("backupList");
  if (!backupListEl) return;

  const scrollTop = backupListEl.scrollTop;
  backupListEl.textContent = "";

  // 收藏置顶，然后时间倒序
  const backups = state.backups.slice().sort((a, b) => {
    if (a.isFavorite !== b.isFavorite) return a.isFavorite ? -1 : 1;
    return b.ts - a.ts;
  });

  if (!backups.length) {
    backupListEl.appendChild(
      el("div", { className: "status", textContent: "暂无备份" }),
    );
    return;
  }

  const editingId = backupListEl.dataset.editingId || "";

  for (const bk of backups) {
    if (editingId === bk.id) {
      backupListEl.appendChild(createBackupEditItem(bk, state, backupListEl));
    } else {
      backupListEl.appendChild(
        createBackupDisplayItem(bk, state, backupListEl),
      );
    }
  }

  backupListEl.scrollTop = scrollTop;
}

function createBackupEditItem(bk, state, backupListEl) {
  const input = el("input", { className: "input", value: bk.name });

  const doSave = async () => {
    const newName = input.value.trim();
    if (!newName) return;
    const nextBackups = state.backups.map((b) =>
      b.id === bk.id ? { ...b, name: newName } : b,
    );
    await saveBackups(nextBackups);
    backupListEl.dataset.editingId = "";
    render();
  };

  const doCancel = () => {
    backupListEl.dataset.editingId = "";
    render();
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doSave();
    if (e.key === "Escape") doCancel();
  });

  const item = el("div", { className: "item" }, [
    input,
    el("div", { className: "actions" }, [
      el("button", {
        className: "btn small",
        textContent: "保存",
        onClick: doSave,
      }),
      el("button", {
        className: "btn small",
        textContent: "取消",
        onClick: doCancel,
      }),
    ]),
  ]);

  setTimeout(() => input.focus(), 0);
  return item;
}

function createBackupDisplayItem(bk, state, backupListEl) {
  const item = el("div", {
    className: "item",
    style: { flexDirection: "column", alignItems: "stretch" },
  });

  // Star
  const star = el("span", {
    textContent: bk.isFavorite ? "★" : "☆",
    style: {
      cursor: "pointer",
      color: bk.isFavorite ? "#eac54f" : "var(--subtle)",
      fontSize: "14px",
    },
    title: bk.isFavorite ? "取消收藏" : "设为收藏",
    onClick: async (e) => {
      e.stopPropagation();
      const nextBackups = state.backups.map((b) =>
        b.id === bk.id ? { ...b, isFavorite: !b.isFavorite } : b,
      );
      await saveBackups(nextBackups);
      render();
    },
  });

  const nameSpan = el("span", {
    textContent: bk.name,
    title: `包含 ${bk.domains.length} 个域名\n创建于: ${formatDate(bk.ts)}`,
  });

  const nameContainer = el(
    "div",
    {
      className: "domain",
      style: { display: "flex", alignItems: "center", gap: "4px" },
    },
    [star, nameSpan],
  );

  // Expanded actions
  const expandedRow = el(
    "div",
    {
      className: "expanded-row",
      style: {
        display: "none",
        gap: "4px",
        marginTop: "4px",
        justifyContent: "flex-end",
      },
    },
    [
      el("button", {
        className: "btn small",
        textContent: "导出",
        onClick: () => downloadBackup(bk),
      }),
      el("button", {
        className: "btn small",
        textContent: "内容",
        onClick: () => openBackupEditor(bk.id),
      }),
      el("button", {
        className: "btn small",
        textContent: "改名",
        onClick: () => {
          backupListEl.dataset.editingId = bk.id;
          render();
        },
      }),
      el("button", {
        className: "btn remove",
        textContent: "删除",
        onClick: async () => {
          if (confirm(`确定要删除备份"${bk.name}"吗？`)) {
            const nextBackups = state.backups.filter((b) => b.id !== bk.id);
            await saveBackups(nextBackups);
            render();
          }
        },
      }),
    ],
  );

  // Toggle button
  const expandBtn = el("button", {
    className: "btn small",
    textContent: "更多",
    onClick: () => {
      const isExpanded = expandedRow.style.display === "flex";
      expandedRow.style.display = isExpanded ? "none" : "flex";
      expandBtn.textContent = isExpanded ? "更多" : "收起";
    },
  });

  const topRow = el(
    "div",
    {
      style: {
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
      },
    },
    [
      nameContainer,
      el("div", { className: "actions" }, [
        el("button", {
          className: "btn small",
          textContent: "恢复",
          title: "覆盖当前白名单",
          onClick: async () => {
            if (
              confirm(`确定要恢复备份"${bk.name}"吗？\n当前白名单将被覆盖！`)
            ) {
              await setDomains(bk.domains);
              setStatus(`已恢复备份：${bk.name}`);
              render();
            }
          },
        }),
        el("button", {
          className: "btn small",
          textContent: "对比",
          title: "与当前白名单对比",
          onClick: () => showCompareResult(bk.name, state.domains, bk.domains),
        }),
        expandBtn,
      ]),
    ],
  );

  item.appendChild(topRow);
  item.appendChild(expandedRow);
  return item;
}

// ---------------------------------------------------------
// 主渲染函数
// ---------------------------------------------------------

async function render() {
  const state = await getState();

  // 设置类控件
  const enabledEl = document.getElementById("enabled");
  const closeTabEl = document.getElementById("closeTabAfterRedirect");
  const themeModeEl = document.getElementById("themeMode");

  if (enabledEl) enabledEl.checked = state.enabled;
  if (closeTabEl) closeTabEl.checked = state.closeTabAfterRedirect;
  if (themeModeEl) {
    themeModeEl.value =
      state.themeMode === "light" || state.themeMode === "dark"
        ? state.themeMode
        : "system";
    applyThemeMode(themeModeEl.value);
  }

  // 分模块渲染
  renderLastBlocked(state);
  renderWhitelist(state);
  renderBackups(state);
}

// ---------------------------------------------------------
// Tab 导航
// ---------------------------------------------------------

function initTabs() {
  const navItems = document.querySelectorAll(".nav-item");
  const contents = document.querySelectorAll(".tab-content");

  navItems.forEach((btn) => {
    btn.addEventListener("click", () => {
      navItems.forEach((n) => n.classList.remove("active"));
      btn.classList.add("active");
      const targetId = btn.dataset.target;
      contents.forEach((c) => {
        c.classList.toggle("active", c.id === targetId);
      });
      setStatus("");
    });
  });
}

// ---------------------------------------------------------
// 创建备份（提取公共逻辑,消除重复代码）
// ---------------------------------------------------------

function buildNewBackup(customName, domains) {
  const name = customName || generateBackupName(domains.length);
  return {
    id: generateId(),
    ts: Date.now(),
    name,
    domains: [...domains],
    isFavorite: false,
  };
}

async function handleCreateBackup() {
  const state = await getState();
  const input = document.getElementById("backupNameInput");
  const customName = input?.value.trim() || "";
  const newBackup = buildNewBackup(customName, state.domains);

  if (state.backups.length >= MAX_BACKUPS) {
    const sortedByTime = state.backups.slice().sort((a, b) => b.ts - a.ts);
    const oldest = sortedByTime[sortedByTime.length - 1];
    showOverflowPrompt(oldest, newBackup);
    return;
  }

  await saveBackups([newBackup, ...state.backups]);
  if (input) input.value = "";
  setStatus(`已创建备份：${newBackup.name}`);
  render();
}

async function handleOverflowAction(shouldDownload) {
  if (!overflowPendingBackup) return;
  const state = await getState();
  const sortedByTime = state.backups.slice().sort((a, b) => b.ts - a.ts);
  const oldest = sortedByTime[sortedByTime.length - 1];

  if (shouldDownload) downloadBackup(oldest);

  const nextBackups = state.backups.filter((b) => b.id !== oldest.id);
  nextBackups.unshift(overflowPendingBackup);

  await saveBackups(nextBackups);
  closeOverflowPrompt();
  const input = document.getElementById("backupNameInput");
  if (input) input.value = "";
  setStatus(`已创建备份：${overflowPendingBackup.name}`);
  render();
}

// ---------------------------------------------------------
// 导入白名单
// ---------------------------------------------------------

async function handleImportWhitelist() {
  const text = await triggerImportFile();
  if (!text) return;

  // 尝试解析为 JSON（兼容 JSON 格式备份）
  let domains;
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      domains = parsed;
    } else if (parsed.domains && Array.isArray(parsed.domains)) {
      domains = parsed.domains;
    } else {
      domains = text.split(/[\n,;]+/);
    }
  } catch {
    // 按行分割
    domains = text.split(/[\n,;]+/);
  }

  const validDomains = uniqDomains(domains);
  if (!validDomains.length) {
    setStatus("导入文件中没有有效域名", true);
    return;
  }

  const state = await getState();
  const merged = uniqDomains([...state.domains, ...validDomains]);
  const newCount = merged.length - state.domains.length;

  await setDomains(merged);
  setStatus(`导入完成：新增 ${newCount} 个域名（共 ${merged.length} 个）`);
  render();
}

// ---------------------------------------------------------
// 初始化
// ---------------------------------------------------------

async function init() {
  initTabs();

  // 确保默认数据
  const existing = await chrome.storage.local.get([
    STORAGE_KEYS.domains,
    STORAGE_KEYS.themeMode,
  ]);
  const toSet = {
    [STORAGE_KEYS.domains]: uniqDomains(
      existing[STORAGE_KEYS.domains] ?? DEFAULT_DOMAINS,
    ),
  };
  if (typeof existing[STORAGE_KEYS.themeMode] !== "string")
    toSet[STORAGE_KEYS.themeMode] = "system";
  await chrome.storage.local.set(toSet);

  // --- 事件绑定 ---

  // 添加域名
  const addBtn = document.getElementById("addBtn");
  addBtn?.addEventListener("click", async () => {
    const input = document.getElementById("domainInput");
    const d = normalizeDomain(input.value);
    if (!d) {
      setStatus("域名格式不正确", true);
      return;
    }
    const state = await getState();
    if (state.domains.includes(d)) {
      setStatus("已存在：" + d);
      input.value = "";
      return;
    }
    await setDomains([...state.domains, d]);
    setStatus("已添加：" + d);
    input.value = "";
    render();
  });

  // 回车添加
  const domainInput = document.getElementById("domainInput");
  domainInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") addBtn?.click();
  });

  // 搜索过滤（防抖）
  const searchFilter = document.getElementById("searchFilter");
  const debouncedSearch = debounce((val) => {
    searchKeyword = val.trim();
    render();
  }, 150);
  searchFilter?.addEventListener("input", (e) =>
    debouncedSearch(e.target.value),
  );

  // 创建备份
  document
    .getElementById("createBackupBtn")
    ?.addEventListener("click", handleCreateBackup);

  // 导入白名单
  document
    .getElementById("importBtn")
    ?.addEventListener("click", handleImportWhitelist);

  // Overflow 弹窗按钮
  document
    .getElementById("overflowDownloadDelete")
    ?.addEventListener("click", () => handleOverflowAction(true));
  document
    .getElementById("overflowDelete")
    ?.addEventListener("click", () => handleOverflowAction(false));
  document
    .getElementById("overflowCancel")
    ?.addEventListener("click", closeOverflowPrompt);

  // 对比关闭
  document
    .getElementById("compareClose")
    ?.addEventListener("click", closeCompareResult);

  // 重置按钮（二次确认）
  const resetBtn = document.getElementById("resetBtn");
  if (resetBtn) {
    let resetTimer = null;
    resetBtn.addEventListener("click", async () => {
      if (resetBtn.dataset.confirming === "true") {
        clearTimeout(resetTimer);
        await setDomains(DEFAULT_DOMAINS);
        setStatus("已恢复默认");
        resetBtn.textContent = "恢复默认";
        resetBtn.dataset.confirming = "false";
        render();
      } else {
        resetBtn.textContent = "确定要恢复吗？";
        resetBtn.dataset.confirming = "true";
        resetTimer = setTimeout(() => {
          if (resetBtn.dataset.confirming === "true") {
            resetBtn.textContent = "恢复默认";
            resetBtn.dataset.confirming = "false";
          }
        }, 3000);
      }
    });
  }

  // 设置开关
  document.getElementById("enabled")?.addEventListener("change", async (e) => {
    await chrome.storage.local.set({
      [STORAGE_KEYS.enabled]: e.target.checked,
    });
  });

  document
    .getElementById("closeTabAfterRedirect")
    ?.addEventListener("change", async (e) => {
      await chrome.storage.local.set({
        [STORAGE_KEYS.closeTab]: e.target.checked,
      });
    });

  document
    .getElementById("themeMode")
    ?.addEventListener("change", async (e) => {
      const v =
        e.target.value === "light" || e.target.value === "dark"
          ? e.target.value
          : "system";
      await chrome.storage.local.set({ [STORAGE_KEYS.themeMode]: v });
      applyThemeMode(v);
    });

  // 备份编辑器
  document
    .getElementById("backupEditorSave")
    ?.addEventListener("click", saveBackupContent);
  document
    .getElementById("backupEditorCancel")
    ?.addEventListener("click", closeBackupEditor);

  // Storage 变化监听（使用 scheduleRender 防抖，避免双重渲染）
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    const watchedKeys = Object.values(STORAGE_KEYS);
    if (watchedKeys.some((key) => key in changes)) {
      scheduleRender();
    }
  });

  // 首次渲染
  render();
}

init();
