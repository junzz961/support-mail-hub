# Support Mail Hub

一个独立的 Cloudflare Email Worker，用来统一接收并回复同一 Cloudflare 账号下多个项目的支持邮箱。

## 它做什么

- 将每封入站邮件（含附件）完整转发到已验证的个人邮箱。
- 在 D1 中保存最近 90 天的纯文本正文、附件名称和标准邮件线程信息。
- 在一个由 Cloudflare Access 保护的中文网页中查看会话。
- 从原来收到邮件的支持地址进行纯文本线程回复。
- 通过网页设置页维护项目名、支持邮箱、发件显示名和转发目标。

它不保存附件或原始 MIME，不渲染外部 HTML，也不提供主动写新邮件、工单状态、多人协作、自动回执或 Cloudflare 路由自动化。

## 架构

```text
客户 -> Cloudflare Email Routing -> Email Worker
                                  |-> 完整原件转发到个人邮箱
                                  `-> 文本与线程元数据写入 D1

管理员 -> Cloudflare Access -> workers.dev 网页 -> D1 / Email Sending
```

HTTP 页面和 API 会同时校验 Cloudflare Access JWT 和唯一管理员邮箱。没有完整 Access 配置时，Worker 会保持拒绝访问；Email Routing 的 `email()` 入口不受 HTTP 登录影响。

## 前置条件

- Node.js 22.12 或更新版本。
- 所有支持邮箱域名位于同一个 Cloudflare 账号。
- Cloudflare Workers Paid：向任意客户邮箱发送回复需要 Email Sending。
- 每个域名均已在 **Email Service > Email Routing** 和 **Email Sending** 中完成接入。
- 每个完整转发目标均已在 Email Routing 中验证。

## 首次部署

### 1. 安装并创建 D1

```bash
npm install
npx wrangler login
npx wrangler d1 create support-mail-hub
```

将命令返回的 `database_id` 写入 `wrangler.jsonc`，替换全零占位值，然后执行：

```bash
npm run d1:migrate:remote
npm run deploy
```

首次部署可以在 Access 配置前进行，因为缺少 Access secrets 时 HTTP 入口默认拒绝访问。

### 2. 保护 workers.dev

在 Cloudflare Dashboard 中打开：

1. **Workers & Pages > support-mail-hub > Settings > Domains & Routes**。
2. 在 `workers.dev` 路由上选择 **Enable Cloudflare Access**。
3. Access policy 只允许你的完整邮箱地址，不要使用整个邮箱域名作为许可范围。
4. 从 Access 应用中取得 Team Domain 和 Application Audience (`aud`)。

写入三个 Worker secrets：

```bash
npx wrangler secret put ACCESS_TEAM_DOMAIN
npx wrangler secret put ACCESS_AUD
npx wrangler secret put ADMIN_EMAIL
```

`ACCESS_TEAM_DOMAIN` 的格式为 `https://your-team.cloudflareaccess.com`，`ADMIN_EMAIL` 必须与 Access JWT 中的登录邮箱完全对应（比较时忽略大小写）。不要提交 `.dev.vars`。

### 3. 添加第一个邮箱

登录 Hub 的“邮箱设置”页面，先添加一个测试别名映射，例如：

- 项目名称，例如 `TransCast`
- 支持邮箱，例如 `support-test@transcast.video`
- 发件显示名，例如 `TransCast Support`
- 已验证的个人邮箱转发目标

设置页只维护 Hub 自己的映射，不会修改 Cloudflare 账号配置。测试通过后，再添加正式的 `support@transcast.video` 映射。

### 4. 配置并验证路由

先使用临时别名进行真实测试：

1. 在 **Email Routing > Routing Rules** 新建与 Hub 测试映射完全相同的 `support-test@你的域名`。
2. Action 选择 **Send to a Worker**，Worker 选择 `support-mail-hub`。
3. 从账号外的邮箱发送一封带正文和附件的测试邮件。
4. 确认个人邮箱收到完整原件，Hub 中出现文本会话和附件名称。
5. 从 Hub 回复，确认客户看到正确的 From 地址，并且回复保持在原邮件线程中。
6. 再验证一次客户回信能够归入同一 Hub 会话。

验证完成后，移除临时路由并归档测试映射，再把正式 `support@` 路由从直接转发切换为该 Worker。其他项目逐个重复，不要一次切换全部域名。

## 新增其他项目

1. 在 Cloudflare 中接入该域名的 Routing 和 Sending。
2. 验证个人邮箱转发目标。
3. 在 Hub 设置页添加邮箱映射。
4. 创建指向 `support-mail-hub` 的 Email Routing 规则。
5. 用测试别名完成完整收发验证后再切换正式地址。

归档邮箱前应先移除对应 Routing rule。如果归档后仍有邮件到达，Worker 会只尝试完整转发并写入警告日志，不会创建可回复的在线会话。

## 开发与验证

```bash
npm test
npm run check
npm run build
```

- 测试使用内存 SQLite 验证 D1 schema、去重、线程归并、90 天清理和回复幂等。
- `npm run build` 同时检查 Worker/Web 类型、生成网页产物，并执行 Wrangler dry-run。
- `npm run d1:migrate:local` 可验证 migration 能被本地 Wrangler 应用。

本项目没有不安全的本地登录绕过。网页联调应使用受 Access 保护的预览或正式 Worker；Email handler 的逻辑通过测试以及 Wrangler 的 `/cdn-cgi/handler/email` 模拟入口验证。

## 数据和失败处理

- 入站正文最多保存 100 KB；超出部分会在界面标记截断。
- 附件只保存名称和 MIME 类型，附件内容只存在于完整转发的个人邮箱中。
- 邮件通过 `Message-ID` 去重；缺失时使用原始邮件 SHA-256。
- 线程只依据 `In-Reply-To` / `References` 合并，不按主题猜测。
- 转发成功但 D1 失败时，个人邮箱副本仍是权威记录。
- D1 成功但转发失败时，Hub 会保留会话并显示失败状态。
- 两条路径都失败时，Worker 拒收邮件，避免静默丢信。
- 发送请求使用客户端 UUID 幂等；状态不明确时不会自动重发。
- Cron 每天删除超过 `RETENTION_DAYS`（默认 90）的消息和空会话。

## 回滚

如果正式路由出现异常，在 Cloudflare Email Routing 中将该支持地址的 Action 改回原来的已验证个人邮箱。Hub 不修改 Routing rule，因此回滚不依赖代码部署。
