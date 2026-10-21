# 更新日志

本项目从零代码起步，由 AI 编码助手在真实需求驱动下逐轮生成（详见 [NOTICE](NOTICE)）。
版本号与 `package.json` 保持一致；每条记录对应一次可运行的状态。

## [Unreleased]

## [1.11.0] - 2026-10-21

首个公开测试版（GitHub Pre-release）。

### 新增

- **免安装打包**：`npm run dist` 生成 `OrdisOverlay-x.y.z-win.zip`（约 135 MB），内含 Electron 运行时、
  离线装备库、四张遗物数据表，解压即用；附带 `启动 Ordis Overlay.vbs`（自动带 `--no-sandbox`）
  与 `请先看这里.txt`。
- **仓库整理**：按 `src/` `scripts/` `data/` `tools/` `vendor/` `docs/` 重新归类；
  补充 `README` `LICENSE(MIT)` `NOTICE` `.gitignore` `config.example.json`。
- **工程脚本**：`npm run setup`（一键装可选依赖）、`npm run doctor`（14 项环境体检）。

### 变更

- MCP 子进程的 `ELECTRON_RUN_AS_NODE` 判断从「exe 名字是否含 electron」改为
  「是否用 `process.execPath` 启动」，修复打包后工具全部失联（`MCP error -32000: Connection closed`）。
- `main.js` 在进程内补 `no-sandbox` 开关，缓解部分机器双击即退出的问题。

### 说明

- 免安装包**不含** `warframe-inv.exe`（第三方二进制），因此库存 / 白金 / 紫卡类提问会明确提示
  「无法读取本地库存」；查价、掉落、世界状态、开核桃秒选、wiki 均不受影响。
- 未做代码签名，Windows SmartScreen 会提示「未知发布者」。

## 版本摘要（1.0 → 1.11）

| 版本 | 里程碑 |
|---|---|
| 1.0 | 悬浮窗 + Express + DeepSeek 对话打通 |
| 1.1 | 灰机中文 wiki 接入（隐藏窗口过 Cloudflare + 本地 3001 桥接） |
| 1.2 | 视觉改为 Tenno 磨砂面板；收起态换 3D 全息飞船 |
| 1.3 | 截图粘贴识别、Markdown 渲染与代码块一键复制 |
| 1.4 | 设置面板支持三项凭据（DeepSeek Key / AlecaFrame userHash / publicToken），保存即热重连 |
| 1.5 | 树状二级菜单与面板内视图（数据更新 / API 凭据） |
| 1.6 | 世界状态多源：DE 官方 + tenno.tools 并行，6 小时快照兜底 |
| 1.7 | 工具清理：下线 8 个失效工具，修昼夜/倒计时算法，工具数收敛到 26 |
| 1.8 | 遗物全量本地化 + 极速查表 + 防钓鱼价格；遗物模式常驻锁定；标题栏可拖动 |
| 1.9 | 遗物奖励库（drop.wf.wiki，799 遗物 / 4795 条奖励），新增 `relic_drops` 工具 |
| 1.10 | 杜卡德按稀有度估算；掉落常识写入 System Prompt；修复标题栏拖动 |
| 1.11 | 数据驱动改造（强制先查库存与世界状态）、结果缓存、开核桃中英对照、仓库整理与打包 |
