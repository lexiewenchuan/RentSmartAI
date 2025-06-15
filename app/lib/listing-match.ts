/**
 * 跨平台房源相似度匹配。
 *
 * 匹配维度：
 *   - 小区名（模糊匹配，编辑距离）：权重 0.35
 *   - 面积（误差 ≤ 5㎡ 满分）：权重 0.25
 *   - 户型（规范化后相同满分）：权重 0.25
 *   - 价格（±20% 范围内）：权重 0.15
 *
 * matchScore >= 0.6 认定为相似房源（降低阈值以提高召回率）。
 */

import type { Listing } from './storage';

// ── 工具函数 ──────────────────────────────────────────────────

/** 计算两个字符串的编辑距离（Levenshtein Distance） */
function levenshteinDistance(str1: string, str2: string): number {
  const len1 = str1.length;
  const len2 = str2.length;
  const matrix: number[][] = [];

  // 初始化矩阵
  for (let i = 0; i <= len1; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= len2; j++) {
    matrix[0][j] = j;
  }

  // 填充矩阵
  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,      // 删除
        matrix[i][j - 1] + 1,      // 插入
        matrix[i - 1][j - 1] + cost // 替换
      );
    }
  }

  return matrix[len1][len2];
}

/** 计算两个字符串的相似度（0-1），基于编辑距离 */
function stringSimilarity(str1: string, str2: string): number {
  if (str1 === str2) return 1;
  if (!str1 || !str2) return 0;
  
  const maxLen = Math.max(str1.length, str2.length);
  if (maxLen === 0) return 1;
  
  const distance = levenshteinDistance(str1, str2);
  return 1 - distance / maxLen;
}

/** 解析面积字符串，返回数字（㎡）。无法解析时返回 0。 */
export function parseArea(areaStr: string): number {
  const m = String(areaStr || '').match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : 0;
}

const ROOM_ALIASES: Record<string, string> = {
  一居: '1室',
  两居: '2室',
  三居: '3室',
  四居: '4室',
  '1居': '1室',
  '2居': '2室',
  '3居': '3室',
  '4居': '4室',
  '1室1厅': '1室',
  '2室1厅': '2室',
  '2室2厅': '2室',
  '3室1厅': '3室',
  '3室2厅': '3室',
  '4室2厅': '4室',
};

/** 将户型字符串规范化为「N室」形式，便于比较。 */
export function normalizeRoomType(raw: string): string {
  const s = String(raw || '').replace(/\s/g, '');
  for (const [alias, norm] of Object.entries(ROOM_ALIASES)) {
    if (s.includes(alias)) return norm;
  }
  // 提取第一个数字+室
  const m = s.match(/(\d)室/);
  if (m) return `${m[1]}室`;
  return s.slice(0, 4);
}

/** 将小区名规范化：去空格、全角转半角、统一大小写、移除常见后缀。 */
export function normalizeCommunity(raw: string): string {
  return String(raw || '')
    .replace(/\s/g, '')
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/小区$|花园$|公寓$|大厦$/g, '') // 移除常见后缀以提高匹配率
    .toLowerCase();
}

/** 计算小区名相似度（支持模糊匹配） */
function communitySimilarity(comm1: string, comm2: string): number {
  const norm1 = normalizeCommunity(comm1);
  const norm2 = normalizeCommunity(comm2);
  
  // 完全匹配
  if (norm1 === norm2 && norm1.length >= 2) return 1;
  
  // 长度过短，不进行模糊匹配
  if (norm1.length < 2 || norm2.length < 2) return 0;
  
  // 一个包含另一个（处理简称情况）
  if (norm1.includes(norm2) || norm2.includes(norm1)) {
    return 0.9;
  }
  
  // 编辑距离相似度
  const similarity = stringSimilarity(norm1, norm2);
  
  // 相似度阈值：至少 0.7 才认为是同一小区
  return similarity >= 0.7 ? similarity : 0;
}

// ── 相似度计算 ────────────────────────────────────────────────

export type MatchResult = {
  listing: Listing;
  score: number;
  communityMatch: boolean;
  areaMatch: boolean;
  roomTypeMatch: boolean;
  priceDiff: number;
  priceDiffPct: number;
};

/**
 * 计算目标房源与候选房源的相似分（0-1）。
 * 使用模糊匹配和价格范围匹配提高召回率。
 */
export function calcMatchScore(target: Listing, candidate: Listing): MatchResult {
  // 1. 小区名相似度（权重 0.35）
  const communitySim = communitySimilarity(target.community, candidate.community);
  const communityMatch = communitySim >= 0.7;
  
  // 小区名相似度过低，直接返回 0
  if (communitySim < 0.7) {
    return {
      listing: candidate,
      score: 0,
      communityMatch: false,
      areaMatch: false,
      roomTypeMatch: false,
      priceDiff: 0,
      priceDiffPct: 0,
    };
  }

  // 2. 面积相似度（权重 0.25）
  const areaA = parseArea(target.area);
  const areaB = parseArea(candidate.area);
  const areaMatch = areaA > 0 && areaB > 0 && Math.abs(areaA - areaB) <= 5;
  const areaScore = areaMatch 
    ? 1 
    : areaA > 0 && areaB > 0 
      ? Math.max(0, 1 - Math.abs(areaA - areaB) / 30) // 放宽面积容差
      : 0.5;

  // 3. 户型相似度（权重 0.25）
  const roomA = normalizeRoomType(target.roomType);
  const roomB = normalizeRoomType(candidate.roomType);
  const roomTypeMatch = roomA === roomB && roomA.length > 0;
  const roomScore = roomTypeMatch ? 1 : 0.3; // 户型不匹配时给予基础分

  // 4. 价格相似度（权重 0.15）
  const priceDiff = candidate.price - target.price;
  const priceDiffPct = target.price > 0 ? Math.round((priceDiff / target.price) * 100) : 0;
  const priceInRange = Math.abs(priceDiffPct) <= 20; // ±20% 范围内
  const priceScore = priceInRange 
    ? 1 - Math.abs(priceDiffPct) / 20 * 0.5 // 价格越接近分数越高
    : Math.max(0, 1 - Math.abs(priceDiffPct) / 50); // 超出范围快速衰减

  // 综合得分
  const score = communitySim * 0.35 + areaScore * 0.25 + roomScore * 0.25 + priceScore * 0.15;

  return { 
    listing: candidate, 
    score, 
    communityMatch, 
    areaMatch, 
    roomTypeMatch, 
    priceDiff, 
    priceDiffPct 
  };
}

/**
 * 在候选列表中找出与目标房源相似的跨平台条目。
 * 仅返回不同平台且 score >= threshold 的结果，按优化后的多级排序。
 * 每个平台最多返回 2 个结果。
 * 
 * 优化的二次筛选逻辑：
 * - 户型匹配优先（相同户型排在前面）
 * - 面积相近（±10㎡ 范围内优先）
 * - 价格合理（±20% 范围内优先）
 */
export function findCrossPlatformMatches(
  target: Listing,
  candidates: Listing[],
  threshold = 0.6, // 降低阈值以提高召回率
): MatchResult[] {
  console.log('[Match] ========== 开始匹配 ==========');
  console.log('[Match] 目标房源:', {
    community: target.community,
    roomType: target.roomType,
    area: target.area,
    price: target.price,
    platform: target.platform,
  });
  console.log('[Match] 候选房源总数:', candidates.length);
  
  const filtered = candidates.filter((c) => c.id !== target.id && c.platform !== target.platform);
  console.log('[Match] 过滤后候选数（排除同平台）:', filtered.length);
  
  const allMatches = filtered
    .map((c) => {
      const result = calcMatchScore(target, c);
      console.log('[Match] 候选房源:', {
        community: c.community,
        roomType: c.roomType,
        area: c.area,
        price: c.price,
        platform: c.platform,
        score: result.score.toFixed(3),
        communityMatch: result.communityMatch,
        areaMatch: result.areaMatch,
        roomTypeMatch: result.roomTypeMatch,
        priceDiff: result.priceDiff,
      });
      return result;
    })
    .filter((r) => r.score >= threshold);
  
  console.log('[Match] 达到阈值的匹配数:', allMatches.length, '(阈值:', threshold, ')');

  // 多级排序：户型匹配 > 面积相近(±10㎡) > 价格合理(±20%) > 综合得分
  allMatches.sort((a, b) => {
    // 1. 户型匹配优先
    if (a.roomTypeMatch !== b.roomTypeMatch) {
      return a.roomTypeMatch ? -1 : 1;
    }
    
    // 2. 面积在 ±10㎡ 范围内优先
    const areaA = parseArea(target.area);
    const aAreaDiff = Math.abs(parseArea(a.listing.area) - areaA);
    const bAreaDiff = Math.abs(parseArea(b.listing.area) - areaA);
    const aAreaClose = aAreaDiff <= 10;
    const bAreaClose = bAreaDiff <= 10;
    
    if (aAreaClose !== bAreaClose) {
      return aAreaClose ? -1 : 1;
    }
    
    // 3. 价格在 ±20% 范围内优先
    const aPriceInRange = Math.abs(a.priceDiffPct) <= 20;
    const bPriceInRange = Math.abs(b.priceDiffPct) <= 20;
    
    if (aPriceInRange !== bPriceInRange) {
      return aPriceInRange ? -1 : 1;
    }
    
    // 4. 综合得分高的优先
    if (Math.abs(a.score - b.score) > 0.01) {
      return b.score - a.score;
    }
    
    // 5. 价格差异小的优先（作为最后的 tie-breaker）
    return Math.abs(a.priceDiffPct) - Math.abs(b.priceDiffPct);
  });

  // 按平台分组，每个平台最多取 2 个
  const platformGroups = new Map<string, MatchResult[]>();
  
  for (const match of allMatches) {
    const platform = match.listing.platform || 'unknown';
    if (!platformGroups.has(platform)) {
      platformGroups.set(platform, []);
    }
    const group = platformGroups.get(platform)!;
    if (group.length < 2) {
      group.push(match);
    }
  }

  // 合并所有平台的结果，保持排序
  const result: MatchResult[] = [];
  for (const group of platformGroups.values()) {
    result.push(...group);
  }
  
  // 最终排序：确保跨平台结果也按照优化的多级排序
  return result.sort((a, b) => {
    if (a.roomTypeMatch !== b.roomTypeMatch) return a.roomTypeMatch ? -1 : 1;
    
    const areaA = parseArea(target.area);
    const aAreaDiff = Math.abs(parseArea(a.listing.area) - areaA);
    const bAreaDiff = Math.abs(parseArea(b.listing.area) - areaA);
    const aAreaClose = aAreaDiff <= 10;
    const bAreaClose = bAreaDiff <= 10;
    if (aAreaClose !== bAreaClose) return aAreaClose ? -1 : 1;
    
    const aPriceInRange = Math.abs(a.priceDiffPct) <= 20;
    const bPriceInRange = Math.abs(b.priceDiffPct) <= 20;
    if (aPriceInRange !== bPriceInRange) return aPriceInRange ? -1 : 1;
    
    if (Math.abs(a.score - b.score) > 0.01) return b.score - a.score;
    
    return Math.abs(a.priceDiffPct) - Math.abs(b.priceDiffPct);
  });
}
