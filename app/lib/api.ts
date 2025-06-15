// ── AI 模型调用 ──────────────────────────────────────────────

import { getApiConfig, type Listing, type UserPrefs } from './storage';

export type ChatMessage = {
  role: 'user' | 'assistant' | 'system';
  content: string;
};

// DeepSeek API 基础配置
const DEEPSEEK_BASE = 'https://api.deepseek.com/v1';
const DEEPSEEK_MODEL = 'deepseek-chat';

// GLM API 基础配置
const GLM_BASE = 'https://open.bigmodel.cn/api/paas/v4';
const GLM_MODEL = 'glm-4-flash';

export type AIScoreResult = {
  score: number;        // 0-10分
  comment: string;      // 简短点评
  reason?: string;      // 评分理由
};

function resolveDeepSeekKey(config: Awaited<ReturnType<typeof getApiConfig>>): string {
  return config.deepseekApiKey || config.apiKey || '';
}

function resolveGLMKey(config: Awaited<ReturnType<typeof getApiConfig>>): string {
  return config.glmApiKey || config.apiKey || '';
}

// ── 初筛评分（文本模型）──────────────────────────────────────
export async function scoreListingWithAI(
  listing: Listing,
  userPrefs: UserPrefs
): Promise<AIScoreResult | null> {
  try {
    const config = await getApiConfig();
    
    // 如果没有配置 API Key，跳过 AI 评分
    const deepSeekKey = resolveDeepSeekKey(config);
    if (!deepSeekKey && config.textModel !== 'deepseek') {
      return null;
    }
    
    // 构建提示词
    const prompt = buildScoringPrompt(listing, userPrefs);
    
    // 根据模型选择不同的 API
    if (config.textModel === 'deepseek' || !config.apiKey) {
      return await callDeepSeek(prompt, deepSeekKey);
    } else {
      // 其他模型暂不实现，返回 null
      return null;
    }
  } catch (error) {
    console.error('AI评分失败:', error);
    return null;
  }
}

// ── 批量评分 ─────────────────────────────────────────────────
export async function batchScoreListings(
  listings: Listing[],
  userPrefs: UserPrefs
): Promise<Map<string, AIScoreResult>> {
  const results = new Map<string, AIScoreResult>();
  
  // 限制并发数，避免频率限制
  const batchSize = 3;
  for (let i = 0; i < listings.length; i += batchSize) {
    const batch = listings.slice(i, i + batchSize);
    const promises = batch.map(listing => scoreListingWithAI(listing, userPrefs));
    const batchResults = await Promise.all(promises);
    
    batchResults.forEach((result, index) => {
      if (result) {
        results.set(batch[index].id, result);
      }
    });
    
    // 避免频率限制，批次间延迟
    if (i + batchSize < listings.length) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  
  return results;
}

/** 去掉对比报告里常见的聊天式开场，避免像「一问一答」 */
function stripCompareReportChatPrefix(raw: string): string {
  const s = raw.trimStart();
  if (!/^(好的|当然|没问题|行|可以|嗯嗯?|您好|明白|收到)/u.test(s)) {
    return s;
  }
  const probe = s.slice(0, 1600);
  const nlHash = /\n(#{1,3}\s)/.exec(probe);
  if (nlHash && nlHash.index != null && nlHash.index > 0) {
    return s.slice(nlHash.index + 1).trimStart();
  }
  const lineNum = /(^|\n)(\d+[\)）、]\s*[^\n]{2,})/.exec(probe);
  if (lineNum && lineNum.index != null && lineNum[2]) {
    const at = lineNum.index + (lineNum[1] === '\n' ? 1 : 0);
    return s.slice(at).trimStart();
  }
  return s
    .replace(/^((好的|当然|没问题|行|可以|嗯嗯?|您好|明白|收到)[，,。.!！：:\s])+/, '')
    .trimStart();
}

export async function generateCompareReport(
  listings: Listing[],
  userPrefs: UserPrefs
): Promise<string> {
  if (listings.length < 2) {
    throw new Error('至少选择2套房源才能生成对比报告');
  }

  const config = await getApiConfig();
  const deepSeekKey = resolveDeepSeekKey(config);
  if (!deepSeekKey) {
    throw new Error('未配置 DeepSeek API Key，请前往「我的」页面配置。');
  }

  const prompt = `请针对以下${listings.length}套房源撰写**正式对比报告**（书面体，非对话）。

【用户偏好】
- 预算：${userPrefs.budgetMin || '不限'} - ${userPrefs.budgetMax || '不限'} 元/月
- 租房方式：${userPrefs.rentMode}
- 位置偏好：${userPrefs.district || '不限'}
- 通勤地址：${userPrefs.commuteAddr || '未设置'}
- 近地铁：${userPrefs.needSubway ? '需要' : '不限'}
- 可养宠：${userPrefs.needPets ? '需要' : '不限'}
- 其他要求：${userPrefs.otherReqs || '无'}

【房源列表】
${listings.map((item, index) => `#${index + 1}
标题：${item.title}
价格：${item.price} 元/月
户型面积：${item.roomType} / ${item.area}
楼层：${item.floor}
位置：${item.district} ${item.community}
标签：${item.tags.join('、') || '无'}
AI初评分：${item.aiScore || 0}
链接：${item.url || '无'}`).join('\n\n')}

【文风与格式】
- 输出正式书面报告，不要聊天口吻；禁止以「好的」「当然」「没问题」「作为您的租房顾问」等对话式或自称铺垫开头。
- 正文请直接从 Markdown 标题（建议以 ## 开头）或「1）总体结论」这类报告结构起笔，不要先写应答用户的句子。

请输出 Markdown，必须包含这些板块：
1) 总体结论（推荐顺序+一句话结论）
2) 分项对比（价格/通勤便利/居住舒适/风险点）
3) 每套房源的隐藏风险（至少1条）
4) 看房谈判建议（可执行）
5) 最终推荐（第1名原因 + 备选方案）
`;

  const res = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${deepSeekKey}`,
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages: [
        {
          role: 'system',
          content:
            '你是资深租房顾问。输出正式对比报告：结构清晰、可执行；禁止聊天式寒暄或应答词、禁止自称顾问向用户打招呼式开头。',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      temperature: 0.4,
      max_tokens: 1800,
    }),
  });

  if (!res.ok) {
    throw new Error(`AI 对比报告生成失败: ${res.status}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || '报告生成失败，请重试';
  return stripCompareReportChatPrefix(typeof content === 'string' ? content : String(content));
}

// ── 构建评分提示词 ───────────────────────────────────────────
function buildScoringPrompt(listing: Listing, prefs: UserPrefs): string {
  return `你是租房AI助手，请根据用户需求对这套房源打分（0-10分）并给出简短点评。

【房源信息】
标题：${listing.title}
位置：${listing.district} ${listing.community}
户型：${listing.roomType} ${listing.area}
楼层：${listing.floor}
价格：${listing.price}元/月
标签：${listing.tags.join('、')}

【用户需求】
预算：${prefs.budgetMin || '不限'} - ${prefs.budgetMax || '不限'} 元/月
租房方式：${prefs.rentMode}
位置偏好：${prefs.district || '不限'}
${prefs.commuteAddr ? `通勤地址：${prefs.commuteAddr}` : ''}
${prefs.needSubway ? '需要近地铁' : ''}
${prefs.needPets ? '需要可养宠' : ''}
${prefs.otherReqs ? `其他要求：${prefs.otherReqs}` : ''}

请以 JSON 格式返回：
{
  "score": 8.5,
  "comment": "性价比高，位置好，符合预算",
  "reason": "价格在预算内，近地铁，户型合适"
}`;
}

// ── 调用 DeepSeek API ────────────────────────────────────────
async function callDeepSeek(prompt: string, apiKey: string): Promise<AIScoreResult | null> {
  try {
    if (!apiKey) {
      return null; // 没有 Key 时降级
    }
    
    const response = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages: [
          {
            role: 'system',
            content: '你是专业的租房AI助手，擅长分析房源性价比。回复必须是纯 JSON 格式。',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: 0.7,
        max_tokens: 300,
      }),
    });
    
    if (!response.ok) {
      console.error('DeepSeek API 错误:', response.status);
      return null;
    }
    
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    
    if (!content) {
      return null;
    }
    
    // 解析 JSON 响应
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return null;
    }
    
    const result = JSON.parse(jsonMatch[0]);
    return {
      score: Math.min(10, Math.max(0, result.score || 0)),
      comment: result.comment || '待分析',
      reason: result.reason,
    };
  } catch (error) {
    console.error('调用 DeepSeek 失败:', error);
    return null;
  }
}

// ── 精筛分析（多模态）────────────────────────────────────────
export type PageExtractExtras = {
  facilities?: string[];
  imageUrls?: string[];
};

export async function deepAnalyzeListing(
  listing: Listing,
  userPrefs: UserPrefs,
  images?: string[],
  pageContent?: string,
  pageExtras?: PageExtractExtras,
  imageAnalysisText?: string,
): Promise<string> {
  const config = await getApiConfig();
  
  const deepSeekKey = resolveDeepSeekKey(config);
  const glmKey = resolveGLMKey(config);
  const model = config.visionModel;

  const fromListing =
    listing.imageUrl && !isLikelyInvalidBeikePosterUrl(listing.imageUrl) ? [listing.imageUrl] : [];
  const fromPage = (pageExtras?.imageUrls || []).filter(
    (u) => u && /^https?:\/\//i.test(String(u)) && !isLikelyInvalidBeikePosterUrl(String(u)),
  );
  const mergedVision: string[] = [];
  const seenUrls = new Set<string>();
  for (const u of [...(images || []), ...fromListing, ...fromPage]) {
    const s = String(u || '').trim();
    if (!s || seenUrls.has(s)) continue;
    seenUrls.add(s);
    mergedVision.push(s);
    if (mergedVision.length >= 8) break;
  }
  const visionImages = mergedVision.length > 0 ? mergedVision : undefined;
  
  const prompt = buildDeepAnalysisPrompt(listing, userPrefs, pageContent, pageExtras, imageAnalysisText);
  
  console.log('[DeepAnalysis] 使用模型:', model);
  console.log('[DeepAnalysis] prompt 前500字:', prompt.slice(0, 500));
  
  // 检查是否有真实的实拍图（detailImages）
  const detailImages = listing.detailImages || [];
  const hasRealImages = detailImages && detailImages.length > 0 && 
    detailImages.some(img => typeof img === 'string' && img.startsWith('http'));
  
  console.log('[DeepAnalysis] 实拍图检查:', {
    detailImagesCount: detailImages.length,
    hasRealImages,
    mergedVisionCount: mergedVision.length,
    model,
  });
  
  // 如果没有真实实拍图，强制使用 DeepSeek 文本模型
  let effectiveModel = model;
  if (!hasRealImages && model === 'glm4v') {
    effectiveModel = 'deepseek';
    console.log('[DeepAnalysis] 无实拍图，强制从 glm4v 降级到 deepseek-chat');
  }
  
  // 根据模型选择接口
  let response: string;
  switch (effectiveModel) {
    case 'deepseek':
      if (!deepSeekKey) throw new Error('未配置 DeepSeek API Key');
      console.log('[DeepAnalysis] 调用 callDeepSeekTextOnly (纯文本模式)');
      response = await callDeepSeekTextOnly(prompt, deepSeekKey);
      break;
    case 'glm4v':
      if (!glmKey) throw new Error('未配置 GLM API Key');
      response = await callGLMVision(prompt, glmKey, visionImages);
      break;
    case 'openai':
      if (!config.apiKey) throw new Error('未配置通用 API Key');
      response = await callOpenAIVision(prompt, config.apiKey, visionImages, 'https://api.openai.com/v1');
      break;
    case 'qwen':
      if (!config.apiKey) throw new Error('未配置通用 API Key');
      response = await callOpenAIVision(prompt, config.apiKey, visionImages, 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen-vl-max');
      break;
    case 'claude':
      if (!config.apiKey) throw new Error('未配置通用 API Key');
      response = await callClaudeVision(prompt, config.apiKey, visionImages);
      break;
    case 'gemini':
      if (!config.apiKey) throw new Error('未配置通用 API Key');
      response = await callGeminiVision(prompt, config.apiKey, visionImages);
      break;
    case 'custom':
      if (!config.apiBase) throw new Error('自定义模型需要填写 API Base URL');
      if (!config.apiKey) throw new Error('未配置通用 API Key');
      response = await callOpenAIVision(prompt, config.apiKey, visionImages, config.apiBase);
      break;
    default:
      // fallback：DeepSeek 文本分析（无图）
      if (!deepSeekKey) throw new Error('未配置 DeepSeek API Key');
      response = await callDeepSeekDeep(prompt, deepSeekKey);
      break;
  }
  
  console.log('[DeepAnalysis] response 前1000字:', response.slice(0, 1000));
  console.log('[DeepAnalysis] response 总长度:', response.length);
  
  return response;
}

// ── 构建精筛提示词 ────────────────────────────────────────────
function buildDeepAnalysisPrompt(
  listing: Listing,
  prefs: UserPrefs,
  pageContent?: string,
  pageExtras?: PageExtractExtras,
  imageAnalysisText?: string,
): string {
  const pageText = typeof pageContent === 'string' ? pageContent : '';
  const cachedDetail = (listing.detailDescription || '').trim();
  const effectivePageText = pageText.trim().length > 50
    ? pageText
    : (cachedDetail.length > 50 ? cachedDetail : pageText);
  const fac = (pageExtras?.facilities || []).filter(Boolean);
  const extraLines: string[] = [];
  if (fac.length > 0) {
    extraLines.push(`【页面中出现的设施相关词（脚本抽取）】${fac.join('、')}`);
  }
  if ((pageExtras?.imageUrls || []).length > 0) {
    extraLines.push('【配图】已尝试将页面内部分图片随多模态请求一并提交；若为纯文本通道请以上方页面正文为准。');
  }
  const extrasBlock = extraLines.length > 0 ? `\n${extraLines.join('\n')}\n` : '';
  const imageBlock = imageAnalysisText ? `\n【GLM-4V 实拍图分析报告】\n${imageAnalysisText}\n` : '';

  const pageSection = effectivePageText.trim().length > 50
    ? `${extrasBlock}${imageBlock}\n【房源原始页面内容（从平台实际抓取，优先以此为准）】\n${effectivePageText.trim().slice(0, 4000)}\n`
    : extrasBlock.trim().length > 0
      ? `${extrasBlock}\n`
      : '';

  return `你是专业的租房顾问，请对以下房源进行深度分析。

房源信息：
标题：${listing.title}
位置：${listing.district} · ${listing.community}
户型：${listing.roomType}　面积：${listing.area}　楼层：${listing.floor}
价格：${listing.price} 元/月
标签：${listing.tags.join('、') || '无'}
链接：${listing.url || '无'}

【用户偏好】
预算：${prefs.budgetMin || '不限'} - ${prefs.budgetMax || '不限'} 元/月
通勤地址：${prefs.commuteAddr || '未设置'}
近地铁：${prefs.needSubway ? '要' : '不限'}
可养宠：${prefs.needPets ? '要' : '不限'}
其他要求：${prefs.otherReqs || '无'}
${pageSection}${imageBlock ? `\n${imageBlock}` : ''}

请按以下格式输出分析报告（使用 Markdown）：

## 综合评分：X.X / 10

### 评分依据
从价格合理性、地理位置、房屋条件、配套设施4个维度说明评分理由，每点1-2句话。

### ✅ 优点
- 列出3-5个具体优点，结合房源数据说明

### ⚠️ 缺点与风险
- 列出2-4个具体缺点或风险点，给出建议

### 💰 价格分析
结合周边行情，判断价格是否合理，是否有议价空间。

### 🏠 居住建议
适合什么类型的租客，有什么特别需要注意的事项。

要求：
- 分析要具体，引用房源中的实际数据（价格、面积、楼层等）
- 不要泛泛而谈，每个观点都要有依据
- 如果没有实拍图，在报告开头注明"本次分析基于文字信息，建议实地看房确认"
- 若提供了图片分析报告，必须以图片分析为客观依据来评估采光、装修新旧、设施状况
- 若提供了原始页面内容，优先根据真实页面分析
- 识别租房常见话术陷阱（如"随时看房"暗示空置已久、"精装修"可能墙壁遮丑等）`;
}

// ── 聊天助手调用 ──────────────────────────────────────────────
export async function chatWithAssistant(
  messages: ChatMessage[],
  userPrefs: UserPrefs
): Promise<string> {
  const config = await getApiConfig();
  const deepSeekKey = resolveDeepSeekKey(config);
  if (!deepSeekKey) {
    throw new Error('未配置 DeepSeek API Key，请前往「我的」页面配置。');
  }

  const systemPrompt = `你是 RentSmart AI，一个专业的租房顾问。
你的任务是帮助用户解答租房问题、避坑、或者分析用户提供的房源信息。

【当前用户的偏好设置】
- 预算：${userPrefs.budgetMin || '不限'} - ${userPrefs.budgetMax || '不限'} 元/月
- 租房方式：${userPrefs.rentMode}
- 位置偏好：${userPrefs.district || '不限'}
- 通勤地址：${userPrefs.commuteAddr || '未设置'}
- 近地铁：${userPrefs.needSubway ? '需要' : '不限'}
- 可养宠：${userPrefs.needPets ? '需要' : '不限'}
- 其他要求：${userPrefs.otherReqs || '无'}

【链接解析说明】
如果用户发送了房源链接，请尽量根据链接的域名（如贝壳、安居客等）和 URL 参数给出一些常识性判断。如果你无法直接联网读取链接内容，请礼貌地告诉用户：“我暂时无法直接读取这个链接的内容，您可以将房源页面的文字复制给我，或者截图发给我，我会为您详细分析隐藏的坑。”`;

  // 最多保留最近 20 轮对话上下文（user+assistant 共最多 40 条）
  const recentConversation = messages.slice(-40);
  const apiMessages = [
    { role: 'system', content: systemPrompt },
    ...recentConversation,
  ];

  try {
    // 根据配置选用模型，默认使用配置的 textModel，目前主要是 deepseek 或 custom
    let baseUrl = DEEPSEEK_BASE;
    let model = DEEPSEEK_MODEL;
    let apiKey = deepSeekKey;

    if (config.textModel === 'custom' && config.apiBase) {
      baseUrl = config.apiBase;
      model = 'gpt-4o'; // 假设自定义接口兼容此模型名，或可从某处配置
    }

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model,
        messages: apiMessages,
        temperature: 0.7,
        max_tokens: 1500,
      }),
    });

    if (!res.ok) {
      throw new Error(`API 错误 (${res.status})`);
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content || '抱歉，我没有生成回复，请重试。';
  } catch (error: any) {
    console.error('聊天助手失败:', error);
    throw new Error(error.message || '网络请求失败');
  }
}

/** 从分享海报图中抽取的结构化字段（供写入历史与详情页） */
export type PosterExtractFields = {
  title: string;
  price: number;
  community: string;
  district: string;
  roomType: string;
  area: string;
  floor: string;
  tags: string[];
  platform: string;
  /** OCR 从文字识别到的链接（可能不完整） */
  url: string;
  /** 二维码解码得到的真实链接（优先使用） */
  qrUrl?: string;
  cityCode?: string;
};

function parseJsonObjectFromModelText(raw: string): Record<string, unknown> | null {
  const cleaned = raw
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 海报 OCR 常见假链：如 https://wh.ke.com/zufang/479967，真分享链通常更长或含房源编码、.html 等 */
export function isLikelyInvalidBeikePosterUrl(url: string | undefined): boolean {
  if (!url || typeof url !== 'string') return false;
  const u = url.trim().toLowerCase();
  if (!u.includes('ke.com')) return false;
  try {
    const parsed = new URL(u.startsWith('http') ? u : `https://${u}`);
    const path = parsed.pathname.replace(/\/+$/, '');
    // 仅「/zufang/若干位数字」多为模型臆造；真实链接常有城市、长 id、.html 等
    return /^\/zufang\/\d{1,10}$/i.test(path);
  } catch {
    return true;
  }
}

function normalizePosterListingUrl(raw: string, platform: string): string {
  const u = String(raw || '').trim();
  if (!u) return '';
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith('//')) return `https:${u}`;
  const p = platform.toLowerCase();
  if (p === 'beike' || p === 'ke') {
    if (u.startsWith('/')) return `https://m.ke.com${u}`;
  }
  if (p === 'anjuke') {
    if (u.startsWith('/')) return `https://m.anjuke.com${u}`;
  }
  return u;
}

/**
 * 使用 GLM-4V 从海报图中抽取一套房源信息（需配置智谱 GLM Key）。
 */
export async function extractListingFromPosterImage(imageDataUrl: string): Promise<PosterExtractFields> {
  console.log('[extractPoster] 开始处理:', {
    dataUrlPrefix: imageDataUrl.slice(0, 50),
    dataUrlLength: imageDataUrl.length,
  });

  const config = await getApiConfig();
  const glmKey = resolveGLMKey(config);
  if (!glmKey) {
    throw new Error('未配置 GLM API Key，请在「我的」中填写智谱 Key');
  }

  const prompt = `你是 OCR+结构化抽取助手。用户上传的是国内租房平台（贝壳、安居客、自如、冠寓等）的分享海报或截图。
请识别图中**唯一主推**的那套房源（若多套只取海报主标题对应的一套），严格输出**一个** JSON 对象，不要 markdown 围栏、不要任何解释文字。

【重点识别要求】
1. 平台识别：仔细查看图片左上角、底部、二维码附近的 logo 或文字（"贝壳找房"、"ke.com"、"安居客"、"anjuke"、"自如"等）
2. 二维码解码（最重要）：仔细观察图中的二维码图案，尝试**解码其中包含的房源页面链接**，填入 qrUrl 字段。注意：qrUrl 应该是房源详情页链接（如 https://wh.ke.com/zufang/xxx），**不是二维码图片本身的 URL**（如 .png/.jpg 图片链接）。若无法解码或图中无二维码，qrUrl 填空字符串。
3. 文字链接识别：只填写图中**清晰可见**的完整 http(s) 文字链接。**禁止凭想象拼凑**如「https://xx.ke.com/zufang/纯数字」；若无法确认完整性，**url 填空字符串**。

字段与类型如下：
{
  "title": "房源主标题",
  "price": 月租金数字（纯数字，如 1600，不带单位）,
  "community": "小区名或楼盘名",
  "district": "行政区或片区，如 东湖高新区、朝阳区",
  "roomType": "如 2室1厅、一居室",
  "area": "如 68㎡ 或 68平米",
  "floor": "楼层描述，没有则空字符串",
  "tags": ["标签1","标签2"],
  "platform": "beike / anjuke / ziroom / guanyu / unknown 之一（根据实际logo判断）",
  "url": "图中文字可见的完整 http(s) 房源链接；没有或不确定则空字符串",
  "qrUrl": "二维码解码得到的完整链接；无法识别则空字符串",
  "cityCode": "从链接或文案可判断时填城市简码如 bj/sh/wh，否则省略该字段"
}
规则：price 须在 300～50000 之间方有效，否则填 0；无法辨认的字符串字段用空字符串；tags 最多 8 个。`;

  const raw = await callGLMVision(prompt, glmKey, [imageDataUrl], { temperature: 0.15, maxTokens: 1200 });
  console.log('[extractPoster] GLM 原始返回:', raw.slice(0, 800));
  
  const obj = parseJsonObjectFromModelText(raw);
  if (!obj) {
    console.error('[extractPoster] JSON 解析失败，原始文本:', raw);
    throw new Error('模型返回无法解析为 JSON，请换一张更清晰的海报重试');
  }
  
  console.log('[extractPoster] 解析后的对象:', JSON.stringify(obj, null, 2));

  // 提取价格数字（可能是 "1600元/月" 或 1600）
  let price = 0;
  const priceRaw = String(obj.price || '');
  const priceMatch = priceRaw.match(/(\d+)/);
  if (priceMatch) {
    price = Math.round(Number(priceMatch[1]));
  }
  const tags = Array.isArray(obj.tags)
    ? obj.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 8)
    : [];

  const platformRaw = String(obj.platform || 'unknown').toLowerCase();
  let platform = 'unknown';
  if (platformRaw.includes('beike') || platformRaw.includes('贝壳') || platformRaw.includes('ke')) platform = 'beike';
  else if (platformRaw.includes('anjuke') || platformRaw.includes('安居客')) platform = 'anjuke';
  else if (platformRaw.includes('ziroom') || platformRaw.includes('自如')) platform = 'ziroom';
  else if (platformRaw.includes('guanyu') || platformRaw.includes('冠寓')) platform = 'guanyu';

  const ocrUrl = normalizePosterListingUrl(String(obj.url || ''), platform);
  const qrRaw = String(obj.qrUrl || '').trim();
  // 排除二维码图片 URL（.png/.jpg 结尾），只接受房源页面链接
  const qrUrl = /^https?:\/\/.{10,}/.test(qrRaw) && !/\.(png|jpg|jpeg|gif)$/i.test(qrRaw) ? qrRaw : '';

  console.log('[extractPoster] URL 汇总:', { ocrUrl, qrUrl, priceRaw: obj.price, priceExtracted: price });

  return {
    title: String(obj.title || '').trim() || '海报房源',
    price: price >= 300 && price <= 50000 ? price : 0,
    community: String(obj.community || '').trim(),
    district: String(obj.district || '').trim(),
    roomType: String(obj.roomType || '').trim() || '未知',
    area: String(obj.area || '').trim() || '未知',
    floor: String(obj.floor || '').trim() || '未知',
    tags,
    platform,
    url: ocrUrl,
    qrUrl: qrUrl || undefined,
    cityCode: obj.cityCode ? String(obj.cityCode).trim().toLowerCase() : undefined,
  };
}


// GLM-4-Flash 纯文本调用（导出供其他模块使用）
export async function callGLM(
  prompt: string,
  opts?: { temperature?: number; maxTokens?: number }
): Promise<string> {
  const config = await getApiConfig();
  const apiKey = resolveGLMKey(config);
  
  if (!apiKey) {
    throw new Error('未配置 GLM API Key');
  }
  
  try {
    const response = await fetch(`${GLM_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: GLM_MODEL,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: opts?.temperature ?? 0.7,
        max_tokens: opts?.maxTokens ?? 2000,
      }),
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('[GLM] API Error:', response.status, errorText);
      throw new Error(`GLM API 调用失败: ${response.status}`);
    }
    
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    
    if (!content) {
      throw new Error('GLM 返回内容为空');
    }
    
    return content;
  } catch (error) {
    console.error('[GLM] Error:', error);
    throw error;
  }
}

// GLM-4V-Flash（智谱）
export async function callGLMVision(
  prompt: string,
  apiKey: string,
  images?: string[],
  opts?: { temperature?: number; maxTokens?: number },
): Promise<string> {
  const messages: any[] = [];
  
  if (images && images.length > 0) {
    const content: any[] = [{ type: 'text', text: prompt }];
    images.slice(0, 4).forEach(img => {
      // ★ 修复：GLM-4V 需要完整的 data URL 格式或 HTTP(S) URL
      let imageUrl = img;
      
      // 如果是 HTTP(S) URL，直接使用
      if (img.startsWith('http://') || img.startsWith('https://')) {
        imageUrl = img;
      }
      // 如果已经是完整的 data URL，直接使用
      else if (img.startsWith('data:image/')) {
        imageUrl = img;
      }
      // 如果是纯 base64，添加 data URL 前缀
      else {
        imageUrl = `data:image/jpeg;base64,${img}`;
      }
      
      content.push({ type: 'image_url', image_url: { url: imageUrl } });
    });
    messages.push({ role: 'user', content });
  } else {
    messages.push({ role: 'user', content: prompt });
  }

  const temperature = typeof opts?.temperature === 'number' ? opts.temperature : 0.7;
  const max_tokens = typeof opts?.maxTokens === 'number' ? opts.maxTokens : 1000;
  
  // 注意：glm-4v-flash 不支持 base64，必须用 glm-4v（付费）才支持
  const requestBody = {
    model: images?.length ? 'glm-4v' : GLM_MODEL,
    messages,
    temperature,
    max_tokens,
  };

  const firstMsg = messages[0];
  const contentType = Array.isArray(firstMsg?.content) ? 'array' : typeof firstMsg?.content;
  
  // 增强日志：记录图片格式信息
  if (images && images.length > 0) {
    console.log('[GLM] 图片信息:', images.map((img, idx) => ({
      index: idx,
      type: img.startsWith('http') ? 'URL' : img.startsWith('data:') ? 'DataURL' : 'Base64',
      prefix: img.substring(0, 50),
      length: img.length,
    })));
  }
  
  console.log('[GLM] 请求信息:', {
    model: requestBody.model,
    messageCount: messages.length,
    hasImages: images && images.length > 0,
    imageCount: images?.length || 0,
    contentType,
    firstContent: Array.isArray(firstMsg?.content) 
      ? firstMsg.content.map((c: any) => c.type).join(',')
      : String(firstMsg?.content || '').slice(0, 50),
  });

  const res = await fetch(`${GLM_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(requestBody),
  });
  
  if (!res.ok) {
    const errorText = await res.text();
    
    // 尝试解析错误响应
    let errorDetail = errorText;
    try {
      const errorJson = JSON.parse(errorText);
      errorDetail = JSON.stringify(errorJson, null, 2);
      
      // 特别处理图片格式错误
      if (errorJson.error?.code === '1210' || errorJson.error?.code === '12210') {
        console.error('[GLM] 图片格式错误！请检查图片数据格式');
        console.error('[GLM] 图片数据示例:', images?.map(img => img.substring(0, 100)));
      }
    } catch {
      // 如果不是 JSON，使用原始文本
    }
    
    console.error('[GLM] API 错误响应:', {
      status: res.status,
      statusText: res.statusText,
      body: errorDetail.slice(0, 500),
    });
    
    throw new Error(`GLM API 错误 ${res.status}: ${errorDetail.slice(0, 200)}`);
  }
  
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || '{}';
  
  console.log('[GLM] 响应成功，内容长度:', content.length);
  
  return content;
}

// OpenAI 兼容接口（GPT-4o / 千问 / 自定义）
async function callOpenAIVision(
  prompt: string,
  apiKey: string,
  images?: string[],
  baseUrl = 'https://api.openai.com/v1',
  model = 'gpt-4o'
): Promise<string> {
  const messages: any[] = [];
  
  if (images && images.length > 0) {
    const content: any[] = [{ type: 'text', text: prompt }];
    images.slice(0, 4).forEach(img => {
      content.push({ type: 'image_url', image_url: { url: img, detail: 'low' } });
    });
    messages.push({ role: 'user', content });
  } else {
    messages.push({ role: 'user', content: prompt });
  }
  
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, messages, temperature: 0.7, max_tokens: 1000 }),
  });
  
  if (!res.ok) throw new Error(`OpenAI API 错误: ${res.status}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '{}';
}

// Claude（Anthropic）
async function callClaudeVision(
  prompt: string,
  apiKey: string,
  images?: string[]
): Promise<string> {
  const content: any[] = [];
  
  if (images && images.length > 0) {
    for (const img of images.slice(0, 4)) {
      // Claude 需要 base64，URL 图片需转换；此处先只做 URL 路径
      content.push({ type: 'text', text: `[图片: ${img}]` });
    }
  }
  content.push({ type: 'text', text: prompt });
  
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 1000,
      messages: [{ role: 'user', content }],
    }),
  });
  
  if (!res.ok) throw new Error(`Claude API 错误: ${res.status}`);
  const data = await res.json();
  return data.content?.[0]?.text || '{}';
}

// Gemini（Google）
async function callGeminiVision(
  prompt: string,
  apiKey: string,
  images?: string[]
): Promise<string> {
  const parts: any[] = [{ text: prompt }];
  
  if (images && images.length > 0) {
    for (const img of images.slice(0, 4)) {
      parts.push({ text: `图片来源: ${img}` });
    }
  }
  
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts }] }),
    }
  );
  
  if (!res.ok) throw new Error(`Gemini API 错误: ${res.status}`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
}

// ── 砍价话术 ─────────────────────────────────────────────────
export type BargainCategory = 'time' | 'price' | 'problem' | 'urgency' | 'condition';

export type BargainScript = {
  category: BargainCategory;
  title: string;
  script: string;
  tip?: string;
};

const BARGAIN_CATEGORY_LABELS: Record<BargainCategory, string> = {
  time: '时间类',
  price: '价格类',
  problem: '问题类',
  urgency: '时效类',
  condition: '条件类',
};

export function getBargainCategoryLabel(cat: BargainCategory): string {
  return BARGAIN_CATEGORY_LABELS[cat] ?? cat;
}

/**
 * 用 GLM-4V 分析房源实拍图，生成精筛可用的结构化图文报告
 */
export async function summarizeListingImagesForDeepAnalysis(
  listing: Listing,
  imageUrls: string[],
): Promise<string> {
  const config = await getApiConfig();
  const glmKey = resolveGLMKey(config);
  const urls = imageUrls.filter(u => /^https?:\/\//i.test(String(u))).slice(0, 4);
  if (!glmKey || urls.length === 0) return '';

  const prompt = `你是专业租房评估师。以下是「${listing.community}」${listing.roomType} 出租房源的实拍图（${urls.length} 张）。
请以结构化文本输出（用于精筛报告），包含：
1. 亮点：图片中可见的显著优势（采光好、装修新、空间利用等）
2. 缺点：图片中可见的问题（墙壁瑕疵、管道老化、拥挤等）
3. 风险：可能隐含的问题（如光线异常暗示朝向差、新粉刷可能遮丑）
4. 与描述一致性：参考文字描述「${listing.detailDescription ? listing.detailDescription.slice(0, 300) : (listing.title || '无')}」，评估图片是否与描述匹配
每段15-40字，总计不超过150字。只描述图中可见内容，不编造。`;

  try {
    return (await callGLMVision(prompt, glmKey, urls, { temperature: 0.2, maxTokens: 500 })).trim();
  } catch {
    return '';
  }
}

/**
 * 用 GLM-4V 分析房源实拍图，生成砍价可用的图文摘要
 */
export async function summarizeListingImagesForBargain(
  listing: Listing,
  imageUrls: string[],
): Promise<string> {
  const config = await getApiConfig();
  const glmKey = resolveGLMKey(config);
  const urls = imageUrls.filter(u => /^https?:\/\//i.test(String(u))).slice(0, 4);
  if (!glmKey || urls.length === 0) return '';

  const prompt = `你是租房顾问。以下是「${listing.community}」${listing.roomType} 出租房源的实拍图（${urls.length} 张）。
请简要列出从图片可见的亮点与潜在问题（装修新旧、采光、整洁度、设施状况等），200 字以内，供生成砍价话术参考。不要编造图片中看不到的内容。`;

  try {
    return (await callGLMVision(prompt, glmKey, urls, { temperature: 0.25, maxTokens: 450 })).trim();
  } catch {
    return '';
  }
}

/**
 * 根据房源信息，用 DeepSeek 生成 5 类砍价话术（每类 1 条）。
 * 若有详情图且配置了 GLM Key，会先进行图片分析。
 */
export async function generateBargainScripts(
  listing: Listing,
  prefs: UserPrefs,
  onProgress?: (hint: string) => void,
): Promise<BargainScript[]> {
  const config = await getApiConfig();
  const deepSeekKey = resolveDeepSeekKey(config);
  if (!deepSeekKey) {
    throw new Error('未找到可用 DeepSeek Key，请在「我的」页面配置');
  }

  // 优先使用真实挂牌天数提示，次选首次抓取估算
  const listedDaysText = listing.listedDaysHint
    || (listing.scrapedAt
      ? `约 ${Math.max(1, Math.floor((Date.now() - new Date(listing.scrapedAt).getTime()) / 86400000))} 天前首次抓取（非真实挂牌时长，仅供参考）`
      : '未知');

  // 整合设施信息（listing.facilities 优先，无则尝试从 tags 补充）
  const facilityList = (listing.facilities && listing.facilities.length > 0)
    ? listing.facilities
    : listing.tags.filter(t => /空调|冰箱|洗衣机|热水器|燃气|暖气|电梯|宽带|衣柜|沙发|阳台/.test(t));

  let imageVisionSummary = '';
  const detailImages = (listing.detailImages || []).filter(u => /^https?:\/\//i.test(String(u)));
  if (detailImages.length > 0) {
    onProgress?.('正在分析图片…');
    imageVisionSummary = await summarizeListingImagesForBargain(listing, detailImages);
  }

  onProgress?.('正在生成话术…');

  const prompt = `你是一位经验丰富的租房老手，帮朋友出主意怎么跟房东谈价。请根据以下房源信息，生成 5 条**接地气、有人味**的砍价话术，每类一条。

【房源基本信息】
标题：${listing.title}
小区：${listing.community}（${listing.district}）
户型面积：${listing.roomType} / ${listing.area}
楼层：${listing.floor || '未知'}
挂牌价：${listing.price} 元/月
标签：${listing.tags.join('、') || '无'}
已识别设施：${facilityList.length > 0 ? facilityList.join('、') : '未获取'}
AI 初评：${listing.aiComment || '无'}
挂牌时长参考：${listedDaysText}
${detailImages.length > 0 ? `实拍图数量：${detailImages.length} 张` : ''}
${listing.detailDescription
  ? `\n【详情页正文摘要（前 800 字）】\n${listing.detailDescription.slice(0, 800)}`
  : ''}
${imageVisionSummary ? `\n【实拍图 AI 分析（GLM-4V）】\n${imageVisionSummary}` : ''}

【租客背景】
预算：${prefs.budgetMin || '不限'} - ${prefs.budgetMax || '不限'} 元/月
通勤地址：${prefs.commuteAddr || '未设置'}

请严格以 JSON 数组格式返回，包含 5 个对象，category 分别为 time/price/problem/urgency/condition：
[
  { "category": "time", "title": "时间类", "script": "话术内容（第一人称，自然口吻）", "tip": "使用时机提示（可选）" },
  { "category": "price", "title": "价格类", "script": "...", "tip": "..." },
  { "category": "problem", "title": "问题类", "script": "...", "tip": "..." },
  { "category": "urgency", "title": "时效类", "script": "...", "tip": "..." },
  { "category": "condition", "title": "条件类", "script": "...", "tip": "..." }
]

要求：
- 话术要结合该房源的真实字段（价格、小区、户型、设施、详情），不要泛泛而谈
- 若有详情正文或图片分析，优先利用其中的具体信息来找砍价点
- **语气要自然、真诚、接地气**，像真实租客跟房东聊天的口吻，可以适当使用"这个""有点""感觉""其实"等自然表达
- 避免过于正式的书面语，不要像商务谈判或官方文件
- 可以委婉表达顾虑，但要保持礼貌和诚意，不要咄咄逼人
- 每条话术要有具体理由支撑，不要空洞套话
- script 每条 50–90 字
- 只返回 JSON 数组，不要其他文字`;

  const res = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${deepSeekKey}`,
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages: [
        { role: 'system', content: '你是经验丰富的租房老手，帮朋友出主意怎么跟房东谈价。只输出纯 JSON 数组，不要 markdown 围栏。话术要自然、真诚、接地气，像真实租客跟房东聊天的口吻。' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.6,
      max_tokens: 1200,
    }),
  });

  if (!res.ok) throw new Error(`砍价话术生成失败：${res.status}`);
  const data = await res.json();
  const content: string = data.choices?.[0]?.message?.content || '[]';

  const cleaned = content.replace(/```json/gi, '').replace(/```/g, '').trim();
  const arrMatch = cleaned.match(/\[[\s\S]*\]/);
  if (!arrMatch) throw new Error('AI 返回格式异常，请重试');

  let parsed: BargainScript[];
  try {
    parsed = JSON.parse(arrMatch[0]) as BargainScript[];
  } catch {
    throw new Error('解析砍价话术失败，请重试');
  }

  const validCategories: BargainCategory[] = ['time', 'price', 'problem', 'urgency', 'condition'];
  return parsed.filter(
    (s) => s && typeof s.script === 'string' && validCategories.includes(s.category as BargainCategory),
  );
}

// DeepSeek 文本版精筛（无图降级）- 保留旧函数名以兼容其他调用
async function callDeepSeekDeep(prompt: string, apiKey: string): Promise<string> {
  return await callDeepSeekTextOnly(prompt, apiKey);
}

// DeepSeek 纯文本模型调用（精筛专用）
async function callDeepSeekTextOnly(prompt: string, apiKey: string): Promise<string> {
  if (!apiKey) throw new Error('未配置 DeepSeek API Key，请前往「我的」页面配置。');
  
  console.log('[DeepSeekTextOnly] 开始调用 deepseek-chat');
  console.log('[DeepSeekTextOnly] API Base:', DEEPSEEK_BASE);
  console.log('[DeepSeekTextOnly] Model:', DEEPSEEK_MODEL);
  
  const res = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages: [
        { role: 'system', content: '你是专业租房顾问，擅长识别租房陷阱和评估房源。请以 Markdown 格式输出详细分析报告。' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.7,
      max_tokens: 2000,
    }),
  });
  
  console.log('[DeepSeekTextOnly] Response status:', res.status);
  
  if (!res.ok) {
    const errorText = await res.text();
    console.error('[DeepSeekTextOnly] API 错误:', errorText);
    throw new Error(`DeepSeek API 错误: ${res.status}`);
  }
  
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || '# 分析报告\n\n生成失败，请重试。';
  
  console.log('[DeepSeekTextOnly] Response length:', content.length);
  console.log('[DeepSeekTextOnly] Response preview:', content.slice(0, 200));
  
  return content;
}
