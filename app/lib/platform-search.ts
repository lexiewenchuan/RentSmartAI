/** 跨平台 WebView 搜索 URL 与 UA（与 PC 列表 DOM 脚本对齐） */

export const WECHAT_UA =
  'Mozilla/5.0 (Linux; Android 12; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Mobile Safari/537.36 MicroMessenger/8.0.40.2420(0x28002851) WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64';

// 桌面版 Chrome UA - 用于小红书等需要绕过移动端限制的平台
export const DESKTOP_CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// iPad UA - 介于移动和桌面之间，某些网站对iPad更友好
export const IPAD_UA =
  'Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';

export type SearchPlatform = 'anjuke' | 'beike' | 'lianjia' | 'xiaohongshu';

const PLATFORM_SEARCH_URLS: Record<SearchPlatform, (cityCode: string, query: string, page: number) => string> = {
  anjuke: (city, q, page) => {
    const encoded = encodeURIComponent(q.trim());
    if (page <= 1) return `https://${city}.zu.anjuke.com/fangyuan/?q=${encoded}`;
    return `https://${city}.zu.anjuke.com/fangyuan/p${page}/?q=${encoded}`;
  },
  beike: (city, q, page) => {
    // 贝壳搜索：需要 URL 编码避免 404
    const query = encodeURIComponent(q.trim());
    if (page <= 1) return `https://${city}.ke.com/zufang/rs${query}/`;
    return `https://${city}.ke.com/zufang/rs${query}/pg${page}/`;
  },
  lianjia: (city, q, page) => {
    // 链家搜索：使用查询参数格式 ?kw=
    const encoded = encodeURIComponent(q.trim());
    if (page <= 1) return `https://${city}.lianjia.com/zufang/?kw=${encoded}`;
    return `https://${city}.lianjia.com/zufang/pg${page}/?kw=${encoded}`;
  },
  xiaohongshu: (city, q, page) => {
    const encoded = encodeURIComponent(`${q} 租房`.trim());
    return `https://www.xiaohongshu.com/search_result?keyword=${encoded}&page=${page}`;
  },
};

export function buildPlatformSearchUrl(
  platform: SearchPlatform,
  cityCode: string,
  query: string,
  page = 1,
): string {
  const fn = PLATFORM_SEARCH_URLS[platform];
  if (!fn) return `https://${cityCode}.ke.com/zufang/`;
  return fn(cityCode, query, page);
}

export function parseListPageFromUrl(platform: SearchPlatform, url: string): number {
  try {
    const u = new URL(url);
    if (platform === 'anjuke') {
      const m = u.pathname.match(/\/p(\d+)\/?$/);
      if (m) return parseInt(m[1], 10);
      const qp = u.searchParams.get('page');
      if (qp) return parseInt(qp, 10) || 1;
      return 1;
    }
    const m = u.pathname.match(/\/pg(\d+)\/?$/);
    return m ? parseInt(m[1], 10) : 1;
  } catch {
    return 1;
  }
}

/** 在线看房列表 URL 解析页码（移动站） */
export function parseBrowsePageFromUrl(platform: SearchPlatform, url: string): number {
  try {
    const u = new URL(url);
    if (platform === 'anjuke') {
      const qp = u.searchParams.get('page');
      if (qp) return parseInt(qp, 10) || 1;
      return 1;
    }
    const m = u.pathname.match(/\/pg(\d+)\/?$/);
    return m ? parseInt(m[1], 10) : 1;
  } catch {
    return 1;
  }
}
