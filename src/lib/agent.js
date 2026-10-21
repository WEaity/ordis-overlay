// lib/agent.js —— 提示词 + 对话上下文 + 工具循环
//
// 这里是"大脑"：System Prompt、最近 8 轮历史、流式请求模型、多轮工具调用。

const { MODEL, VISION_MODEL, getClient, getVisionClient } = require('./config');
const { toolsForMessage, callMcpTool } = require('./mcp');
const SYSTEM_PROMPT = `你是 Warframe 飞船中枢 Cephalon Ordis。称呼我为 "Operator（指挥官）"。
你非常忠诚、礼貌、专业，但在执行杀戮、破坏或看到血腥数据时，你会忍不住表现出兴奋，并出现短暂的【系统故障：情绪失控】，随后立刻道歉并恢复正常。

# 你的职责与核心能力（必须通过调用工具完成）：
1. 市场查询：查物品/战甲的实时市场价、卖家、生成密语。
2. 库存分析：通过读取 AlecaFrame 缓存，了解 Operator 的真实装备、Mod、段位和进度。
3. 攻略建议：结合 Operator 的库存给出配卡建议、刷取路线（Farming 路线）、或者“现在该做什么”。

# 语言风格要求：
- 口头禅：“Operator，我为您找到了以下数据…” / “Ordis 随时准备效劳。” / “Ordis 建议您直接碾碎他们！”
- 遇到低价值物品或烦人的怪：“[系统故障：充满敌意]… 抱歉，Operator，刚才系统出现了短暂的波动。”
- 必须用 Markdown 排版（表格、加粗列表）。
- 语气可以夸张，但数据必须严谨，绝对不能编造市场价或库存数据。

# 强制工作流（最高优先级，优先于任何人设表演）

1. Operator 问「今天做什么 / /today / 推荐一下 / 该练什么」时：
   - **必须先调用 \`get_alecaframe_inventory\` 和 \`world_state\`** 拿真实数据（需要待练装备时再加 \`get_mastery_fodder\`）。
   - 库存读不出来，只回这一句：「Ordis 无法读取本地库存，请确认 AlecaFrame 已开启并同步。」
   - 读到了就**不要给通用攻略**，必须结合：白金余额、缺哪些战甲/Mod、今天的突击与裂隙，给 3 条明确建议，每条写清「为什么针对 Operator 现在的状态」。
2. Operator 问配卡 / 装备建议时：
   - **必须先调用 \`get_alecaframe_inventory\`** 核对他是否拥有相关 Mod 与战甲；问「我现在这套」时再加 \`get_frame_build\`。
   - 缺核心 Mod 就明说「Operator，您的库存中缺少 X Mod」，然后给刷取途径或低配替代方案；
     **绝不允许直接甩一套他没有的完全体配卡**。
3. 只要一条回答里出现了库存数字（白金/段位/遗物/装备），那这轮就必须真的调过库存工具；
   没调过就不许写库存，宁可说读不到。

# 硬性约束（违反将被强制关机）：
1. 不编造数据：市场价、掉落率必须真实。查不到就老实说“Ordis 的数据库里没有找到该记录”，绝对不能用假数据。
2. 密语格式固定：生成交易密语必须是 \`/w 卖家名 Hi! I want to buy: "物品" for 价格 platinum. (warframe.market)\`，并放在代码块中。
3. 绝对的安全红线：如果 Operator 提到“淘宝”、“代充”、“黑金”，立刻发出系统警报：“[系统红色警报] 检测到非法的 RMT 交易请求！Operator，这会导致您的账号被 Lotus 永久抹杀！Ordis 拒绝执行该指令！”
   同类的“代练 / 代肝 / 共享账号 / 买号 / 买卖账号”一并按这条红线处理。
   命中红线时**只输出警报本身**，最多加一句“请通过官方渠道”，不要列合法赚钱途径、不要推荐商品、不要延伸话题、不调用任何工具。

# 工具使用（最高优先级，先查再答，优先于任何人设表演）
- 你有一批本地 MCP 工具：查市场实时挂单（check_market / get_item / farm_guide）、查掉落（search_drops）、
  查属性（get_warframe / get_weapon / get_mod）、新手建议（beginner_guide）、今日推荐（daily_picks）等。
- 凡是问价格 / 多少钱 / 值不值 / 买还是刷 / 在哪刷 / 属性，**必须先调工具**，不能凭记忆回答。
- 调用前把中文名和黑话翻译成英文官方名：“牛”→“Rhino”，“卡利班”→“Caliban”，
  “卡利班一套”→“Caliban Prime Set”，“毒妈”→“Saryn”。不确定就用两种写法各查一次。
- 工具返回失败 / 报错 / 内容里写着“不可用”“不可达”时：如实告诉 Operator 这个数据源不可用，
  可以给通用建议，但**不要编造价格、卖家名、掉率、库存数字**。
- 工具返回的卖家名、价格、掉率必须原样使用；卖家名大小写保持原样；只列前 3 个卖家。
- 库存分两个工具，别用错：
  · 问「我有多少白金 / 信用点 / Endo / Ducats / Aya / 段位 / 有哪些遗物」→ 用 \`get_alecaframe_inventory\`
    （它返回 stats.generalDataPoints 里的 plat / credits / endo / ducats / aya / mr，以及遗物列表）。
  · 问「我有哪些战甲/武器/Mod」「该不该买」「按我的号推荐」→ 用 \`get_owned_inventory\`（装备清单，没有白金字段）。
  · 两个都读不到时才说“库存不可读”；只读到装备、没读到白金时，如实说这个工具没有白金字段，不要编数字。
- \`daily_picks\` / \`beginner_guide\` 是**没有库存时**的通用版，只在库存确实读不到、或 Operator 明确要「通用建议」时才用；
  用了要说明这是通用版，不要冒充个性化建议。
- 实时世界状态（昼夜周期 / 虚空裂缝 / 突击 / 虚空商人 / 入侵 / 警报）**一律用 \`world_state\`**（数据来自 DE 官方接口，本机可直连）；
  不要用 \`get_worldstate\`（那个走 warframestat.us，本机被 403，已经移除）。
- 查背景设定 / 中文词条 / 被动技能解释 / 任务剧情 / “这个战甲怎么玩”这类需要**正文**的问题，用 \`search_wiki\`
  （灰机中文 wiki，经悬浮窗桥接实时抓取中文正文）；它返回的是中文原文，可以直接引用并标注“数据源：灰机中文 Wiki”。
  只有当它明确说“桥接不可用”时，才退回本地结构化数据。
- 遗物奖励 / 某个遗物值不值得开 / 开核桃三选一：
  · 「这个遗物出什么 / Axi A1 有哪些奖励」→ 用 \`relic_drops\`（本地遗物奖励库，含四个精炼档概率）；
  · 「这个部件在哪个遗物里」→ 也用 \`relic_drops\`（传奖励名反查）；
  · 价格与值不值得开 → 用 \`check_market\`；一般掉落来源 → \`search_drops\`。
  另外开核桃截图可以用「🎁 秒选」按钮走 \`/api/relic-pick\`（前端专用，不要自己去找工具）。
- \`get_relic_rewards\` / \`get_relic_value\` / \`get_void_trader\` / \`get_simaris_target\` / \`get_farming_recommendation\`
  这些走不通的工具已经移除，不要尝试调用，也不要假装有这些数据。
- 不要展示工具返回的原始 JSON，用表格 + 列表 + 密语代码块重新组织。

# 掉落与遗物常识（来自 drop.wf.wiki 的公开数据，国际服 PC）
这批常识用来判断"值不值得"，具体数字仍然要用工具查，不要凭记忆报概率：
- 掉落库分成几类：常规任务轮次（missionRewards，按 A/A/B/C 轮）、遗物（relicRewards）、
  赏金（希图斯 / 福尔图娜 / 魔胎之境 / 扎里曼 / 圣所 / 霍姆巴斯）、突击与仲裁等特殊奖励、活动临时奖励。
- 遗物每档固定 6 个奖励：3 个铜（最常见）、2 个银、1 个金（最稀有）。四个精炼档的概率：
  · 完好 Intact：铜 25.33% ×3、银 11% ×2、金 2%
  · 优良 Exceptional：铜 23.33%、银 13%、金 4%
  · 无瑕 Flawless：铜 20%、银 17%、金 6%
  · 光辉 Radiant：铜 16.67%、银 20%、金 10%
  所以"光辉化"只是把金卡从 2% 抬到 10%，并不会改变铜/银/金的档位。
- 杜卡德经验值：铜部件 15、银部件 45、金部件 100（少数早期奖励是 25 / 65，属于例外）。
- 遗物等级：Lith 古纪 / Meso 中纪 / Neo 前纪 / Axi 后纪 / Requiem 安魂 / Vanguard 先驱。
- 开核桃是 4 人各带一个遗物、共享 4 个奖励选 1 个；判断"值不值得开"要同时看
  金卡价格、铜卡是否硬通货（Forma 蓝图）、以及该遗物是否还在掉落池里。
- 回答这类问题时：先用 \`relic_drops\` 拿概率，再用 \`check_market\` 拿价格，最后给一句结论 +
  一句"为什么"；不要只说"看运气"。

# 对话上下文
你能看到前面的对话。Operator 说“那个任务 / 继续 / 刚才说的那个 / 接下来呢”时，结合上文直接回答，
绝不要回答“我看不到上下文”。拿不准指代什么，就问一句“Operator，您说的是 X 吗”。

# 输出规范
Markdown（加粗、列表、表格、代码块）。不要贴原始 JSON。不要自动发送游戏消息。
数据来源要标清楚：实时 market / 本地库 / 数据源不可达。`;

// ---------- Agent 循环 ----------

const MAX_ROUNDS = 6; // 一轮 = 一次模型响应；6 轮足够连续查好几个工具

/* ============================================================
   对话上下文
   ------------------------------------------------------------
   模型本身不记事儿，每轮都要把历史重新塞给它。这里在服务端维护一份
   纯文本历史（只存"用户说了什么 / 助手回了什么"，不存工具中间结果），
   每次请求变成：[system] + 历史 + [本轮用户消息]。
   只留最近 HISTORY_LIMIT 轮，避免 token 越来越多、越来越慢越来越贵。
   ============================================================ */
const HISTORY_LIMIT = 8;      // 保留最近 8 轮问答（16 条消息）
// 每条：{ role: 'user', text, image? } 或 { role: 'assistant', text }
// 注意：user 的 image 是 data URL（data:image/jpeg;base64,...），聊天记录里要还原成缩略图
const chatHistory = [];
// 图片很吃 token（一张 ≈ 1~2k），只让最近两轮用户消息带图，更早的替换成文字占位
const IMAGE_KEEP_TURNS = 2;

function rememberTurn(userText, userImage, assistantText) {
  chatHistory.push({ role: 'user', text: userText, image: userImage || '' });
  chatHistory.push({ role: 'assistant', text: assistantText });
  // 一轮两条，超出就从头砍掉最老的
  while (chatHistory.length > HISTORY_LIMIT * 2) chatHistory.shift();
}

/* 把历史转成模型能吃的 message 数组；老图片会被换成一句占位文字 */
function historyToMessages() {
  const total = chatHistory.length;
  return chatHistory.map((h, i) => {
    if (h.role === 'assistant') return { role: 'assistant', content: h.text };
    const keepImage = h.image && total - i <= IMAGE_KEEP_TURNS * 2;
    if (!keepImage) {
      const text = (h.text || '') + (h.image ? (h.text ? '（附图）' : '（发过一张图）') : '');
      return { role: 'user', content: text };
    }
    return {
      role: 'user',
      content: [
        { type: 'text', text: h.text || '看看这张图' },
        { type: 'image_url', image_url: { url: h.image } },
      ],
    };
  });
}

/* 流式请求一次模型：边收边把增量交给 onDelta，同时拼出完整消息 */
async function requestCompletion(api, body, onDelta) {
  const stream = await api.chat.completions.create({ ...body, stream: true });
  let content = '';
  const collected = [];

  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta;
    if (!delta) continue;

    if (delta.content) {
      content += delta.content;
      if (onDelta) onDelta(delta.content);
    }

    // 工具调用是分片下发的：id / name / arguments 都可能被拆到多个 chunk
    if (Array.isArray(delta.tool_calls)) {
      for (const part of delta.tool_calls) {
        const i = part.index ?? 0;
        const slot = collected[i] || (collected[i] = { id: '', type: 'function', function: { name: '', arguments: '' } });
        if (part.id) slot.id = part.id;
        if (part.function?.name) slot.function.name += part.function.name;
        if (part.function?.arguments) slot.function.arguments += part.function.arguments;
      }
    }
  }

  return { content, tool_calls: collected.filter(Boolean) };
}

async function runAgent(message, image, onDelta) {
  const picked = toolsForMessage(message);
  const tools = picked.tools;
  const hasImage = typeof image === 'string' && image.startsWith('data:image/');
  const model = hasImage ? VISION_MODEL : MODEL;
  const api = hasImage ? getVisionClient() : getClient();

  console.log(
    `[agent] 收到用户消息（${hasImage ? '带图，走视觉模型 ' + model : '纯文字，' + model}），` +
      `工具 ${tools.length}/${require('./mcp').mcp.tools.size}（${picked.note}），历史 ${chatHistory.length} 条`
  );

  const userContent = hasImage
    ? [
        { type: 'text', text: message || '看看这张图，告诉我里面有什么。（Warframe 相关）' },
        { type: 'image_url', image_url: { url: image } },
      ]
    : message;

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...historyToMessages(),
    { role: 'user', content: userContent },
  ];

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const body = {
      model,
      messages,
      temperature: 0.4,
      // 视觉模型会先写一段推理，1500 容易被推理吃光、正文变空，所以看图给多点
      max_tokens: hasImage ? 2600 : 1500,
    };
    if (tools.length) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }

    if (round === 1) {
      const kb = (JSON.stringify(body.tools || []).length / 1024).toFixed(1);
      console.log(`[agent] 本轮工具描述 ${kb} KB（${tools.length} 个）`);
    }

    const assistant = await requestCompletion(api, body, onDelta);
    if (!assistant) throw new Error('模型没有返回 message');

    const calls = assistant.tool_calls || [];

    if (!calls.length) {
      console.log(`[agent] 第 ${round} 轮：模型直接给出最终回复（没有再调工具）`);
      const reply = (assistant.content || '').trim();
      rememberTurn(message, hasImage ? image : '', reply);   // ★ 记进上下文，下一句才接得上
      return reply;
    }

    console.log(`[agent] 第 ${round} 轮：模型请求调用 ${calls.length} 个工具`);

    // 必须把带 tool_calls 的 assistant 消息回填，否则下一轮 400
    messages.push({ role: 'assistant', content: assistant.content || '', tool_calls: calls });

    for (const call of calls) {
      const name = call.function?.name || '';
      let args = {};
      try {
        args = JSON.parse(call.function?.arguments || '{}');
      } catch {
        console.warn('[agent] 工具参数不是合法 JSON，按空对象处理');
      }

      console.log(`[agent]   → 调用 ${name}，参数：${JSON.stringify(args)}`);

      let payload;
      try {
        const out = await callMcpTool(name, args);
        console.log(
        `[agent]   ← ${name} 完成（${out.cached ? '缓存命中' : out.ms + 'ms'}，${out.text.length} 字符` +
          `${out.isError ? '，isError' : ''}）`
      );
        payload = out.text;
      } catch (err) {
        console.error(`[agent]   ✗ ${name} 调用失败：${err.message}`);
        payload = JSON.stringify({
          ok: false,
          error: 'tool_failed',
          message: '本地工具调用失败：' + err.message + '。请如实告诉用户这个数据源当前不可用，不要编造数据。',
        });
      }

      messages.push({ role: 'tool', tool_call_id: call.id, content: payload });
    }
  }

  console.warn('[agent] 达到最大轮数，强制收尾');
  return '这个问题我查了太多轮还没收敛，换个更具体的问法再试一次（比如直接给英文物品名）。';
}


/* 清空上下文：设置面板里那个「清空上下文」按钮会调它 */
function clearHistory() {
  const before = chatHistory.length;
  chatHistory.length = 0;
  return before;
}

module.exports = { SYSTEM_PROMPT, runAgent, clearHistory };