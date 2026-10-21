# -*- coding: utf-8 -*-
"""生成项目功能结构思维导图（PNG，自适应宽度）。"""
from PIL import Image, ImageDraw, ImageFont

BG = (12, 16, 22)
ROOT_BG = (28, 44, 62)
BR_BG = (22, 34, 48)
CH_BG = (18, 27, 38)
TXT = (238, 244, 250)
DIM = (170, 184, 198)
ACCENT = (120, 200, 255)
LINE = (86, 118, 148)

F_ROUND = "O:\\Windows\\Fonts\\msyh.ttc"
F_BOLD = "O:\\Windows\\Fonts\\msyhbd.ttc"

DATA = [
    ("交互层 · Electron 悬浮窗", [
        "收起态：90px 全息晶体（13 帧动图 WebP / 浮动·呼吸 / 无边框无底色）",
        "展开：单击图标 0.22s 缩放淡入 / 鼠标离开 1 秒收起",
        "遗物模式：点礼盒按钮锁定不收起，粘贴奖励图自动识别",
        "窗口操作：拖图标或标题栏 / 面板把手缩放 / 图标等比 80–150",
        "左右自适应：图标在右半屏面板向左开，反之向右并镜像",
        "输入：文本 / Ctrl+V 截图（压缩+预览）/ 发送 / Ctrl+Shift+Q",
        "菜单：右上菜单按钮，二级项（数据更新 / 凭据）+ 面板内视图",
        "渲染：Markdown（表格 / ◆ 列表）/ 代码块一键复制密语",
    ]),
    ("服务层 · Express", [
        "/api/chat 流式 SSE（打字机效果，失败回退非流式）",
        "/api/settings 三项凭据读写，保存后热重连库存服务",
        "/api/relic-pick 开核桃秒选（截图 → 本地查表 → 推荐）",
        "/api/relic/status · /api/update-relics · /api/update-prices",
        "/api/history/clear 清空上下文",
        "/api/mcp 自检页（工具数 / 凭据状态 / wiki）",
        "安全红线：RMT 关键词服务端硬拦截，不调模型",
    ]),
    ("Agent 层 · Ordis", [
        "人设：Cephalon Ordis（Operator 称呼 / 故障口癖）",
        "强制工作流：问推荐先查库存+世界状态，读不到只说明",
        "上下文：最近 8 轮，图片只保留最近 2 轮",
        "工具循环：最多 6 轮，按意图从 26 个工具里裁剪",
        "结果缓存：库存 45s / 精通 300s / 配卡 30s",
        "流式输出：SSE 增量渲染，失败可回退非流式",
    ]),
    ("工具层 · MCP（26 个）", [
        "wf_market（自研 15 个）：属性 / 掉落 / 市场价 / 刷取建议",
        "relic_drops：遗物四档概率 / 按部件反查出现在哪些遗物",
        "世界状态：昼夜 / 裂缝 / 突击 / 虚空商人 / 入侵 / 警报",
        "wiki：灰机中文正文（隐藏窗口过 Cloudflare 桥接）",
        "建议类：beginner_guide / daily_picks（有库存优先用库存）",
        "wf_inv（AlecaFrame 11 个）：库存 / 遗物 / 紫卡 / 配卡 / 声望",
        "失败即标注：库存不可读、数据源不可达，不编造",
    ]),
    ("数据源与管道", [
        "warframe.market v2：实时买卖单（物品清单 12h 缓存 + 预热）",
        "DE worldState + tenno.tools：世界状态（60s + 6h 快照兜底）",
        "灰机 wiki：中文词条正文（本地 3001 桥接）",
        "AlecaFrame：本机 lastData.dat（库存 / 紫卡 / 配卡）",
        "warframe-items：离线 1.5 万条装备 / Mod / 掉落",
        "drop.wf.wiki：遗物奖励库（799 遗物 / 4795 奖励）",
        "遗物价目：部件 612（中文 605）+ 价格 597 + 对照 655",
    ]),
    ("工程 · 运维 · 合规", [
        "启动器：start-overlay.vbs / .bat，单实例，自动拉起后端",
        "退出清理：结束 server.js 与 MCP 子进程，不留孤儿",
        "日志：debug.log（窗口/动画）· server.log（接口/工具）",
        "文档：使用说明 / 项目说明书 / 功能结构 / tools 说明",
        "合规：只读查询、不注入游戏、不做自动化、不批量抓取",
        "口径：全部为国际服 PC 数据，断源只标注不估算",
    ]),
]

f_root = ImageFont.truetype(F_BOLD, 34)
f_br = ImageFont.truetype(F_BOLD, 25)
f_ch = ImageFont.truetype(F_ROUND, 19)
f_sub = ImageFont.truetype(F_ROUND, 17)

probe = ImageDraw.Draw(Image.new("RGB", (10, 10)))

CH_H = 42
GAP_BRANCH = 30
ROOT_W, ROOT_H = 360, 116
X_ROOT, X_BR, X_CH = 60, 500, 900

# 自适应：子项框宽按文字长度算
max_ch_w = 0
for _, children in DATA:
    for ch in children:
        w = probe.textlength(ch, font=f_ch) + 64
        max_ch_w = max(max_ch_w, w)
max_branch_w = max(probe.textlength(b, font=f_br) + 56 for b, _ in DATA)

BR_W = int(max_branch_w)
W = int(X_CH + max_ch_w + 70)
total = sum(len(c) for _, c in DATA) * CH_H + GAP_BRANCH * (len(DATA) - 1)
H = int(total + 200)

img = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(img)

def rbox(x, y, w, h, fill, outline=None, r=10, width=1):
    d.rounded_rectangle([x, y, x + w, y + h], radius=r, fill=fill, outline=outline, width=width)

root_cy = H // 2
rbox(X_ROOT, root_cy - ROOT_H // 2, ROOT_W, ROOT_H, ROOT_BG, ACCENT, r=16, width=2)
d.text((X_ROOT + 26, root_cy - 40), "Warframe 本地助手", font=f_root, fill=TXT)
d.text((X_ROOT + 26, root_cy + 8), "Ordis · 全息悬浮窗", font=f_sub, fill=ACCENT)

y = (H - total) // 2 + 10

for branch, children in DATA:
    block_h = len(children) * CH_H
    br_cy = y + block_h // 2

    x1 = X_ROOT + ROOT_W
    mid = (x1 + X_BR) // 2
    d.line([(x1, root_cy), (mid, root_cy)], fill=LINE, width=2)
    d.line([(mid, root_cy), (mid, br_cy)], fill=LINE, width=2)
    d.line([(mid, br_cy), (X_BR, br_cy)], fill=LINE, width=2)

    rbox(X_BR, br_cy - 26, BR_W, 52, BR_BG, (72, 102, 132), r=10)
    d.text((X_BR + 18, br_cy - 17), branch, font=f_br, fill=TXT)

    cy = y
    for ch in children:
        ch_cy = cy + CH_H // 2
        d.line([(X_BR + BR_W, br_cy), (X_BR + BR_W + 20, br_cy)], fill=LINE, width=2)
        d.line([(X_BR + BR_W + 20, br_cy), (X_BR + BR_W + 20, ch_cy)], fill=LINE, width=2)

        cw = int(probe.textlength(ch, font=f_ch) + 60)
        d.line([(X_BR + BR_W + 20, ch_cy), (X_CH, ch_cy)], fill=LINE, width=2)
        rbox(X_CH, cy + 5, cw, CH_H - 10, CH_BG, (46, 64, 82), r=8)
        d.ellipse([X_CH + 14, ch_cy - 3, X_CH + 20, ch_cy + 3], fill=ACCENT)
        d.text((X_CH + 30, cy + 11), ch, font=f_ch, fill=DIM)
        cy += CH_H

    y += block_h + GAP_BRANCH

d.text((X_ROOT, H - 56), "数据口径：国际服 PC ｜ 全部只读查询 ｜ 无游戏内注入或自动化",
       font=f_sub, fill=(108, 126, 144))

out = r"E:\warframe_localhost\overlay-demo\docs\项目功能结构导图.png"
img.save(out)
print("saved", out, img.size)
