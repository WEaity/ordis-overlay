# tools/ — 随项目携带的 MCP 服务

悬浮窗启动时由 `src/lib/config.js` 从这里拉起两个 MCP 子进程。
删掉整个 `tools/`，悬浮窗还能当纯聊天用，但查不了价格、掉落和库存。

```
tools/
├─ config.json                 AlecaFrame 凭据（userHash + publicToken），不入库
├─ warframe-inv.exe            wf_inv：读 AlecaFrame 本地缓存，11 个工具，不入库
├─ wf-mcp-lite/
│  ├─ server.mjs               wf_market：离线库 + market v2 + 世界状态 + 遗物奖励，15 个工具
│  └─ data/market-items.json   market 物品清单缓存（12 小时，自动重建）
├─ worldstate/                 DE 世界状态解析器（node_modules 需自行 npm install）
└─ warframe-mcp/
   └─ node_modules/
      └─ warframe-items/       离线数据包（约 1.5 万条，80 MB，不入库）
```

## 各部分的缺省影响

| 路径 | 作用 | 没有它会怎样 |
|---|---|---|
| `warframe-inv.exe` + `config.json` | 读 `%LOCALAPPDATA%\AlecaFrame\lastData.dat`：库存、白金、遗物、紫卡、声望 | 库存类问题回「无法读取本地库存」 |
| `wf-mcp-lite/server.mjs` | 属性、掉落、市场价、世界状态、遗物奖励、wiki | 只剩纯聊天 |
| `worldstate/` | 解析 DE `worldState.php` | `world_state` 只能走备用源（缺魔胎之境） |
| `warframe-mcp/node_modules/warframe-items` | 离线装备库 | 属性查不到，启动报 `Cannot find module 'warframe-items'` |

## 灰机中文 wiki 是怎么接进来的

`warframe.huijiwiki.com` 有 Cloudflare 人机校验，直接 `fetch` 一律 403。
桥接不在 `tools/` 里，而在悬浮窗进程（`src/main.js`）：

1. 启动 4 秒后开一个隐藏窗口（`persist:huiji` 会话）打开首页，正常过一次校验（约 7 秒）
2. 之后在这个窗口里发同源 `fetch`（MediaWiki `api.php`）即可带 Cookie 正常返回
3. 暴露成本地接口 `http://127.0.0.1:3001`：
   - `GET /health` → `{ ok, ready }`
   - `GET /search?q=xxx&limit=5` → `{ ok, results:[{title,snippet,size}] }`
   - `GET /page?title=xxx` → `{ ok, page:{title,text} }`
   - `GET /raw?title=xxx` → 单条 wikitext（`action=parse&prop=wikitext`）
   - `GET /pages?titles=a|b|c` → 批量 wikitext（最多 50 条，`action=query`）
4. `search_wiki` 调这个桥接拿正文；桥接不可用（悬浮窗没开）时回退本地离线库

## 遗物数据的四层来源

| 层 | 来源 | 产物 | 脚本 |
|---|---|---|---|
| 奖励清单 | drop.wf.wiki `relicRewards.json` | `data/relic_rewards.json`（799 遗物 / 4795 奖励） | `scripts/update_relic_rewards.js` |
| 部件与杜卡德 | 离线 `warframe-items` + 上面奖励库补全新 Prime | `data/all_relics.json`（612 条） | `scripts/update_relic_parts.js` |
| 中文名 | 灰机 wiki `Data:DictCY.tabx` + `<物品>/Prime` 页 + 搜索 | `data/relic_zh.json`（655 条） | `scripts/build_zh_map.js`、`fill_zh_search.js` |
| 白金价 | `warframe.market` v2 订单接口 | `data/relic_prices.json`（597 条有价） | `scripts/update_relic_prices.js` |

**注意**

- `server.mjs` 用 `TOOLS_DIR = <仓库>/tools` 定位离线库，**目录层级不能改**
- `config.json` 里是 AlecaFrame 的 publicToken，等同账号凭据，不要发给别人
- 抓取按需触发、不批量爬；wiki 桥接跟着悬浮窗生命周期走
- 连上了没：悬浮窗打开时访问 <http://127.0.0.1:3000/api/mcp>
