// =============================================================
// 豆包浏览器 - 白名单小助手 | Background Service Worker
// =============================================================

const STORAGE_KEYS = {
  domains: "whitelistDomains",
  enabled: "enabled",
  closeTab: "closeTabAfterRedirect",
  lastBlocked: "lastBlocked",
  themeMode: "themeMode",
};

const DEFAULT_DOMAINS = [
  "doubao.com",
  "chatgpt.com",
  "claude.ai",
  "m365.cloud.microsoft",
  "gemini.google.com",
  "live.com",
];

// ---------------------------------------------------------
// 常量配置
// ---------------------------------------------------------
const REDIRECT_GUARD_MS = 5000;
const CLOSE_DELAY_MS = 1500;
const CLOSE_FAST_MS = 300;
const MAX_BLOCKED_RECORDS = 5;
const REDIRECT_MAP_CLEANUP_INTERVAL = 60_000; // 1 min
const REDIRECT_MAP_MAX_SIZE = 200;

// 忽略的协议前缀
const IGNORED_PROTOCOLS = [
  "chrome:",
  "chrome-extension:",
  "edge:",
  "about:",
  "file:",
  "data:",
  "blob:",
  "javascript:",
  "microsoft-edge:",
  "devtools:",
  "view-source:",
];

// ---------------------------------------------------------
// 状态追踪
// ---------------------------------------------------------
const redirectedAt = new Map();
const closeTimers = new Map();

// 本地缓存
let cached = {
  domains: DEFAULT_DOMAINS.slice(),
  enabled: true,
  closeTabAfterRedirect: false,
};

// 缓存就绪标记 — Service Worker 每次唤醒时都要重新加载
let cacheReadyResolve;
let cacheReady = new Promise((r) => {
  cacheReadyResolve = r;
});

// lastBlocked 写入锁，防止并发竞态
let blockListLock = Promise.resolve();

// ---------------------------------------------------------
// 核心逻辑
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

function isAllowedHost(hostname, domains) {
  const host = String(hostname ?? "").toLowerCase();
  if (!host) return false;
  for (const raw of domains) {
    const d = normalizeDomain(raw);
    if (!d) continue;
    if (host === d || host.endsWith("." + d)) return true;
  }
  return false;
}

function shouldHandleUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function isIgnoredUrl(urlStr) {
  if (!urlStr) return true;
  const lower = urlStr.toLowerCase();
  return IGNORED_PROTOCOLS.some((p) => lower.startsWith(p));
}

function tabRecentlyRedirected(tabId) {
  const t = redirectedAt.get(tabId);
  if (!t) return false;
  if (Date.now() - t > REDIRECT_GUARD_MS) {
    redirectedAt.delete(tabId);
    return false;
  }
  return true;
}

// ---------------------------------------------------------
// 周期清理 redirectedAt，防止内存泄漏
// ---------------------------------------------------------
function cleanupRedirectedMap() {
  const now = Date.now();
  for (const [tabId, ts] of redirectedAt) {
    if (now - ts > REDIRECT_GUARD_MS) {
      redirectedAt.delete(tabId);
    }
  }
  // 安全上限
  if (redirectedAt.size > REDIRECT_MAP_MAX_SIZE) {
    const entries = [...redirectedAt.entries()].sort((a, b) => a[1] - b[1]);
    const toRemove = entries.slice(0, entries.length - REDIRECT_MAP_MAX_SIZE);
    for (const [key] of toRemove) redirectedAt.delete(key);
  }
}

setInterval(cleanupRedirectedMap, REDIRECT_MAP_CLEANUP_INTERVAL);

// ---------------------------------------------------------
// 关标签逻辑
// ---------------------------------------------------------

function scheduleClose(tabId, delay) {
  clearScheduledClose(tabId);
  const t = setTimeout(() => {
    chrome.tabs.remove(tabId).catch(() => {});
    closeTimers.delete(tabId);
  }, delay);
  closeTimers.set(tabId, t);
}

function clearScheduledClose(tabId) {
  const t = closeTimers.get(tabId);
  if (!t) return;
  clearTimeout(t);
  closeTimers.delete(tabId);
}

// ---------------------------------------------------------
// 初始化与缓存
// ---------------------------------------------------------

async function ensureDefaults() {
  const current = await chrome.storage.local.get([
    STORAGE_KEYS.domains,
    STORAGE_KEYS.enabled,
    STORAGE_KEYS.closeTab,
    STORAGE_KEYS.lastBlocked,
    STORAGE_KEYS.themeMode,
  ]);

  const next = {};
  if (!Array.isArray(current[STORAGE_KEYS.domains]))
    next[STORAGE_KEYS.domains] = DEFAULT_DOMAINS.slice();
  if (typeof current[STORAGE_KEYS.enabled] !== "boolean")
    next[STORAGE_KEYS.enabled] = true;
  if (typeof current[STORAGE_KEYS.closeTab] !== "boolean")
    next[STORAGE_KEYS.closeTab] = false;
  if (!Array.isArray(current[STORAGE_KEYS.lastBlocked]))
    next[STORAGE_KEYS.lastBlocked] = [];
  if (typeof current[STORAGE_KEYS.themeMode] !== "string")
    next[STORAGE_KEYS.themeMode] = "system";

  if (Object.keys(next).length) await chrome.storage.local.set(next);
}

async function loadCache() {
  const data = await chrome.storage.local.get([
    STORAGE_KEYS.domains,
    STORAGE_KEYS.enabled,
    STORAGE_KEYS.closeTab,
  ]);
  cached = {
    domains: Array.isArray(data[STORAGE_KEYS.domains])
      ? data[STORAGE_KEYS.domains]
      : DEFAULT_DOMAINS.slice(),
    enabled:
      typeof data[STORAGE_KEYS.enabled] === "boolean"
        ? data[STORAGE_KEYS.enabled]
        : true,
    closeTabAfterRedirect:
      typeof data[STORAGE_KEYS.closeTab] === "boolean"
        ? data[STORAGE_KEYS.closeTab]
        : false,
  };
  // 标记缓存就绪
  if (cacheReadyResolve) {
    cacheReadyResolve();
    cacheReadyResolve = null;
  }
}

// ---------------------------------------------------------
// 拦截与重定向
// ---------------------------------------------------------

async function openInEdge(tabId, url) {
  try {
    redirectedAt.set(tabId, Date.now());
    await chrome.tabs.update(tabId, { url: "microsoft-edge:" + url });
    if (cached.closeTabAfterRedirect) scheduleClose(tabId, CLOSE_DELAY_MS);
  } catch (err) {
    console.warn("[Whitelist] Failed to redirect tab", tabId, err);
    redirectedAt.delete(tabId);
  }
}

/**
 * 使用锁机制串行写入 lastBlocked，防止并发覆盖
 */
async function recordBlocked(url, hostname) {
  blockListLock = blockListLock.then(async () => {
    try {
      const data = await chrome.storage.local.get(STORAGE_KEYS.lastBlocked);
      let list = Array.isArray(data[STORAGE_KEYS.lastBlocked])
        ? data[STORAGE_KEYS.lastBlocked]
        : [];

      const newItem = { url, host: hostname, at: Date.now() };

      // 去重
      list = list.filter((item) => item.url !== url);
      list.unshift(newItem);
      if (list.length > MAX_BLOCKED_RECORDS)
        list = list.slice(0, MAX_BLOCKED_RECORDS);

      await chrome.storage.local.set({
        [STORAGE_KEYS.lastBlocked]: list,
      });
    } catch (err) {
      console.warn("[Whitelist] Failed to record blocked URL", err);
    }
  });
  return blockListLock;
}

async function handleNavigation(tabId, url) {
  // 等待缓存就绪，确保 SW 唤醒后使用最新白名单
  await cacheReady;

  if (!cached.enabled) return;
  if (isIgnoredUrl(url)) return;
  if (!shouldHandleUrl(url)) return;
  if (tabRecentlyRedirected(tabId)) return;

  let u;
  try {
    u = new URL(url);
  } catch {
    return;
  }

  if (isAllowedHost(u.hostname, cached.domains)) return;

  // 并行：记录拦截 + 执行重定向
  await Promise.all([recordBlocked(url, u.hostname), openInEdge(tabId, url)]);
}

// ---------------------------------------------------------
// 注册监听器
// ---------------------------------------------------------

// ★ 关键修复：每次 Service Worker 脚本被唤醒时，立即加载缓存。
// onInstalled / onStartup 不会在 SW 从 idle 唤醒时触发，
// 所以必须在顶层无条件调用 loadCache()。
ensureDefaults().then(loadCache);

chrome.runtime.onInstalled.addListener(() => {
  console.log("[Whitelist] Extension installed");
  // ensureDefaults + loadCache 已在顶层执行，此处仅做日志
});

chrome.runtime.onStartup.addListener(() => {
  // 顶层已做加载，但 onStartup 可能在顶层 loadCache 完成之前触发
  // 再次调用以确保最新
  ensureDefaults().then(loadCache);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (
    STORAGE_KEYS.domains in changes ||
    STORAGE_KEYS.enabled in changes ||
    STORAGE_KEYS.closeTab in changes
  ) {
    loadCache();
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  redirectedAt.delete(tabId);
  clearScheduledClose(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;

  // 检测到 Edge 协议，快速关闭
  if (cached.closeTabAfterRedirect && redirectedAt.has(tabId)) {
    try {
      if (changeInfo.url.startsWith("microsoft-edge:")) {
        scheduleClose(tabId, CLOSE_FAST_MS);
      }
    } catch {
      /* noop */
    }
  }

  handleNavigation(tabId, changeInfo.url);
});
