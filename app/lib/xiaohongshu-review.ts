/**
 * 小红书房源真实评价核心逻辑
 * 包含数据收集、AI审核过滤、总评生成
 */

import { callGLM } from './api';

// ── 类型定义 ──────────────────────────────────────────────────

export type XHSPost = {
  title: string;
  content: string;
  author: string;
  images: string[];
  url: string;
  scrapedAt: string;
};

export type XHSValidationResult = {
  validPosts: XHSPost[];
  invalidPosts: Array<{
    post: XHSPost;
    reason: string;
  }>;
};

export type XHSReviewRecord = {
  listingId: string;
  community: string;
  validPosts: XHSPost[];
  invalidPosts: Array<{
    title: string;
    reason: string;
  }>;
  summary: string;
  stats: {
    totalScraped: number;
    validCount: number;
    invalidCount: number;
  };
  createdAt: string;
};

export type XHSReviewState = {
  status: 'idle' | 'scraping' | 'captcha' | 'validating' | 'generating' | 'done' | 'error';
  progress: string;
  validCount: number;
  totalScraped: number;
  error?: string;
};

// ── AI 审核过滤 ──────────────────────────────────────────────────

/**
 * 使用 AI 审核帖子，过滤广告和无效内容
 */
export async function validateXHSPosts(posts: XHSPost[]): Promise<XHSValidationResult> {
  if (posts.length === 0) {
    return { validPosts: [], invalidPosts: [] };
  }

  const prompt = `你是内容审核专家。以下是${posts.length}篇小红书帖子，请判断哪些是真实的租房评价，哪些是广告或无效内容。

**判断标准：**
✅ 真实评价：
- 租客分享真实居住体验
- 小区环境、配套设施评价
- 房东、物业服务评价
- 租房心得、注意事项
- 真实的优缺点分析

❌ 广告/无效内容：
- 中介推广、房源广告
- 营销软文、推销信息
- 无关内容（非租房相关）
- 纯图片无实质内容
- 明显的商业推广

**帖子列表：**
${posts.map((p, i) => `
${i + 1}. 标题：${p.title}
   作者：${p.author}
   内容：${p.content.slice(0, 300)}${p.content.length > 300 ? '...' : ''}
`).join('\n')}

请以JSON格式返回（不要包含markdown代码块标记）：
{
  "valid": [帖子序号数组，如 [1, 3, 4]],
  "invalid": [
    { "index": 序号, "reason": "具体原因" }
  ]
}`;

  try {
    const response = await callGLM(prompt, { temperature: 0.3 });
    
    // 清理响应，移除可能的 markdown 代码块标记
    let cleaned = response.trim();
    cleaned = cleaned.replace(/```json\n?/gi, '').replace(/```\n?/g, '');
    
    // 尝试提取 JSON
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn('[XHS Validation] No JSON found in response');
      // 默认全部通过
      return {
        validPosts: posts,
        invalidPosts: []
      };
    }

    const result = JSON.parse(jsonMatch[0]);
    const validIndices = new Set(result.valid || []);
    const invalidMap = new Map(
      (result.invalid || []).map((item: any) => [item.index, item.reason])
    );

    const validPosts: XHSPost[] = [];
    const invalidPosts: Array<{ post: XHSPost; reason: string }> = [];

    posts.forEach((post, index) => {
      const postNumber = index + 1;
      if (validIndices.has(postNumber)) {
        validPosts.push(post);
      } else if (invalidMap.has(postNumber)) {
        invalidPosts.push({
          post,
          reason: invalidMap.get(postNumber) || '未通过审核'
        });
      } else {
        // 未明确标记的，默认为有效
        validPosts.push(post);
      }
    });

    console.log(`[XHS Validation] Valid: ${validPosts.length}, Invalid: ${invalidPosts.length}`);
    return { validPosts, invalidPosts };

  } catch (error) {
    console.error('[XHS Validation] Error:', error);
    // 出错时默认全部通过，避免阻塞流程
    return {
      validPosts: posts,
      invalidPosts: []
    };
  }
}

// ── 生成总评 ──────────────────────────────────────────────────

/**
 * 基于有效帖子生成房源真实评价总结
 */
export async function generateXHSReviewSummary(
  posts: XHSPost[],
  community: string,
  roomType?: string
): Promise<string> {
  if (posts.length === 0) {
    return '暂无有效评价数据';
  }

  const prompt = `你是专业的租房评估师。以下是小红书上关于「${community}」${roomType ? `${roomType}` : ''}的${posts.length}篇真实租客评价。

请基于这些评价，生成一份简洁的房源真实评价总结（200-300字）。

**评价内容：**
${posts.map((p, i) => `
【评价 ${i + 1}】
标题：${p.title}
作者：${p.author}
内容：${p.content.slice(0, 500)}${p.content.length > 500 ? '...' : ''}
`).join('\n')}

**输出要求：**
1. 小区整体评价（居住环境、配套设施）
2. 常见优点（至少2-3条）
3. 常见问题或缺点（如有）
4. 租客建议（注意事项）
5. 综合评分（1-5星）

请用简洁、客观的语言输出，不要使用markdown格式，直接输出纯文本。`;

  try {
    const summary = await callGLM(prompt, { temperature: 0.5, maxTokens: 800 });
    return summary.trim();
  } catch (error) {
    console.error('[XHS Summary] Error:', error);
    throw new Error('生成总评失败，请稍后重试');
  }
}

// ── 数据收集逻辑 ──────────────────────────────────────────────────

/**
 * 收集有效帖子（带智能过滤）
 * 每3篇进行一次审核，过滤无效内容，直到收集到目标数量
 */
export async function collectValidPosts(
  scrapedPosts: XHSPost[],
  targetCount: number = 9,
  onProgress?: (state: XHSReviewState) => void
): Promise<{
  validPosts: XHSPost[];
  invalidPosts: Array<{ post: XHSPost; reason: string }>;
  totalScraped: number;
}> {
  const validPosts: XHSPost[] = [];
  const allInvalidPosts: Array<{ post: XHSPost; reason: string }> = [];
  let processedCount = 0;

  // 按3篇一批处理
  const batchSize = 3;
  for (let i = 0; i < scrapedPosts.length; i += batchSize) {
    // 检查是否已达到目标
    if (validPosts.length >= targetCount) {
      break;
    }

    const batch = scrapedPosts.slice(i, i + batchSize);
    if (batch.length === 0) break;

    processedCount += batch.length;

    // 更新进度
    if (onProgress) {
      onProgress({
        status: 'validating',
        progress: `正在审核第 ${i + 1}-${i + batch.length} 篇...`,
        validCount: validPosts.length,
        totalScraped: processedCount
      });
    }

    // AI 审核过滤
    const { validPosts: batchValid, invalidPosts: batchInvalid } = 
      await validateXHSPosts(batch);

    validPosts.push(...batchValid);
    allInvalidPosts.push(...batchInvalid);

    console.log(`[XHS Collect] Batch ${Math.floor(i / batchSize) + 1}: Valid ${batchValid.length}, Invalid ${batchInvalid.length}`);
  }

  // 截取到目标数量
  const finalValidPosts = validPosts.slice(0, targetCount);

  return {
    validPosts: finalValidPosts,
    invalidPosts: allInvalidPosts,
    totalScraped: processedCount
  };
}

// ── 格式化输出 ──────────────────────────────────────────────────

/**
 * 格式化评价记录为可读文本
 */
export function formatXHSReview(record: XHSReviewRecord): string {
  return `
🏘️ 房源真实评价 (小红书)

小区：${record.community}
数据来源：${record.stats.validCount} 篇真实租客评价
抓取时间：${new Date(record.createdAt).toLocaleString()}

${record.summary}

---
数据统计：
- 总抓取：${record.stats.totalScraped} 篇
- 有效评价：${record.stats.validCount} 篇
- 过滤广告：${record.stats.invalidCount} 篇
`.trim();
}
