import { getAgentContext, type AgentContext } from './agent-context';
import { consumeAgentListingExcludeIds } from './agent-search-context';
import { extractListingFromPosterImage, generateBargainScripts } from './api';
import { calculateCommute } from './geo';
import { ensureListingEnriched } from './listing-enrich';
import { isLegalQuestion, searchLegalKB } from './rag';
import { generateListingId, type ScrapedListing } from './scraper';
import { addToHistory, getApiConfig, getFavoriteFolders, getFolderListings, getHistory, getPrefs, upsertHistoryListings, type Listing } from './storage';

type JSONSchema = {
  type: string;
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  items?: unknown;
};

type AgentToolExecute = (params: Record<string, unknown>) => Promise<unknown>;

export type AgentTool = {
  name: string;
  description: string;
  parameters: JSONSchema;
  execute: AgentToolExecute;
};

function buildMockListings() {
  const now = new Date().toISOString();
  return [
    {
      id: 'demo-1',
      title: '望京·精装一居',
      community: '望京花园',
      price: 5600,
      district: '朝阳区',
      roomType: '1室1厅',
      area: '48㎡',
      floor: '中楼层',
      tags: ['近地铁', '精装修'],
      hasSubway: true,
      hasPets: false,
      isWhole: true,
      aiScore: 8.4,
      aiComment: '通勤友好，性价比较高',
      cityCode: 'bj',
      platform: 'anjuke',
      url: 'https://m.anjuke.com/bj/rent/placeholder',
      scrapedAt: now,
    },
    {
      id: 'demo-2',
      title: '徐汇·地铁口两居',
      community: '徐家汇公寓',
      price: 7800,
      district: '徐汇区',
      roomType: '2室1厅',
      area: '72㎡',
      floor: '高楼层',
      tags: ['近地铁', '可养宠'],
      hasSubway: true,
      hasPets: true,
      isWhole: true,
      aiScore: 7.8,
      aiComment: '配套成熟，价格偏高',
      cityCode: 'sh',
      platform: 'beike',
      url: 'https://sh.ke.com/zufang/placeholder',
      scrapedAt: now,
    },
  ] as Listing[];
}

function buildMockCompareReport() {
  return {
    summary: '已对比分析所选房源的核心指标，包括价格、户型、位置、配套等维度',
    recommendation: '综合考虑通勤便利性、租金性价比和生活配套，建议优先考虑近地铁且价格适中的房源',
    riskTips: [
      '签约前务必核验房屋产权证和房东身份',
      '明确押金金额、退还条件和时间',
      '确认中介服务费、物业费、水电费等费用分摊',
      '拍照记录房屋现状，避免退租纠纷'
    ],
  };
}

export const AGENT_TOOLS: AgentTool[] = [
  {
    name: 'get_user_context',
    description: '获取用户当前状态，包括偏好、收藏、历史分析和对比列表。',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
    execute: async (): Promise<{ context: AgentContext }> => {
      const context = await getAgentContext();
      return { context };
    },
  },
  {
    name: 'search_listings',
    description: '根据城市、预算、户型、区域、关键词和偏好条件检索房源，返回去重匹配列表。',
    parameters: {
      type: 'object',
      properties: {
        city: { type: 'string', description: '城市代码，如 bj/sh/gz/sz/wh/cd/hz/nj/xa/tj/cq/su/cs/qd/nb/km/hf/jn/sy/dl/fz/xm/zz/wx/cc/nc/nn/gy/hrb/sjz/ty/dg/fs/hk/hui/lz/zs/zh/nt/wz/yz' },
        budgetMin: { type: 'number', description: '预算下限，单位元/月' },
        budgetMax: { type: 'number', description: '预算上限，单位元/月' },
        roomType: { type: 'string', description: '户型偏好，如 1室/2室/一居/两居' },
        rentMode: { type: 'string', description: '租房方式：整租/合租/短租/公寓' },
        district: { type: 'string', description: '区域偏好，如 朝阳区/浦东新区/东湖高新区' },
        keywords: { type: 'string', description: '关键词，如 精装修/近地铁/靠窗/南向' },
        needSubway: { type: 'boolean', description: '是否要求近地铁' },
        needPets: { type: 'boolean', description: '是否要求可养宠' },
        minArea: { type: 'number', description: '最小面积（平方米）' },
        maxArea: { type: 'number', description: '最大面积（平方米）' },
      },
      required: [],
      additionalProperties: false,
    },
    execute: async (params): Promise<unknown> => {
      const history = await getHistory();
      const sourceList: Listing[] = history.length > 0 ? history : buildMockListings();

      const city = String(params?.city || '').trim();
      const budgetMin = Number(params?.budgetMin || 0);
      const budgetMax = Number(params?.budgetMax || 0);
      const roomType = String(params?.roomType || '').trim();
      const rentMode = String(params?.rentMode || '').trim();
      const district = String(params?.district || '').trim();
      const keywords = String(params?.keywords || '').trim();
      const needSubway = params?.needSubway === true;
      const needPets = params?.needPets === true;
      const minArea = Number(params?.minArea || 0);
      const maxArea = Number(params?.maxArea || 0);

      const parseArea = (areaStr: string): number => {
        const m = String(areaStr || '').match(/(\d+(\.\d+)?)/);
        return m ? parseFloat(m[1]) : 0;
      };

      const filtered = sourceList.filter((item) => {
        if (city && item.cityCode && item.cityCode !== city) return false;
        if (budgetMin > 0 && item.price < budgetMin) return false;
        if (budgetMax > 0 && item.price > budgetMax) return false;
        if (roomType && !`${item.roomType}${item.title}`.includes(roomType)) return false;
        if (district && !`${item.district}${item.community}`.includes(district)) return false;
        if (keywords) {
          const haystack = `${item.title}${item.tags.join('')}${item.aiComment}${item.community}`;
          if (!haystack.includes(keywords)) return false;
        }
        if (needSubway && !item.hasSubway) return false;
        if (needPets && !item.hasPets) return false;
        if (rentMode === '整租' && !item.isWhole) return false;
        if (rentMode === '合租' && item.isWhole) return false;
        if (rentMode === '短租' && !item.isShortTerm) return false;
        if (rentMode === '公寓' && !item.isApartment) return false;
        if (minArea > 0 || maxArea > 0) {
          const area = parseArea(item.area);
          if (minArea > 0 && area > 0 && area < minArea) return false;
          if (maxArea > 0 && area > 0 && area > maxArea) return false;
        }
        return true;
      });

      // 按指纹去重（URL 优先；无 URL 则 小区+价格+户型）
      const seen = new Set<string>();
      const deduped = filtered.filter((item) => {
        let fp: string;
        if (item.url && item.url.length > 10) {
          try {
            const u = new URL(item.url);
            fp = `${u.hostname}${u.pathname}`.toLowerCase().replace(/\/$/, '');
          } catch {
            fp = item.url.trim().toLowerCase();
          }
        } else {
          fp = [
            item.community?.trim().toLowerCase() || '',
            String(item.price),
            item.roomType?.trim().toLowerCase() || '',
          ].join('|');
        }
        if (seen.has(fp)) return false;
        seen.add(fp);
        return true;
      });

      const excludeIds = new Set(consumeAgentListingExcludeIds());
      const ranked = deduped.sort((a, b) => (b.aiScore || 0) - (a.aiScore || 0));
      const afterExclude =
        excludeIds.size > 0 ? ranked.filter((item) => !excludeIds.has(String(item.id))) : ranked;
      const sorted = afterExclude.slice(0, 5);

      // 若筛选+去重后为空，降级返回全部去重列表（最多3条），并说明
      let isEmpty = sorted.length === 0;
      let finalListings = sorted;

      if (isEmpty && excludeIds.size > 0) {
        return {
          listings: [],
          total: 0,
          filtered: true,
          hint: '暂无更多未推荐过的房源，可调整筛选条件或先在「找房」里抓取更多房源。',
        };
      }

      if (isEmpty) {
        finalListings = Array.from(
          new Map(
            sourceList.map((item) => [
              item.url
                ? item.url.trim().toLowerCase()
                : `${item.community}|${item.price}|${item.roomType}`,
              item,
            ])
          ).values()
        ).slice(0, 3);
      }

      // 把 mock 房源写入历史，确保点击卡片后详情页能找到
      if (history.length === 0 && finalListings.length > 0) {
        await addToHistory(finalListings).catch(() => {});
      }

      return {
        listings: finalListings,
        total: finalListings.length,
        filtered: !isEmpty,
        hint: isEmpty ? '未找到完全匹配的房源，以下为综合推荐' : undefined,
      };
    },
  },
  {
    name: 'search_legal_knowledge',
    description: '检索租房法律知识库，返回最相关的法律条款或实务建议片段。',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '法律问题，例如押金纠纷、违约责任等' },
      },
      required: ['question'],
      additionalProperties: false,
    },
    execute: async (params): Promise<unknown> => {
      const question = String(params?.question || '').trim();
      if (!question) {
        return { query: question, hits: [], reason: '问题为空' };
      }
      if (!isLegalQuestion(question)) {
        return { query: question, hits: [], reason: '非法律类问题，未触发法律知识库检索' };
      }
      const hits = await searchLegalKB(question);
      return {
        query: question,
        hits,
      };
    },
  },
  {
    name: 'analyze_house_photo',
    description: '分析上传的房屋环境照片，识别采光、装修质量、家具成色等风险点，给出综合评分。',
    parameters: {
      type: 'object',
      properties: {
        imageUrl: { type: 'string', description: '图片 URL 或 Base64 编码' },
        listingId: { type: 'string', description: '房源 ID（可选）' },
      },
      required: ['imageUrl'],
      additionalProperties: false,
    },
    execute: async (params): Promise<unknown> => {
      const imageUrl = String(params?.imageUrl || '').trim();
      if (!imageUrl) {
        return { success: false, error: '未提供图片数据' };
      }
      
      // ★ 检测模拟/测试 URL，避免调用真实 API
      if (imageUrl.includes('example.com') || imageUrl.includes('mock-')) {
        console.log('[analyze_house_photo] 检测到模拟 URL，返回模拟结果');
        return {
          success: true,
          findings: ['这是测试数据，实际使用时请提供真实图片'],
          score: 7.5,
          summary: '模拟分析结果（测试模式）',
          highlights: ['测试亮点'],
          risks: ['测试风险'],
        };
      }

      try {
        console.log('[analyze_house_photo] 开始分析图片');
        
        const config = await getApiConfig();
        
        // 检查是否配置了 GLM API Key（用于视觉分析）
        const glmKey = config.glmApiKey || config.apiKey || '';
        
        if (!glmKey) {
          return {
            success: false,
            error: '未配置 GLM API Key，无法进行图片分析。请在「我的」-「设置」中配置智谱 API Key。',
          };
        }

        // 构建分析提示词
        const prompt = `你是专业的房屋环境评估师。请仔细分析这张房屋照片，从以下维度进行评估：

1. **采光条件**：窗户朝向、自然光线、明暗程度
2. **装修质量**：墙面、地板、吊顶的新旧程度和完好度
3. **家具配置**：家具齐全度、成色、实用性
4. **空间布局**：空间利用率、拥挤程度
5. **卫生状况**：整洁度、是否有污渍或破损
6. **潜在风险**：墙面裂缝、管道老化、电线外露等安全隐患

请以 JSON 格式返回分析结果，包含以下字段：
{
  "findings": ["发现点1", "发现点2", "发现点3", ...],
  "score": 7.5,
  "summary": "一句话总结（30字以内）",
  "highlights": ["亮点1", "亮点2"],
  "risks": ["风险点1", "风险点2"]
}

要求：
- findings 包含 3-5 条具体发现，每条 20-40 字
- 基于图片中实际可见的内容进行分析，不要臆测
- findings 要具体、客观，避免模糊表述
- 评分要综合考虑各个维度（0-10分），合理反映房屋状况
- 如果图片模糊或信息不足，在 summary 中说明`;

        // 动态导入 API 函数
        const apiModule = await import('./api');
        const callGLMVision = apiModule.callGLMVision || (apiModule as any).default?.callGLMVision;
        
        if (!callGLMVision) {
          throw new Error('GLM Vision API 函数不可用');
        }

        // 处理图片数据格式
        let processedImageUrl = imageUrl;
        
        // 如果是 base64 但没有 data URL 前缀，添加前缀
        if (!imageUrl.startsWith('http') && !imageUrl.startsWith('data:')) {
          // 检测是否是纯 base64
          if (/^[A-Za-z0-9+/=]+$/.test(imageUrl.substring(0, 100))) {
            processedImageUrl = `data:image/jpeg;base64,${imageUrl}`;
            console.log('[analyze_house_photo] 添加 data URL 前缀');
          }
        }
        
        console.log('[analyze_house_photo] 图片格式:', processedImageUrl.substring(0, 50));

        // 调用 GLM-4V 进行图片分析
        const rawResponse = await callGLMVision(prompt, glmKey, [processedImageUrl], {
          temperature: 0.3,
          maxTokens: 800,
        });

        console.log('[analyze_house_photo] GLM 原始响应:', rawResponse.slice(0, 500));

        // 解析 JSON 响应
        const cleaned = rawResponse
          .replace(/```json/gi, '')
          .replace(/```/g, '')
          .trim();
        const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
        
        if (!jsonMatch) {
          console.error('[analyze_house_photo] 无法解析 JSON:', rawResponse);
          return {
            success: false,
            error: '图片分析返回格式异常，请重试',
          };
        }

        const result = JSON.parse(jsonMatch[0]);
        
        // 验证必需字段
        if (!Array.isArray(result.findings) || typeof result.score !== 'number') {
          console.error('[analyze_house_photo] 缺少必需字段:', result);
          return {
            success: false,
            error: '图片分析结果不完整，请重试',
          };
        }

        console.log('[analyze_house_photo] 分析成功:', {
          findingsCount: result.findings.length,
          score: result.score,
        });

        return {
          success: true,
          findings: result.findings,
          score: Math.min(10, Math.max(0, result.score)),
          summary: result.summary || '分析完成',
          highlights: result.highlights || [],
          risks: result.risks || [],
        };
      } catch (e: unknown) {
        console.error('[analyze_house_photo] 分析失败:', e);
        return {
          success: false,
          error: e instanceof Error ? e.message : '图片分析失败，请重试',
        };
      }
    },
  },
  {
    name: 'extract_listing_from_poster',
    description: '从贝壳等平台的分享海报图片中提取房源信息。支持识别海报中的标题、价格、小区、区域、户型、面积等关键信息。',
    parameters: {
      type: 'object',
      properties: {
        imageBase64: { type: 'string', description: '图片的 Base64 编码（data:image/jpeg;base64,... 格式）' },
        imageUrl: { type: 'string', description: '图片 URL（与 imageBase64 二选一）' },
      },
      additionalProperties: false,
    },
    execute: async (params): Promise<unknown> => {
      const imageData = params?.imageBase64 || params?.imageUrl;

      if (!imageData || typeof imageData !== 'string') {
        return { success: false, error: '未提供图片数据' };
      }

      try {
        const dataUrl = imageData.startsWith('data:')
          ? imageData
          : `data:image/jpeg;base64,${imageData}`;

        const extracted = await extractListingFromPosterImage(dataUrl);
        if (!extracted.price) {
          return { success: false, error: '未能识别有效月租金，请确保海报含价格且清晰' };
        }
        // 优先使用二维码解码得到的真实链接
        const bestUrl = extracted.qrUrl || extracted.url || '';

        const prefs = await getPrefs();
        const tags = [...extracted.tags];
        const hasSubway = tags.some((t) => /地铁|轨道交通/.test(t));
        const hasPets = tags.some((t) => /宠物|养宠/.test(t));

        const scraped: ScrapedListing = {
          title: extracted.title,
          price: extracted.price,
          community: extracted.community || '未知小区',
          district: extracted.district || '未知',
          roomType: extracted.roomType,
          area: extracted.area,
          floor: extracted.floor,
          tags,
          url: bestUrl,
          platform: extracted.platform === 'unknown' ? 'beike' : extracted.platform,
        };

        const listing: Listing = {
          id: generateListingId(scraped),
          title: scraped.title,
          price: scraped.price,
          community: scraped.community,
          district: scraped.district,
          roomType: scraped.roomType,
          area: scraped.area,
          floor: scraped.floor,
          tags,
          hasSubway,
          hasPets,
          isWhole: true,
          isApartment: /公寓|冠寓|自如/.test(scraped.title + tags.join('')),
          aiScore: 0,
          aiComment: extracted.qrUrl 
            ? `海报识别（二维码）` 
            : extracted.url 
              ? `海报识别（文本链接）`
              : '海报识别',
          url: bestUrl && bestUrl.length > 10 ? bestUrl : undefined,
          platform: scraped.platform,
          scrapedAt: new Date().toISOString(),
          cityCode: extracted.cityCode || prefs.city,
        };

        await upsertHistoryListings([listing]);

        return { success: true, listing };
      } catch (e: any) {
        return { success: false, error: e?.message || '海报识别失败' };
      }
    },
  },
  {
    name: 'calculate_commute',
    description: '计算从用户常去地址到指定房源的通勤时间与距离（方式遵循「我的」中的通勤规划设置，默认公交地铁）',
    parameters: {
      type: 'object',
      properties: {
        listingAddress: { type: 'string', description: '房源地址（如：朝阳区望京某小区）' },
      },
      required: ['listingAddress'],
      additionalProperties: false,
    },
    execute: async (params): Promise<unknown> => {
      const listingAddress = String(params?.listingAddress || '').trim();
      const prefs = await getPrefs();
      const workAddress = String(prefs.workAddress || '').trim();
      if (!workAddress || !listingAddress) {
        return { success: false, distance: '', duration: '' };
      }
      // 使用用户偏好的城市代码限定地理编码范围
      const cityCode = prefs.city || 'bj';
      return await calculateCommute(workAddress, listingAddress, cityCode);
    },
  },
  {
    name: 'generate_bargain_scripts',
    description: '为指定房源生成砍价话术，包含时间类、价格类、问题类、时效类、条件类共 5 条。用户说"砍价""怎么谈""还价""谈价格"等时优先调用。',
    parameters: {
      type: 'object',
      properties: {
        listingId: { type: 'string', description: '房源 ID（必填）' },
      },
      required: ['listingId'],
      additionalProperties: false,
    },
    execute: async (params): Promise<unknown> => {
      const listingId = String(params?.listingId || '').trim();
      if (!listingId) return { success: false, error: '未提供房源 ID' };

      const history = await getHistory();
      const listing = history.find((l) => l.id === listingId);
      if (!listing) return { success: false, error: `未找到房源 ${listingId}，请先在「找房」页抓取或收藏该房源` };

      const prefs = await getPrefs();
      try {
        const enriched = await ensureListingEnriched(listing);
        const scripts = await generateBargainScripts(enriched, prefs);
        return { success: true, listing: { title: enriched.title, price: enriched.price }, scripts };
      } catch (e: unknown) {
        return { success: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  },
  {
    name: 'generate_compare_report',
    description: '为多套房源生成综合对比分析报告，包括价格、位置、配套、通勤等多维度对比，并给出选择建议和风险提示。',
    parameters: {
      type: 'object',
      properties: {
        listingIds: {
          type: 'array',
          description: '参与对比的房源 ID 列表',
          items: { type: 'string' },
        },
      },
      required: ['listingIds'],
      additionalProperties: false,
    },
    execute: async (params): Promise<unknown> => {
      return {
        input: params,
        report: buildMockCompareReport(),
      };
    },
  },
  {
    name: 'update_search_filters',
    description: '根据用户的自然语言需求更新找房筛选条件并自动搜索房源。当用户说"我想找XX房子""帮我找XX""我要去XX城市"等时调用此工具，它会自动更新筛选条件并返回匹配的房源列表。',
    parameters: {
      type: 'object',
      properties: {
        city: { type: 'string', description: '城市代码，如bj/sh/gz/sz/wh/cd等，或城市名称如"北京""武汉"' },
        budgetMin: { type: 'string', description: '预算下限，如"2000"' },
        budgetMax: { type: 'string', description: '预算上限，如"3000"' },
        rentMode: { type: 'string', description: '租房方式：整租/合租/短租/公寓' },
        subFilter: { type: 'string', description: '子筛选：一居/两居/三居以上（整租）；主卧独卫/向阳/独卫/全女（合租）' },
        needSubway: { type: 'boolean', description: '是否需要近地铁' },
        needPets: { type: 'boolean', description: '是否需要可养宠' },
        district: { type: 'string', description: '位置偏好，如"朝阳区""东湖高新区"' },
        commuteAddr: { type: 'string', description: '通勤地址' },
        otherReqs: { type: 'string', description: '其他要求，如"电梯""南向""押一付一"' },
      },
      required: [],
      additionalProperties: false,
    },
    execute: async (params): Promise<unknown> => {
      const { savePrefs: savePrefsFn } = await import('./storage');
      const { CITIES } = await import('./cities');
      const updates: Record<string, unknown> = {};
      
      // 处理城市参数 - 优化匹配逻辑
      if (params.city) {
        const cityInput = String(params.city).trim();
        const cityInputLower = cityInput.toLowerCase();
        
        // 精确匹配优先
        let matchedCity = CITIES.find(c => 
          c.code === cityInputLower || 
          c.name === cityInput || 
          c.pinyin === cityInputLower
        );
        
        // 如果精确匹配失败，尝试模糊匹配
        if (!matchedCity) {
          matchedCity = CITIES.find(c => 
            c.name.includes(cityInput) ||
            c.pinyin.includes(cityInputLower) ||
            cityInput.includes(c.name)
          );
        }
        
        if (matchedCity) {
          updates.city = matchedCity.code;
          updates.cityLabel = matchedCity.name;
        } else {
          // 城市未匹配到，记录日志但不报错
          console.warn(`[update_search_filters] 未能匹配城市: ${cityInput}`);
        }
      }
      
      if (params.budgetMin) updates.budgetMin = String(params.budgetMin);
      if (params.budgetMax) updates.budgetMax = String(params.budgetMax);
      if (params.rentMode) updates.rentMode = String(params.rentMode);
      if (params.subFilter) updates.subFilter = String(params.subFilter);
      if (typeof params.needSubway === 'boolean') updates.needSubway = params.needSubway;
      if (typeof params.needPets === 'boolean') updates.needPets = params.needPets;
      if (params.district) updates.district = String(params.district);
      if (params.commuteAddr) updates.commuteAddr = String(params.commuteAddr);
      if (params.otherReqs) updates.otherReqs = String(params.otherReqs);
      
      await savePrefsFn(updates);
      
      // 自动调用 search_listings 工具
      const searchListingsTool = AGENT_TOOLS.find(t => t.name === 'search_listings');
      if (searchListingsTool) {
        console.log('[update_search_filters] 自动触发 search_listings');
        const searchParams: Record<string, unknown> = {};
        
        // 将更新的筛选条件转换为 search_listings 的参数格式
        if (updates.city) searchParams.city = updates.city;
        if (params.budgetMin) searchParams.budgetMin = Number(params.budgetMin) || 0;
        if (params.budgetMax) searchParams.budgetMax = Number(params.budgetMax) || 0;
        if (params.rentMode) searchParams.rentMode = params.rentMode;
        if (typeof params.needSubway === 'boolean') searchParams.needSubway = params.needSubway;
        if (typeof params.needPets === 'boolean') searchParams.needPets = params.needPets;
        if (params.district) searchParams.district = params.district;
        
        // 执行搜索
        const searchResult = await searchListingsTool.execute(searchParams);
        
        // 返回搜索结果，而不是筛选条件更新结果
        return searchResult;
      }
      
      // 如果找不到 search_listings 工具（不应该发生），返回原来的结果
      return {
        success: true,
        message: '筛选条件已更新',
        updates,
        cityMatched: updates.city ? updates.cityLabel : null,
      };
    },
  },
  {
    name: 'analyze_folder_preferences',
    description: '分析指定收藏夹中的房源偏好，包括价格区间、高频区域、户型分布、近地铁/可养宠占比等。用于理解用户在某个收藏夹中的偏好特征。',
    parameters: {
      type: 'object',
      properties: {
        folderId: { type: 'string', description: '收藏夹 ID' },
      },
      required: ['folderId'],
      additionalProperties: false,
    },
    execute: async (params): Promise<unknown> => {
      const folderId = String(params?.folderId || '').trim();
      if (!folderId) {
        return { success: false, error: '未提供收藏夹 ID' };
      }

      const folders = await getFavoriteFolders();
      const folder = folders.find(f => f.id === folderId);
      if (!folder) {
        return { success: false, error: `未找到收藏夹 ${folderId}` };
      }

      const listings = await getFolderListings(folderId);
      if (listings.length === 0) {
        return { success: false, error: `收藏夹「${folder.name}」中暂无房源` };
      }

      // 分析价格区间
      const prices = listings.map(l => l.price).filter(p => p > 0);
      const priceMin = prices.length > 0 ? Math.min(...prices) : 0;
      const priceMax = prices.length > 0 ? Math.max(...prices) : 0;
      const priceAvg = prices.length > 0 ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length) : 0;

      // 分析高频区域
      const districtCount: Record<string, number> = {};
      listings.forEach(l => {
        const d = l.district || '未知';
        districtCount[d] = (districtCount[d] || 0) + 1;
      });
      const topDistricts = Object.entries(districtCount)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([district, count]) => ({ district, count }));

      // 分析户型分布
      const roomTypeCount: Record<string, number> = {};
      listings.forEach(l => {
        const rt = l.roomType || '未知';
        roomTypeCount[rt] = (roomTypeCount[rt] || 0) + 1;
      });
      const topRoomTypes = Object.entries(roomTypeCount)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([roomType, count]) => ({ roomType, count }));

      // 分析近地铁/可养宠占比
      const subwayCount = listings.filter(l => l.hasSubway).length;
      const petsCount = listings.filter(l => l.hasPets).length;
      const subwayRatio = listings.length > 0 ? Math.round((subwayCount / listings.length) * 100) : 0;
      const petsRatio = listings.length > 0 ? Math.round((petsCount / listings.length) * 100) : 0;

      // 分析整租/合租
      const wholeCount = listings.filter(l => l.isWhole).length;
      const wholeRatio = listings.length > 0 ? Math.round((wholeCount / listings.length) * 100) : 0;

      return {
        success: true,
        folderId,
        folderName: folder.name,
        totalCount: listings.length,
        priceRange: {
          min: priceMin,
          max: priceMax,
          avg: priceAvg,
        },
        topDistricts,
        topRoomTypes,
        features: {
          subwayRatio,
          petsRatio,
          wholeRatio,
        },
      };
    },
  },
  {
    name: 'polish_negotiation_script',
    description: '润色和优化用户提供的砍价话术或租房谈判文本。当用户说"润色""改写""优化话术""帮我改"等，或直接发送一段话术文本时调用。返回优化后的专业话术。',
    parameters: {
      type: 'object',
      properties: {
        originalText: { type: 'string', description: '用户提供的原始话术或文本' },
        style: { type: 'string', description: '润色风格：professional(专业)、friendly(友好)、assertive(坚定)，默认professional' },
      },
      required: ['originalText'],
      additionalProperties: false,
    },
    execute: async (params): Promise<unknown> => {
      const originalText = String(params?.originalText || '').trim();
      if (!originalText) {
        return { success: false, error: '未提供需要润色的文本' };
      }

      const style = String(params?.style || 'professional').trim();
      const config = await getApiConfig();
      const apiKey = config.deepseekApiKey || config.apiKey || '';

      if (!apiKey) {
        return {
          success: false,
          error: '未配置 DeepSeek API Key，无法进行话术润色。请在「我的」-「设置」中配置。',
        };
      }

      const stylePrompts: Record<string, string> = {
        professional: '专业、礼貌、逻辑清晰，适合正式谈判场合',
        friendly: '友好、亲切、易于沟通，适合建立良好关系',
        assertive: '坚定、自信、有理有据，适合争取权益',
      };

      const styleDesc = stylePrompts[style] || stylePrompts.professional;

      const systemPrompt = `你是专业的租房谈判顾问，擅长优化和润色租房相关的沟通话术。

任务：
1. 分析用户提供的原始话术，理解其核心诉求和目标
2. 保持原意的基础上，优化表达方式，使其更加${styleDesc}
3. 确保话术具有说服力，同时不失礼貌和尊重
4. 如果原文有明显的逻辑漏洞或不当表达，予以改进

输出格式：
- 直接输出优化后的话术，不要添加"优化后："等前缀
- 保持简洁，避免过度冗长
- 如果原文是多条话术，分条输出`;

      try {
        const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: 'deepseek-chat',
            messages: [
              { role: 'system', content: systemPrompt },
              {
                role: 'user',
                content: `请润色以下话术（风格：${styleDesc}）：\n\n${originalText}`,
              },
            ],
            temperature: 0.7,
            max_tokens: 1000,
          }),
        });

        if (!res.ok) {
          throw new Error(`API 请求失败: ${res.status}`);
        }

        const data = await res.json();
        const polishedText = data.choices?.[0]?.message?.content?.trim() || '';

        if (!polishedText) {
          return { success: false, error: '润色失败，未生成有效内容' };
        }

        return {
          success: true,
          originalText,
          polishedText,
          style: styleDesc,
        };
      } catch (e: unknown) {
        return {
          success: false,
          error: e instanceof Error ? e.message : '话术润色失败',
        };
      }
    },
  },
  {
    name: 'search_by_folder_preferences',
    description: '基于收藏夹偏好分析结果搜索新房源。会根据收藏夹中的价格区间、区域、户型、地铁/宠物偏好等特征搜索相似房源，并自动排除已在该收藏夹中的房源。',
    parameters: {
      type: 'object',
      properties: {
        folderId: { type: 'string', description: '收藏夹 ID' },
      },
      required: ['folderId'],
      additionalProperties: false,
    },
    execute: async (params): Promise<unknown> => {
      const folderId = String(params?.folderId || '').trim();
      if (!folderId) {
        return { success: false, error: '未提供收藏夹 ID' };
      }

      // 先调用 analyze_folder_preferences 获取偏好
      const analyzeTool = AGENT_TOOLS.find(t => t.name === 'analyze_folder_preferences');
      if (!analyzeTool) {
        return { success: false, error: '分析工具不可用' };
      }

      const analysis: any = await analyzeTool.execute({ folderId });
      if (!analysis.success) {
        return analysis;
      }

      // 获取收藏夹中的房源 ID，用于排除
      const folderListings = await getFolderListings(folderId);
      const excludeIds = new Set(folderListings.map(l => l.id));

      // 构建搜索参数
      const searchParams: Record<string, unknown> = {};
      
      // 价格区间：使用平均值 ±20% 作为搜索范围
      if (analysis.priceRange.avg > 0) {
        const avgPrice = analysis.priceRange.avg;
        searchParams.budgetMin = Math.round(avgPrice * 0.8);
        searchParams.budgetMax = Math.round(avgPrice * 1.2);
      }

      // 区域：使用最高频的区域
      if (analysis.topDistricts.length > 0) {
        searchParams.district = analysis.topDistricts[0].district;
      }

      // 户型：使用最高频的户型
      if (analysis.topRoomTypes.length > 0) {
        searchParams.roomType = analysis.topRoomTypes[0].roomType;
      }

      // 地铁偏好：如果超过50%的房源近地铁，则要求近地铁
      if (analysis.features.subwayRatio >= 50) {
        searchParams.needSubway = true;
      }

      // 宠物偏好：如果超过50%的房源可养宠，则要求可养宠
      if (analysis.features.petsRatio >= 50) {
        searchParams.needPets = true;
      }

      // 整租/合租：如果超过70%是整租，则要求整租
      if (analysis.features.wholeRatio >= 70) {
        searchParams.rentMode = '整租';
      } else if (analysis.features.wholeRatio <= 30) {
        searchParams.rentMode = '合租';
      }

      // 调用 search_listings 工具
      const searchTool = AGENT_TOOLS.find(t => t.name === 'search_listings');
      if (!searchTool) {
        return { success: false, error: '搜索工具不可用' };
      }

      const searchResult: any = await searchTool.execute(searchParams);
      
      // 排除已在收藏夹中的房源，并限制返回 3-5 套
      if (Array.isArray(searchResult.listings)) {
        searchResult.listings = searchResult.listings
          .filter((l: any) => !excludeIds.has(String(l.id)))
          .sort((a: any, b: any) => (b.aiScore || 0) - (a.aiScore || 0))
          .slice(0, 5);
        searchResult.total = searchResult.listings.length;
      }

      return {
        ...searchResult,
        searchParams,
        folderName: analysis.folderName,
        basedOnAnalysis: {
          priceRange: analysis.priceRange,
          topDistricts: analysis.topDistricts,
          topRoomTypes: analysis.topRoomTypes,
          features: analysis.features,
        },
      };
    },
  },
];

