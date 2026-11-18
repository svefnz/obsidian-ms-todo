# Microsoft To Do 同步（Obsidian 插件）

将 Obsidian 笔记与 Microsoft To Do 通过 Microsoft Graph API 双向同步。

## 功能

- **Microsoft 账号登录** —— OAuth 2.0 授权码 + PKCE 流程，令牌自动续期
- **导入清单为笔记** —— 一个清单生成一篇笔记，任务渲染为 Markdown 复选框（`- [ ]`），含截止日期（📅）与备注（💭）
- **映射任意笔记到清单** —— 让已有笔记与某个 To Do 清单同步
- **自动推送新任务** —— 在映射笔记中输入新的 `- [ ]` 任务行，自动在 To Do 中创建
- **同步全部已映射清单** —— 完成状态、标题、截止日期、备注从 To Do 同步到笔记，新任务自动追加
- **定时自动同步** —— 可在设置中配置间隔

## 配置

1. 打开 [Azure 门户 → 应用注册](https://portal.azure.com/#blade/Microsoft_Azure_RegisteredApps/ApplicationsListBlade) 新建应用：
   - 受支持的账户类型：个人 Microsoft 账户和/或工作/学校账户
   - 不需要客户端密钥（公共客户端）
   - 在「身份验证」中添加 **移动和桌面应用程序** 平台，重定向 URI 填 `http://localhost:42813/ms-todo-auth`
   - 添加委托权限：`Tasks.ReadWrite`、`offline_access`、`User.Read`
2. 复制 **应用程序(客户端) ID** 填入插件设置
3. 执行命令 **「登录 Microsoft To Do」**，在浏览器中完成登录
4. 执行 **「导入 To Do 清单为笔记」** 或 **「将当前笔记映射到 To Do 清单」**

## 命令

| 命令 | 说明 |
|---|---|
| 登录 Microsoft To Do | OAuth 登录 |
| 同步全部已映射清单 | 拉取 To Do 变更到笔记，推送笔记中的新任务 |
| 导入 To Do 清单为笔记 | 由清单创建笔记并建立映射 |
| 将当前笔记映射到 To Do 清单 | 将当前笔记关联到某个清单 |

## 同步匹配规则

- 以块引用 `^ms-todo-<任务ID>` 结尾的行按 ID 精确匹配
- 未匹配的笔记行按标题匹配；笔记中缺失的任务会自动追加
- 在笔记中勾选/取消勾选后执行同步，状态会推送到 To Do

## 开发

```sh
npm install
npm run build        # 生产构建 -> main.js
npm run test         # 逻辑自检
npm run typecheck    # 类型检查
```

将 `main.js`、`manifest.json` 复制到测试仓库的 `.obsidian/plugins/ms-todo-sync/` 目录即可试用。

## 安装（BRAT）

1. 安装并启用 BRAT 插件
2. 命令面板执行 **BRAT: Add a beta plugin for testing**
3. 输入 `svefnz/obsidian-ms-todo`
4. 在第三方插件中启用 **Microsoft To Do 同步**

## 常见错误

| 现象 | 原因 | 解法 |
| --- | --- | --- |
| 浏览器出现 `unauthorized_client: The client does not exist or is not enabled for consumers` | 应用注册的「支持的账户类型」不含个人账户，而插件默认用 `common` 登录 | Azure 应用 → 身份验证 → 账户类型改为「任何组织目录中的账户和个人 Microsoft 账户」；或把插件设置里「租户」改为 `consumers`（仅个人账号）/ 你的租户 ID |
| `AADSTS50011 redirect_uri mismatch` | Azure 没登记本插件的回环重定向 URI | Azure 应用 → 身份验证 → 添加平台「移动和桌面应用程序」→ 重定向 URI 填 `http://localhost:42813/ms-todo-auth` |
| `本地端口 42813 已被占用` | 上一次登录窗口没关，回调服务仍在等 | 关掉浏览器标签稍等，或重启 Obsidian 再登录 |
