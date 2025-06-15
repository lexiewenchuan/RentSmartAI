// ── WebView 后台抓取模块 ────────────────────────────────────
// 完全移除 Python 后端依赖，所有抓取在 App 内通过 WebView 完成

import type { ScrapedListing } from './scraper';

export type ScrapeResult = {
  success: boolean;
  listings: ScrapedListing[];
  count: number;
  reason?: string;
};

export type ScrapeFilters = {
  rentMode?: '整租' | '合租' | '短租' | '公寓';
  budgetMin?: string;
  budgetMax?: string;
  needSubway?: boolean;
  needPets?: boolean;
};

/**
 * 构造安居客 URL（PC 版，包含房源列表）
 */
export function buildAnjukeUrl(city: string, page: number, filters?: ScrapeFilters): string {
  // 使用 PC 版 URL，直接进入房源列表页
  const baseUrl = page <= 1
    ? `https://${city}.zu.anjuke.com/fangyuan/`
    : `https://${city}.zu.anjuke.com/fangyuan/p${page}/`;
  
  // 安居客支持 URL 参数筛选（可选）
  const params = new URLSearchParams();
  
  if (filters?.budgetMin) {
    params.append('price_min', filters.budgetMin);
  }
  if (filters?.budgetMax) {
    params.append('price_max', filters.budgetMax);
  }
  
  const queryString = params.toString();
  return queryString ? `${baseUrl}?${queryString}` : baseUrl;
}

/**
 * 构造贝壳 URL
 */
export function buildBeikeUrl(city: string, page: number, filters?: ScrapeFilters): string {
  // 贝壳使用路径参数进行筛选
  let pathSegments: string[] = [];
  
  // 价格筛选：rp{min}to{max} 或 rp{min}
  if (filters?.budgetMin && filters?.budgetMax) {
    pathSegments.push(`rp${filters.budgetMin}to${filters.budgetMax}`);
  } else if (filters?.budgetMin) {
    pathSegments.push(`rp${filters.budgetMin}`);
  } else if (filters?.budgetMax) {
    pathSegments.push(`rp0to${filters.budgetMax}`);
  }
  
  // 租房方式：rt200600000001 (整租) / rt200600000002 (合租)
  if (filters?.rentMode === '整租') {
    pathSegments.push('rt200600000001');
  } else if (filters?.rentMode === '合租') {
    pathSegments.push('rt200600000002');
  }
  
  const pathSuffix = pathSegments.length > 0 ? pathSegments.join('') + '/' : '';
  
  const baseUrl = page <= 1
    ? `https://${city}.ke.com/zufang/${pathSuffix}`
    : `https://${city}.ke.com/zufang/${pathSuffix}pg${page}/`;
  
  return baseUrl;
}

/**
 * 构造链家 URL（与贝壳类似，链家和贝壳是同一家公司）
 */
export function buildLianjiaUrl(city: string, page: number, filters?: ScrapeFilters): string {
  // 链家使用路径参数进行筛选（与贝壳类似）
  let pathSegments: string[] = [];
  
  // 价格筛选：rp{min}to{max} 或 rp{min}
  if (filters?.budgetMin && filters?.budgetMax) {
    pathSegments.push(`rp${filters.budgetMin}to${filters.budgetMax}`);
  } else if (filters?.budgetMin) {
    pathSegments.push(`rp${filters.budgetMin}`);
  } else if (filters?.budgetMax) {
    pathSegments.push(`rp0to${filters.budgetMax}`);
  }
  
  // 租房方式：rt200600000001 (整租) / rt200600000002 (合租)
  if (filters?.rentMode === '整租') {
    pathSegments.push('rt200600000001');
  } else if (filters?.rentMode === '合租') {
    pathSegments.push('rt200600000002');
  }
  
  const pathSuffix = pathSegments.length > 0 ? pathSegments.join('') + '/' : '';
  
  const baseUrl = page <= 1
    ? `https://${city}.lianjia.com/zufang/${pathSuffix}`
    : `https://${city}.lianjia.com/zufang/${pathSuffix}pg${page}/`;
  
  return baseUrl;
}

/**
 * 获取城市 slug（用于 URL 构造）
 */
export function getCitySlug(cityCode: string, platform: 'anjuke' | 'beike' | 'lianjia'): string {
  const CITY_SLUGS: Record<string, { anjuke: string; beike: string; lianjia: string }> = {
    bj: { anjuke: 'bj', beike: 'bj', lianjia: 'bj' },
    sh: { anjuke: 'sh', beike: 'sh', lianjia: 'sh' },
    gz: { anjuke: 'gz', beike: 'gz', lianjia: 'gz' },
    sz: { anjuke: 'sz', beike: 'sz', lianjia: 'sz' },
    cd: { anjuke: 'cd', beike: 'cd', lianjia: 'cd' },
    cq: { anjuke: 'cq', beike: 'cq', lianjia: 'cq' },
    hz: { anjuke: 'hz', beike: 'hz', lianjia: 'hz' },
    nj: { anjuke: 'nj', beike: 'nj', lianjia: 'nj' },
    wh: { anjuke: 'wh', beike: 'wh', lianjia: 'wh' },
    xa: { anjuke: 'xa', beike: 'xa', lianjia: 'xa' },
    tj: { anjuke: 'tj', beike: 'tj', lianjia: 'tj' },
    dl: { anjuke: 'dl', beike: 'dl', lianjia: 'dl' },
    sy: { anjuke: 'sy', beike: 'sy', lianjia: 'sy' },
    qd: { anjuke: 'qd', beike: 'qd', lianjia: 'qd' },
    cs: { anjuke: 'cs', beike: 'cs', lianjia: 'cs' },
  };
  
  const hit = CITY_SLUGS[cityCode];
  if (hit) return hit[platform];
  return cityCode;
}

/**
 * 解析 WebView 返回的抓取结果
 */
export function parseScrapeMessage(data: string): ScrapeResult | null {
  try {
    const parsed = JSON.parse(data);
    
    if (parsed.type === 'scrape_result') {
      return {
        success: parsed.success || false,
        listings: parsed.listings || [],
        count: parsed.count || 0,
        reason: parsed.reason,
      };
    }
    
    return null;
  } catch {
    return null;
  }
}

/**
 * 在 React Native 中使用 BackgroundWebView 组件进行后台抓取
 * 
 * 示例：
 * ```tsx
 * import { BackgroundWebView } from '../components/BackgroundWebView';
 * import { scrapeAnjukeInBackground } from '../lib/webview-scraper';
 * 
 * function MyComponent() {
 *   const [scraping, setScraping] = useState(false);
 *   const [webViewUrl, setWebViewUrl] = useState('');
 *   
 *   async function handleScrape() {
 *     setScraping(true);
 *     const url = buildAnjukeUrl('bj', 1);
 *     setWebViewUrl(url);
 *   }
 *   
 *   function handleExtracted(result: ScrapeResult) {
 *     setScraping(false);
 *     setWebViewUrl('');
 *     // 处理结果
 *     console.log('抓取到', result.count, '套房源');
 *   }
 *   
 *   return (
 *     <>
 *       <Button onPress={handleScrape} disabled={scraping}>
 *         {scraping ? '抓取中...' : '开始抓取'}
 *       </Button>
 *       
 *       {webViewUrl && (
 *         <BackgroundWebView
 *           url={webViewUrl}
 *           platform="anjuke"
 *           onExtracted={handleExtracted}
 *           onError={(error) => {
 *             setScraping(false);
 *             setWebViewUrl('');
 *             Alert.alert('抓取失败', error);
 *           }}
 *         />
 *       )}
 *     </>
 *   );
 * }
 * ```
 */
