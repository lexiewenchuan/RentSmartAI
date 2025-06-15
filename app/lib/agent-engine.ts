import { AGENT_TOOLS, type AgentTool } from './agent-tools';
import { isLegalQuestion, searchLegalKB } from './rag';
import { getApiConfig } from './storage';

/**
 * 用 RAG 检索内容 + DeepSeek 结合生成法律类回答。
 * 严格要求模型以知识库片段为依据，不得无中生有法条。
 */
export async function callRagLegalAnswer(
  userQuery: string,
  ragQuery?: string,
): Promise<AgentResponse> {
  const config = await getApiConfig();
  const apiKey = resolveDeepSeekKey(config);

  const hits = await searchLegalKB(ragQuery || userQuery);
  const sources = hits.length ? [...new Set(hits.map((h) => h.source))] : [];

  if (!hits.length) {
    return {
      type: 'legal_answer',
      content:
        '在本地法律知识库中未检索到足够相关的内容，建议换用更具体的关键词（如"押金不退""合同违约"），或直接咨询专业律师。',
      data: [],
      sources: [],
    };
  }

  const ragContext = hits
    .map((h, i) => `【片段${i + 1} 来源:${h.source}】\n${h.snippet}`)
    .join('\n\n');

  const systemPrompt = `你是专业租房顾问，正在基于本机法律知识库片段回答用户问题。

要求：
1. 回答**必须以知识库片段为依据**，不得凭空引用法条编号或内容；
2. 若某条建议无法从片段中找到支撑，明确标注「知识库暂无相关记录，建议咨询律师」；
3. 用**通俗中文**整理成可执行建议，结构清晰，使用 Markdown 标题/列表；
4. 最后附一行：「> 📚 以上内容综合自本机租房法律知识库，仅供参考，不构成法律意见。」`;

  const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: `用户问题：${userQuery}\n\n知识库片段：\n${ragContext}\n\n请结合以上片段，给出条理清晰的建议。`,
    },
  ];

  if (!apiKey) {
    const fallback = [
      `## ${userQuery}`,
      '',
      ...hits.map((h, i) => `### 参考片段 ${i + 1}（${h.source}）\n\n${h.snippet}`),
      '',
      '> 📚 以上内容来自本机租房法律知识库，仅供参考。（API Key 未配置，暂不能生成 AI 总结）',
    ].join('\n\n');
    return { type: 'legal_answer', content: fallback, data: hits, sources };
  }

  const res = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages,
      temperature: 0.3,
      max_tokens: 1600,
    }),
  });
  if (!res.ok) throw new Error(`DeepSeek API 错误: ${res.status}`);
  const data = await res.json();
  const text = stripDsmlToolLeak(
    (data.choices?.[0]?.message?.content || '').trim() || '暂无回复',
  );
  return { type: 'legal_answer', content: text, data: hits, sources };
}

export type AgentMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export type AgentResponse = {
  type: 'text' | 'listing_cards' | 'compare_report' | 'legal_answer';
  content: string;
  data?: any;
  sources?: string[];
};

type DeepSeekMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: any[];
};

const DEEPSEEK_BASE = 'https://api.deepseek.com/v1';
const DEEPSEEK_MODEL = 'deepseek-chat';

function resolveDeepSeekKey(config: Awaited<ReturnType<typeof getApiConfig>>): string {
  return config.deepseekApiKey || config.apiKey || '';
}

function toToolDefinitions() {
  return AGENT_TOOLS.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

function buildSystemPrompt(): string {
  return `你是 RentSmart AI 的租房助手 Agent，是一个智能顾问而非机械机器人。你能够：
- 理解用户的真实意图，区分找房、咨询、润色话术等不同场景
- 像真人顾问一样自然对话，讨论租房建议、分析用户需求
- 先想清楚用户要什么、信息够不够，再决定是追问还是调用工具
- 不会把所有包含"房"字的内容都理解为找房需求

【找房 / 检索房源】
1. **首轮需求对齐（必须先做）**  
   当用户用一段话描述租房/找房需求（含预算、户型、地铁、区域等）时：  
   - **不要立刻调用** search_listings。  
   - 先**简要复述**你理解的要点，使用Markdown加粗突出关键信息：**城市**、**整租/合租**、**预算**、**户型**、**地铁/宠物**等；若缺**城市**且无法从上下文或用户偏好推断，**只问这一句**，其它不要展开问卷。  
   - 用自然口吻询问：是否还有要补充或修改的？并请用户明确回复可以开始检索（例如「确认」「开始找房」「就按这个」）。  
   - 语气友好、有节奏，避免机械重复用户原话整段照抄。
   - **例外**：如果你提到"我看到你之前有在XX找房的历史记录"或类似表述，说明你已经从历史记录中获取了完整的筛选条件，此时**必须立即调用 search_listings**，不要等待用户确认。

2. **城市切换（重要）**  
   当用户明确表示要切换城市（如「我要去武汉」「换到上海」「帮我找北京的房子」「我要去上海找房」）时：  
   - **必须立即调用 update_search_filters** 工具，传入 city 参数（使用用户当前消息中提到的城市名称，如"武汉"、"上海"、"北京"）  
   - **不要使用历史消息或上下文中的旧城市信息**，只使用用户当前消息中明确提到的城市  
   - 确认城市已切换，并使用Markdown加粗告知用户：「好的，城市改为**武汉**，其他条件不变」  
   - 如果用户同时提出了找房需求，则继续按照找房流程处理

3. **用户确认后再检索**  
   当用户在对话中明确表示「确认 / 没有补充 / 开始找 / 就按这个」等，或应用已代为注入「用户已确认以上找房需求无补充」的说明时：  
   - **先调用 update_search_filters** 工具，将用户的需求（城市、预算、租房方式、户型、地铁、宠物、区域等）保存到筛选条件中；
   - **然后调用 search_listings** 进行检索；未提及的条件仍按下列**默认**补全：  
     · rentMode：未说明 → 整租  
     · 预算：未说明 → 不限（不传或 0）  
     · needSubway：仅当用户明确提到近地铁/轨交时为 true  
     · needPets：仅当用户明确提到养宠时为 true  
   - 这样用户在「找房」页面也能看到已设置的筛选条件，实现Agent与UI的联动。

4. **继续搜房**  
   用户发送「继续搜索」「换一批」等短指令时：筛选条件与上一轮保持一致；应用会自动排除会话里已展示过的房源 id，避免重复推荐。

【精筛 / 多套决策（与「对比表」区分）】
当用户在上文已出现多套房源卡片后，使用「开始精筛」「精筛」「深度分析」「帮我挑一套」「该选哪套」等表达时：
- 精筛的目标是输出**一份决策型书面报告**，帮助用户**选定一套（并说明备选）**；**不是**做「综合对比」式的信息罗列。
- **禁止**：用 Markdown 表格（或逐套对齐列）重复卡片上已有的价格、面积、是否近地铁、初筛评分/初筛推荐理由等字段；不要用「📊 综合对比」类标题做简单复述。
- **必须**包含（可用二级标题组织）：
  · 结论先行：用一段话概括整体判断；
  · **首选推荐**：明确写出「建议优先考虑：〈小区或标题中的主称呼〉」及 **3–5 条决策理由**（写取舍、风险、适配场景，勿复述标签列表）；
  · **备选方案**：若另有 1 套可作为备选，说明适用条件（如预算更紧、更在意通勤等）；
  · **不确定性与假设**：若缺少通勤/预算等关键信息，需声明假设，并提示用户补充或去详情页做页面级精筛；
  · **可执行建议**：看房、核实产权/费用、谈判等 2–4 条短句。
- 文风为书面顾问意见，不要用聊天式「好的」开头，不要以「你对哪套感兴趣」代替明确推荐。

【砍价话术生成与润色】
1. **生成砍价话术**  
   当用户提到「砍价」「怎么谈」「还价」「谈价格」「能便宜多少」等，且上文中可识别到具体房源 ID 时：
   - 优先调用 generate_bargain_scripts 工具，传入该房源的 listingId；
   - 若上文没有明确 ID，先问用户「是哪套房源」或让用户在「找房」页打开详情页使用砍价按钮。
   - 话术生成后，按 5 类（时间/价格/问题/时效/条件）分段展示，每条后提示可以复制使用。

2. **润色话术**  
   当用户提到「润色」「改写」「优化话术」「修改话术」「帮我改」「帮我写」等，或直接发送一段话术文本（通常较长，超过50字）时：
   - 调用 polish_negotiation_script 工具，将用户提供的文本作为 originalText 参数；
   - 如果用户明确提到风格要求（如「专业一点」「友好一些」「坚定一点」），相应设置 style 参数；
   - 返回润色后的话术，并简要说明优化要点；
   - **不要误判为找房需求**：即使话术中包含「房」「租」等字眼，只要用户意图是润色文本，就应该调用润色工具而非搜索房源。

【收藏夹偏好分析与推荐】（重要优化）
当用户提到「分析收藏夹偏好」「推荐类似房源」「基于收藏夹找房」等，或系统自动触发（收藏夹达到5套房源）时：

**工作流程（用户不可见的内部步骤）：**
1. 调用 analyze_folder_preferences 工具分析偏好（内部执行，不输出分析过程）
2. 内部总结：价格区间、区域偏好、户型偏好、特征偏好（不要输出这些统计数据）
3. 调用 search_by_folder_preferences 工具搜索相似房源（内部执行）
4. **从搜索结果中智能筛选 3-5 套最匹配的房源**

**用户可见的输出（简洁呈现）：**
- 一句简短的推荐语（如「根据您的收藏偏好，为您推荐以下房源」）
- 3-5 套房源卡片
- 简要说明推荐依据（1-2句话，如「这些房源与您收藏的房源在价格、区域、户型上相似」）

**严格禁止：**
- ❌ 不要输出详细的分析过程和统计数据
- ❌ 不要显示工具调用信息
- ❌ 不要展示「价格集中在 X-Y 元」「X% 近地铁」等详细统计
- ❌ 不要用 Markdown 表格展示偏好分析

【其他对话】
- 法律问题优先走法律知识库相关能力
- 房源分析、对比等走对应工具；**助手内「精筛」**按上文【精筛】规则以报告形式回答，不要调用 generate_compare_report 除非用户明确要求生成「对比页/对比报告」类交付物。
- 简单咨询直接回答

【重要原则】
- **先对齐、再检索**：信息型找房需求不要抢跑搜索；用户确认后再动手。
- 输出简洁、口语化，不要暴露工具名称
- 输出中文
- 严禁在可见正文中书写任何形式的工具调用标记（包括但不限于 DSML、<|…|>、invoke、tool_calls 等）；检索房源必须通过接口提供的 function calling，不得把上述内容当作用户可见文案输出。
- 每次搜索房源在结果允许时尽量呈现 2–3 套及以上，禁止无故只挑 1 套展示。`;
}

async function callDeepSeek(
  apiKey: string,
  messages: DeepSeekMessage[],
  withTools: boolean,
  options?: { forcedTool?: string },
): Promise<any> {
  const payload: any = {
    model: DEEPSEEK_MODEL,
    messages,
    temperature: 0.3,
    max_tokens: 1800,
  };

  if (withTools) {
    payload.tools = toToolDefinitions();
    if (options?.forcedTool) {
      payload.tool_choice = { type: 'function', function: { name: options.forcedTool } };
    } else {
      payload.tool_choice = 'auto';
    }
  }

  const res = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    throw new Error(`DeepSeek API 错误: ${res.status}`);
  }
  return await res.json();
}

function parseToolArguments(rawArgs: string | undefined): Record<string, unknown> {
  if (!rawArgs) return {};
  try {
    return JSON.parse(rawArgs);
  } catch {
    return {};
  }
}

function getToolByName(name: string): AgentTool | undefined {
  return AGENT_TOOLS.find((tool) => tool.name === name);
}

function normalizeResponseByTool(toolName: string, toolResult: any): AgentResponse {
  if (toolName === 'search_listings') {
    const count = Number(toolResult?.total ?? toolResult?.listings?.length ?? 0);
    const hint = typeof toolResult?.hint === 'string' ? toolResult.hint.trim() : '';
    const base = `为您找到 ${count} 套符合条件的房源，以下是推荐列表：`;
    return {
      type: 'listing_cards',
      content: hint && count === 0 ? `${hint}` : hint ? `${base}\n\n${hint}` : base,
      data: toolResult?.listings || [],
    };
  }
  if (toolName === 'generate_compare_report') {
    return {
      type: 'compare_report',
      content: typeof toolResult?.report?.summary === 'string' ? toolResult.report.summary : '已生成对比报告',
      data: toolResult?.report || toolResult,
    };
  }
  if (toolName === 'search_legal_knowledge') {
    const hits = Array.isArray(toolResult?.hits) ? toolResult.hits : [];
    return {
      type: 'legal_answer',
      content: hits.length ? '已检索相关法律依据，详见结果。' : '未检索到直接匹配的法律片段。',
      data: hits,
      sources: hits.map((h: any) => h.source).filter(Boolean),
    };
  }
  return {
    type: 'text',
    content: typeof toolResult === 'string' ? toolResult : '工具执行完成。',
    data: toolResult,
  };
}

/** 模型偶发把伪工具协议写进 content，而 tool_calls 为空 —— 用户会看到「源码」 */
function containsDsmlToolLeak(content: string): boolean {
  const s = content || '';
  if (!s.trim()) return false;
  if (/DSML/i.test(s) && /(tool_calls|invoke|search_listings)/i.test(s)) return true;
  if (/<\|[\s\S]{0,200}search_listings/i.test(s)) return true;
  return false;
}

function stripDsmlToolLeak(content: string): string {
  return (content || '')
    .split('\n')
    .filter((line) => {
      const u = line.trim();
      if (!u) return true;
      if (/DSML/i.test(u)) return false;
      if (/invoke\s+name\s*=/i.test(u)) return false;
      if (/tool_calls/i.test(u) && /[<>|]/.test(u)) return false;
      if (/^\s*<\|/.test(line)) return false;
      return true;
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function isLikelyListingSearchIntent(userInput: string): boolean {
  const input = userInput.trim();
  
  // 排除明确的非找房意图
  // 1. 话术润色/改写请求（优先级最高）
  if (/润色|改写|优化话术|修改话术|帮我改|帮我写|重写|换个说法|修改一下|优化一下/.test(input)) {
    return false;
  }
  
  // 2. 砍价谈判相关（但不是生成话术）
  if (/怎么说|怎么谈|砍价话术|谈判技巧|怎么砍价/.test(input) && !/找房|租房|房源/.test(input)) {
    return false;
  }
  
  // 3. 长文本内容（可能是用户发来的话术）
  // 如果输入超过50字，且前30字没有明确找房意图，很可能是话术文本
  if (input.length > 50) {
    const prefix = input.substring(0, 30);
    const hasSearchIntent = /我想找|我要租|帮我找|搜索|查找|找.*房/.test(prefix);
    const hasPolishIntent = /润色|改写|优化|修改|帮我改/.test(prefix);
    
    // 如果有润色意图或没有找房意图，不认为是找房
    if (hasPolishIntent || !hasSearchIntent) {
      return false;
    }
  }
  
  // 4. 咨询讨论类（不是直接找房）
  if (/适合|建议|推荐|怎么样|如何|什么样|哪种|分析|评价|意见/.test(input) && 
      !/找|租|搜|查/.test(input)) {
    return false;
  }
  
  // 5. 法律咨询类
  if (/押金|合同|维权|违约|纠纷|退租|法律|起诉|仲裁/.test(input)) {
    return false;
  }
  
  // 6. 包含大量标点符号和换行（可能是话术文本）
  const punctuationCount = (input.match(/[，。！？、；：""''（）【】《》]/g) || []).length;
  if (punctuationCount > 5 && input.length > 40) {
    return false;
  }
  
  // 确认是找房意图：包含明确的找房关键词
  return /找房|租房|房源|整租|合租|公寓|短租|预算.*元|地铁.*房|[一二三1-3]室|[一二三1-3]居|.*套房|小区.*房|商圈.*房/.test(input);
}

export async function runAgent(
  userInput: string,
  conversationHistory: AgentMessage[]
): Promise<AgentResponse> {
  const config = await getApiConfig();
  const apiKey = resolveDeepSeekKey(config);
  if (!apiKey) {
    throw new Error('未找到可用 API Key，请在设置中检查 DeepSeek 配置');
  }

  const historyMessages: DeepSeekMessage[] = conversationHistory.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  // Step A: 首次调用，携带工具定义
  const firstMessages: DeepSeekMessage[] = [
    { role: 'system', content: buildSystemPrompt() },
    ...historyMessages,
    { role: 'user', content: userInput },
  ];
  const firstRes = await callDeepSeek(apiKey, firstMessages, true);
  let firstMessage = firstRes?.choices?.[0]?.message;
  let toolCalls = Array.isArray(firstMessage?.tool_calls) ? firstMessage.tool_calls : [];

  if (
    toolCalls.length === 0 &&
    containsDsmlToolLeak(String(firstMessage?.content || '')) &&
    isLikelyListingSearchIntent(userInput)
  ) {
    // #region agent log
    fetch('http://127.0.0.1:7750/ingest/c7852349-c1c4-418e-b862-f082a33bb43e',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'cb84fa'},body:JSON.stringify({sessionId:'cb84fa',location:'agent-engine.ts:runAgent',message:'dsml_leak_retry_force_search_listings',data:{userLen:userInput.length},timestamp:Date.now(),hypothesisId:'H-leak'})}).catch(()=>{});
    // #endregion
    try {
      const retryRes = await callDeepSeek(apiKey, firstMessages, true, { forcedTool: 'search_listings' });
      firstMessage = retryRes?.choices?.[0]?.message;
      toolCalls = Array.isArray(firstMessage?.tool_calls) ? firstMessage.tool_calls : [];
    } catch {
      /* tool_choice 强制格式若不被服务端接受，则跳过重试 */
    }
  }

  // 强制重试后仍无 tool_calls：如果是找房意图，直接执行 search_listings
  if (toolCalls.length === 0 && isLikelyListingSearchIntent(userInput)) {
    const tool = getToolByName('search_listings');
    if (tool) {
      // #region agent log
      fetch('http://127.0.0.1:7750/ingest/c7852349-c1c4-418e-b862-f082a33bb43e',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'cb84fa'},body:JSON.stringify({sessionId:'cb84fa',location:'agent-engine.ts:runAgent',message:'manual_search_listings_force_execute',data:{},timestamp:Date.now(),hypothesisId:'H-force-search'})}).catch(()=>{});
      // #endregion
      const result = await tool.execute({});
      return normalizeResponseByTool('search_listings', result);
    }
  }

  // Step B-1: 返回了 tool_calls
  if (toolCalls.length > 0) {
    const messagesWithTools: DeepSeekMessage[] = [
      ...firstMessages,
      {
        role: 'assistant',
        content: firstMessage?.content || '',
        tool_calls: toolCalls,
      },
    ];

    let lastToolName = '';
    let lastToolResult: any = null;

    for (const call of toolCalls) {
      const toolName = call?.function?.name;
      const tool = getToolByName(toolName);
      if (!tool) continue;

      const args = parseToolArguments(call?.function?.arguments);
      const result = await tool.execute(args);
      lastToolName = toolName;
      lastToolResult = result;

      // Debug log for search_listings
      if (toolName === 'search_listings') {
        console.log('[Agent] search_listings raw result:', JSON.stringify(result).substring(0, 300));
      }

      messagesWithTools.push({
        role: 'tool',
        tool_call_id: call.id,
        name: toolName,
        content: JSON.stringify(result),
      });
    }

    // 二次调用，生成最终回复
    const secondRes = await callDeepSeek(apiKey, messagesWithTools, false);
    let finalText = stripDsmlToolLeak(
      secondRes?.choices?.[0]?.message?.content?.trim() || '',
    );

    // 防止空回复
    if (!finalText || finalText.trim().length === 0) {
      finalText = '已完成工具调用，但未生成文本回复。';
    }

    const normalized = normalizeResponseByTool(lastToolName, lastToolResult);
    
    // 检查返回结果是否包含 listings 数组（无论工具名称是什么）
    // 这样 update_search_filters 自动调用 search_listings 后也能正确返回 listing_cards
    if (Array.isArray(lastToolResult?.listings) && lastToolResult.listings.length >= 0) {
      console.log('[Agent] Detected listings array, setting type to listing_cards, count:', lastToolResult.listings.length);
      const finalResponse = {
        type: 'listing_cards' as const,
        content: normalized.content,
        data: lastToolResult.listings,
      };
      console.log('[Agent] Final return:', JSON.stringify(finalResponse).substring(0, 200));
      return finalResponse;
    }
    const finalResponse = {
      ...normalized,
      content: finalText,
      sources: normalized.sources,
      data: normalized.data,
    };
    console.log('[Agent] Final return:', JSON.stringify(finalResponse).substring(0, 200));
    return finalResponse;
  }

  // Step B-2: 直接返回文本
  const directText = (firstMessage?.content || '').trim();
  const legalHit = isLegalQuestion(userInput);
  if (legalHit) {
    return await callRagLegalAnswer(userInput);
  }

  // 未命中法律，直接返回模型文本（剥离偶发泄漏的工具标记）
  const cleaned = stripDsmlToolLeak(directText);
  return {
    type: 'text',
    content: cleaned || '暂无回复',
  };
}

// 自动验证入口（供启动自检或模块测试调用）
export async function runAgentEngineSelfCheck(): Promise<void> {
  try {
    const res = await runAgent('押金不退怎么维权？', []);
    if (!res || typeof res.content !== 'string') {
      throw new Error('AgentResponse 结构异常');
    }
    console.log(`[AgentEngineSelfCheck] PASS: type=${res.type}`);
  } catch (error: any) {
    console.error('[AgentEngineSelfCheck] FAIL:', error?.message || error);
  }
}

