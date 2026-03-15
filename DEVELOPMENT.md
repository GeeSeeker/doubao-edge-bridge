# 豆包浏览器-白名单小助手 (Whitelist Assistant) 开发文档

## 1. 项目概述

这是一个基于 Chrome Extension Manifest V3 的浏览器扩展，旨在帮助用户管理一个域名白名单。

- **主要功能**：当用户访问**不在白名单**中的域名时，自动将该页面重定向到 `microsoft-edge:` 协议（即尝试用 Edge 浏览器打开该链接），并根据设置决定是否关闭当前标签页。
- **辅助功能**：白名单增删改查、最近拦截记录、备份管理（导入/导出/对比）、主题切换等。

## 2. 技术栈

- **核心**：Manifest V3
- **前端**：原生 HTML, CSS (Flexbox), JavaScript (Vanilla)
- **存储**：`chrome.storage.local`

## 3. 目录结构

```
whitelist-edge-extension/
├── manifest.json      # 扩展配置文件
├── background.js      # 后台服务 Worker (拦截逻辑)
├── popup.html         # 弹出面板结构
├── popup.css          # 弹出面板样式
├── popup.js           # 弹出面板逻辑
└── DEVELOPMENT.md     # 开发文档 (本文档)
```

## 4. 核心功能规范

### 4.1. 拦截与重定向 (Background Service)

- **监听事件**：`chrome.tabs.onUpdated`
- **逻辑**：
  1. 检查插件是否启用 (`enabled`).
  2. 检查 URL 是否为 HTTP/HTTPS.
  3. 检查 URL 是否在白名单 (`whitelistDomains`) 中.
  4. **如果不在白名单**：
     - 记录该拦截到 `lastBlocked` (保留最近 5 条，去重，FIFO).
     - 更新当前 Tab URL 为 `microsoft-edge:<原始URL>`.
     - 如果开启了 `closeTabAfterRedirect`，则延时关闭该 Tab.
- **默认白名单**：
  - `doubao.com`
  - `chatgpt.com`
  - `claude.ai`
  - `m365.cloud.microsoft`
  - `gemini.google.com`

### 4.2. 弹出面板 (Popup UI)

面板尺寸建议：宽 360px，高自适应 (min-height 480px)。
采用 **三标签页 (Tabs)** 布局：

#### Tab 1: 白名单 (Whitelist)

- **顶部**：添加域名输入框 + “添加”按钮。
- **列表区域**：
  - 搜索框：支持实时过滤域名。
  - 域名列表：
    - **高度限制**：固定显示约 4 个条目 (max-height: ~232px)。
    - **滚动**：列表内部垂直滚动。
    - **操作**：每行支持“编辑”和“移除”。
    - **编辑模式**：点击编辑后，文本变为输入框，右侧变为“保存/取消”。

#### Tab 2: 高级 (Advanced)

- **模块 1：最近拦截 (Last Blocked)**
  - 显示最近 5 条拦截记录。
  - **样式**：列表高度固定 (max-height: ~120px)，内部滚动。
  - **操作**：每条记录右侧有 📋 (复制) 图标按钮。
- **模块 2：备份管理 (Backups)**
  - **限制**：最多存储 **3 个** 备份。
  - **创建备份**：
    - 输入框 (可选自定义名称) + “创建”按钮。
    - 默认名称格式：`YYYY-MM-DD HH:mm (N个)`.
    - **溢出处理**：如果已满 3 个，弹出提示框，要求用户选择“下载并删除最早备份”或“直接删除最早备份”后才能继续创建。
  - **备份列表**：
    - 按“是否收藏(星标)”置顶，然后按时间倒序排列。
    - **列表高度**：自适应剩余空间 (flex: 1)，内部滚动。
    - **展示项**：
      - 第一行：[星标] 备份名称 (Tooltip显示详情) | [恢复] [对比] [更多/收起]
      - 第二行 (展开后)：[导出] [内容] [改名] [删除]
  - **功能细节**：
    - **恢复**：覆盖当前白名单 (需二次确认)。
    - **对比**：弹出层显示当前白名单与备份的差异 (缺失/新增)。
    - **导出**：下载 `.txt` 文件。
    - **内容**：弹出层显示纯文本编辑框，可直接修改备份内容。

#### Tab 3: 设置 (Settings)

- **通用设置**：
  - 自动关闭标签 (Switch)。
  - 主题模式 (Select: 跟随系统/浅色/深色)。
- **危险区域 (底部固定)**：
  - 恢复默认设置 (Reset)。
  - **交互**：点击一次变“确定要恢复吗？”，3秒内再次点击执行重置，否则复原。

### 4.3. 数据存储 (Storage Schema)

| Key                     | Type       | Description                               |
| ----------------------- | ---------- | ----------------------------------------- |
| `whitelistDomains`      | `string[]` | 域名白名单列表 (已归一化)                 |
| `enabled`               | `boolean`  | 插件总开关                                |
| `closeTabAfterRedirect` | `boolean`  | 重定向后是否关闭标签                      |
| `themeMode`             | `string`   | 'system' / 'light' / 'dark'               |
| `lastBlocked`           | `object[]` | `[{ url, host, at }]` (Max 5)             |
| `whitelistBackups`      | `object[]` | `[{ id, ts, name, domains, isFavorite }]` |

## 5. 样式规范 (CSS)

- **布局**：Flexbox (Column) 为主。
- **滚动**：
  - 页面整体 (`body`, `.tab-content`) **禁止滚动** (`overflow: hidden`).
  - 各个列表容器 (`.list`) **开启内部滚动** (`overflow-y: auto`).
- **主题**：使用 CSS Variables (`--bg`, `--text`, `--border` 等) 适配深色模式。
- **细节**：
  - 搜索框与标题中轴对齐。
  - 底部无多余白边。
  - 弹窗 (Overlay) 覆盖整个面板。
