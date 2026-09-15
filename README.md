# 上游余额雷达

React + Node/Express Web 控制台和 Tauri 桌面端，用于渠道余额、三级邮件预警、模型和文本/生图测试。

- Web：首次注册唯一管理员，随后关闭注册；支持登录、退出、修改密码。
- 桌面：内置本机服务，启动即用；数据保存在本机，可选与自己的服务器同步。
- 同步：双向合并渠道和预警设置，检测同项编辑/删除冲突；邮箱凭据单独勾选同步。
- 后台：服务进程定时探测，网页关闭后继续工作；余额达到或低于 10/6/1 等独立配置阈值时逐级提醒，同级只发一次，充值回到一级线以上重新布防。
- 本机工具：会话管理、渠道导入、Codex 增强只在本机模式提供，服务器不操作本机 Codex 数据。

## 开发与测试

需要 Node.js >= 24.15 和 pnpm。项目目录为 `E:\upstream-balance-tauri`。

```powershell
pnpm install --frozen-lockfile
pnpm test
pnpm build
pnpm local
```

本机 Web 地址为 `http://127.0.0.1:8789`，首次初始化码位于 `%LOCALAPPDATA%\BalanceRadar\data\access-token`。

```powershell
pnpm desktop:build
```

安装包输出到 `src-tauri/target/release/bundle/nsis/`。

`node scripts/verify-release.mjs` 会启动隔离的本地服务器、桌面后端、上游接口和 SMTP 接收端，验证真实 HTTP/SMTP 流程。可通过 `RADAR_PLAYWRIGHT_MODULE` 指定已安装的 Playwright 模块路径，启用 Chrome 浏览器验收。测试不发送外部邮件，也不调用付费上游。验收产物位于 `artifacts/release-check-*`。

服务器部署、数据备份、同步及故障处理见 [WEB_DEPLOY.md](WEB_DEPLOY.md)。

## License

余额雷达的原创代码采用 [MIT License](LICENSE) 发布。

仓库内的 `server/vendor/codex-plus-plus/renderer-inject.js` 是基于
[CodexPlusPlus](https://github.com/BigPizzaV3/CodexPlusPlus) 引入并适配的第三方组件，
该组件继续采用 GNU Affero General Public License v3.0（AGPL-3.0），不属于本项目的 MIT
授权范围。对应许可证文本和来源说明见
[`server/vendor/codex-plus-plus/`](server/vendor/codex-plus-plus/)。

项目依赖、第三方代码、图标和其他外部资源仍分别受其各自许可证约束；使用或再发布时请保留相应版权和许可证声明。
