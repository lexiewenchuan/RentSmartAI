// ── 房源数据抓取脚本 ────────────────────────────────────────
// 用于在 WebView 中注入并提取房源信息

export type ScrapedListing = {
  title: string;
  price: number;
  community: string;
  district: string;
  roomType: string;
  area: string;
  floor: string;
  tags: string[];
  url: string;
  imageUrl?: string;
  platform: string;
};

// 数据质量评分和验证
type QualityScore = {
  valid: boolean;
  score: number;
  reasons: string[];
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function assessListingQuality(listing: ScrapedListing): QualityScore {
  const reasons: string[] = [];
  let score = 0;

  // 必要字段检查
  if (!listing.url || listing.url.length < 10) {
    reasons.push('缺少有效链接');
    return { valid: false, score: 0, reasons };
  }

  if (!listing.price || listing.price < 300 || listing.price > 50000) {
    reasons.push('价格异常或缺失');
    return { valid: false, score: 0, reasons };
  }

  // 标题质量评估
  const title = (listing.title || '').trim();
  if (title.length < 4) {
    reasons.push('标题过短');
    return { valid: false, score: 0, reasons };
  }

  if (/^[\d\s元月]+$/.test(title)) {
    reasons.push('标题只含数字和单位');
    return { valid: false, score: 0, reasons };
  }

  if (/^(未知|unknown|null|undefined)/i.test(title)) {
    reasons.push('标题为占位符');
    return { valid: false, score: 0, reasons };
  }

  // 位置信息评估
  const hasCommunity = listing.community && listing.community.length >= 2 && listing.community !== '未知小区';
  const hasDistrict = listing.district && listing.district.length >= 2 && listing.district !== '未知';

  if (!hasCommunity && !hasDistrict) {
    reasons.push('缺少位置信息');
    return { valid: false, score: 0, reasons };
  }

  // 开始计分（通过基础验证后）
  score = 50; // 基础分

  if (hasCommunity) score += 15;
  if (hasDistrict) score += 15;
  if (listing.roomType && listing.roomType !== '未知') score += 10;
  if (listing.area && listing.area !== '未知') score += 5;
  if (listing.floor && listing.floor.length > 0) score += 5;

  return { valid: true, score, reasons };
}

function normalizeUrlForId(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    const pathname = url.pathname.replace(/\/+$/, '');
    return `${url.hostname}${pathname}`.toLowerCase();
  } catch {
    return rawUrl.trim().toLowerCase();
  }
}

function hashText(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) + hash) + input.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

// ── 生成唯一 ID ───────────────────────────────────────────────
export function generateListingId(listing: ScrapedListing): string {
  // 使用稳定字段生成稳定 ID，避免重复扫描时因为时间戳导致去重失效。
  if (listing.url) {
    const normalizedUrl = normalizeUrlForId(listing.url);
    const urlHash = hashText(normalizedUrl);
    return `${listing.platform}-${urlHash}`;
  }

  // URL 缺失时使用稳定的业务字段组合。
  const fallback = [
    listing.platform || 'unknown',
    (listing.community || '').trim().toLowerCase(),
    (listing.district || '').trim().toLowerCase(),
    (listing.roomType || '').trim().toLowerCase(),
    String(listing.price || 0),
  ].join('|');
  return `${listing.platform || 'unknown'}-${hashText(fallback)}`;
}

// ── 安居客抓取脚本 ────────────────────────────────────────────
export const ANJUKE_SCRAPER = `
(function() {
  try {
    var cards = document.querySelectorAll('.zu-itemmod');
    var results = [];
    
    cards.forEach(function(card) {
      try {
        // 提取房源链接（多策略）
        var link = '';
        
        // 策略1：从 link 属性提取
        link = card.getAttribute('link') || '';
        console.log('[Anjuke] Strategy 1 - link attr:', link.substring(0, 100));
        
        // 策略2：从 a 标签的 href 提取
        if (!link) {
          var anchor = card.querySelector('a[href*="anjuke.com"]') || 
                       card.querySelector('a[href*="/view/"]') || 
                       card.querySelector('a[href*="zufang"]') ||
                       card.querySelector('a');
          if (anchor) {
            link = anchor.getAttribute('href') || '';
            console.log('[Anjuke] Strategy 2 - a href:', link.substring(0, 100));
          }
        }
        
        // 策略3：从 data-link 或其他 data 属性提取
        if (!link) {
          link = card.getAttribute('data-link') || 
                 card.getAttribute('data-url') || 
                 card.getAttribute('data-href') || '';
          console.log('[Anjuke] Strategy 3 - data attr:', link.substring(0, 100));
        }
        
        // 如果是相对路径，转换为绝对路径
        if (link && !link.startsWith('http')) {
          if (link.startsWith('//')) {
            link = 'https:' + link;
          } else if (link.startsWith('/')) {
            link = 'https://www.anjuke.com' + link;
          }
        }
        
        var cleanUrl = link.split('?')[0]; // 去掉 query 参数
        console.log('[Anjuke] Final cleanUrl:', cleanUrl.substring(0, 100));
        
        // 提取标题
        var titleEl = card.querySelector('h3') || card.querySelector('.house-title') || card.querySelector('.zu-info-top');
        var title = titleEl ? titleEl.innerText.trim() : '';
        
        // 提取价格
        var priceEl = card.querySelector('.zu-side .price') || card.querySelector('.price-det') || card.querySelector('[class*="price"]');
        var priceText = priceEl ? priceEl.innerText.replace(/[^0-9]/g, '') : '0';
        var price = parseInt(priceText) || 0;
        
        // 提取房型、面积等详细信息
        var infoEls = card.querySelectorAll('.zu-info-detail span') || card.querySelectorAll('.details-item');
        var infoArr = Array.from(infoEls).map(function(el) { return el.innerText.trim(); });
        
        // 提取图片
        var imgEl = card.querySelector('img');
        var imgUrl = imgEl ? (imgEl.getAttribute('data-src') || imgEl.getAttribute('src') || '') : '';
        
        // 提取小区名
        var communityEl = card.querySelector('.comm-name') || card.querySelector('[class*="community"]') || card.querySelector('.zu-info a');
        var community = communityEl ? communityEl.innerText.trim() : '';
        
        // 提取标签
        var tagEls = card.querySelectorAll('.tag-item') || card.querySelectorAll('[class*="tag"]');
        var tags = Array.from(tagEls).map(function(el) { return el.innerText.trim(); }).filter(function(t) { return t.length > 0 && t.length < 10; });
        
        // 只添加有效房源
        if (cleanUrl && title && price >= 300 && price <= 50000) {
          var listing = {
            url: cleanUrl,
            title: title,
            price: price,
            community: community || '未知小区',
            district: '未知区域',
            roomType: infoArr[0] || '未知',
            area: infoArr[1] || '未知',
            floor: infoArr[2] || '',
            tags: tags.slice(0, 5),
            imageUrl: imgUrl,
            platform: 'anjuke'
          };
          console.log('[Anjuke] Adding listing:', JSON.stringify(listing).substring(0, 200));
          results.push(listing);
        } else {
          console.log('[Anjuke] Skipped - cleanUrl:', !!cleanUrl, 'title:', !!title, 'price:', price);
        }
      } catch(e) {
        // 忽略单个卡片错误
      }
    });
    
    // 发送调试信息（前3个结果）
    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: 'debug_results',
      first3: results.slice(0, 3),
      totalCount: results.length
    }));
    
    // 发送最终结果
    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: 'scrape_result',
      success: true,
      listings: results,
      count: results.length,
      debug: {
        title: document.title,
        url: location.href,
        foundCards: cards.length,
        validListings: results.length
      }
    }));
    
  } catch(error) {
    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: 'scrape_result',
      success: false,
      reason: error.message || '脚本执行失败',
      count: 0
    }));
  }
})();
`;

// ── 贝壳抓取脚本 ──────────────────────────────────────────────
export const BEIKE_SCRAPER = `
(function() {
  // 立即发送脚本启动确认
  window.ReactNativeWebView.postMessage(JSON.stringify({
    type: 'script_started',
    platform: 'beike',
    timestamp: Date.now()
  }));
  
  try {
    // ★ 检测人机验证页面
    if (document.title === 'CAPTCHA' || 
        document.title.includes('人机验证') ||
        location.href.includes('/captcha') ||
        document.querySelector('.geetest_captcha')) {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'scrape_result',
        success: false,
        reason: '触发人机验证，请先在「我的→平台账号」中登录贝壳，登录后可避免验证',
        needLogin: true,
        count: 0,
        debug: {
          title: document.title,
          url: location.href,
          isCaptcha: true
        }
      }));
      return;
    }
    
    const listings = [];
    const seen = new Set();
    
    // 质量检查函数
    function isValidListing(listing) {
      if (!listing.url || listing.url.length < 10) return false;
      if (!listing.price || listing.price < 300 || listing.price > 50000) return false;
      const title = (listing.title || '').trim();
      if (title.length < 4) return false;
      if (/^[\\d\\s元月]+$/.test(title)) return false;
      if (/^(未知|unknown)/i.test(title)) return false;
      const hasCommunity = listing.community && listing.community.length >= 2;
      const hasDistrict = listing.district && listing.district.length >= 2;
      if (!hasCommunity && !hasDistrict) return false;
      return true;
    }

    // ★ 精准定位贝壳房源卡片
    let houseCards = [];
    
    // 策略1：贝壳标准结构（content__list--item）
    houseCards = Array.from(document.querySelectorAll(
      '.content__list--item, ' +
      'div[data-house_code], ' +
      'div[data-id]'
    ));
    
    // 策略2：找包含贝壳房源链接的 li/div
    if (houseCards.length === 0) {
      houseCards = Array.from(document.querySelectorAll('li, div')).filter(el => {
        const anchor = el.querySelector('a[href*="ke.com"], a[href*="zufang"]');
        const text = el.textContent || '';
        return anchor && text.length > 50 && /\\d{3,6}\\s*元/.test(text);
      });
    }
    
    // 策略3：通用容器 + 房源特征
    if (houseCards.length === 0) {
      houseCards = Array.from(document.querySelectorAll('div, section, article')).filter(el => {
        const text = el.textContent || '';
        const hasPrice = /\\d{3,6}\\s*元/.test(text);
        const hasRoom = /\\d室\\d厅|整租|合租/.test(text);
        const hasLink = el.querySelector('a[href*="ke.com"], a[href*="zufang"]');
        return hasPrice && hasRoom && hasLink && text.length > 50 && text.length < 500;
      });
    }

    if (houseCards.length === 0) {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'scrape_result',
        success: false,
        reason: '未找到房源卡片（请确保在贝壳租房列表页）',
        count: 0,
        debug: {
          title: document.title,
          url: location.href,
          domSample: document.body.innerHTML.substring(0, 500),
        },
      }));
      return;
    }

    houseCards.forEach((container) => {
      try {
        const anchor = container.querySelector('a[href*="ke.com"], a[href*="zufang"], a[href]');
        if (!anchor) return;
        const text = (container.textContent || '').replace(/\\s+/g, ' ').trim();
        if (!text || text.length < 30) return;

        // ★ 标题提取（贝壳适配）
        let title = '';
        
        // 贝壳专属选择器
        const titleSelectors = [
          '.content__list--item--title',  // 贝壳标准
          '.house-title', '.title', 'h3', 'h2',
          'p.title', 'div.title',
          '[class*="title"]', '[class*="Title"]'
        ];
        for (const sel of titleSelectors) {
          const el = container.querySelector(sel);
          if (el && el.textContent.trim().length > 6) {
            title = el.textContent.trim();
            break;
          }
        }
        
        // 从链接文本提取
        if (!title && anchor) {
          const anchorText = anchor.textContent.trim();
          if (anchorText.length > 10 && !/^[\\d元\\s]+$/.test(anchorText)) {
            title = anchorText;
          }
        }
        
        // 从文本节点提取
        if (!title) {
          const textNodes = [];
          const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
          let node;
          while (node = walker.nextNode()) {
            const t = node.textContent.trim();
            if (t.length > 10) textNodes.push(t);
          }
          for (const t of textNodes) {
            if (!/^[\\d元\\s]+$/.test(t) && !/^[·｜,，\\s]+$/.test(t)) {
              title = t;
              break;
            }
          }
        }
        
        // 清理标题
        title = title
          .replace(/^[·｜\\-\\s]+|[·｜\\-\\s]+$/g, '')
          .replace(/（广告）|【广告】|\\[广告\\]|推广|置顶|精选|立即咨询|点击查看|查看详情/g, '')
          .replace(/\\s{2,}/g, ' ')
          .trim();
        
        // 有效性判定
        if (!title || 
            title.length < 4 || 
            /^[\\d\\s元月]+$/.test(title) ||
            /风控|验证|人机|滑块|登录|注册|跳转|刷新/i.test(title)) {
          return;
        }

        // ★ 价格提取（贝壳适配）
        let price = 0;
        
        // 贝壳专属选择器
        const priceSelectors = [
          '.content__list--item-price',  // 贝壳标准
          '.price-num', '.price', '.price-txt', 
          'em.price', 'span.price',
          '[class*="price"]'
        ];
        for (const sel of priceSelectors) {
          const el = container.querySelector(sel);
          if (el) {
            const pm = el.textContent.match(/(\\d{3,6})/);
            if (pm) {
              price = parseInt(pm[1], 10);
              break;
            }
          }
        }
        
        if (!price) {
          const pm = text.match(/(\\d{3,6})\\s*元\\/月|月租\\s*(\\d{3,6})/);
          if (pm) price = parseInt(pm[1] || pm[2], 10);
        }
        
        if (!price || price < 300 || price > 50000) return;

        // ★ 房型、面积、楼层提取
        const infoEl = container.querySelector('.info, .house-info, .details, .content__list--item--des, [class*="info"], [class*="desc"]');
        const infoText = infoEl ? infoEl.textContent : text;
        const roomMatch = infoText.match(/(\\d室\\d厅|\\d室|合租|整租|主卧|次卧|一居|两居|三居|四居)/);
        const areaMatch = infoText.match(/(\\d+(?:\\.\\d+)?\\s*(?:㎡|平米?|平方米))/);
        const floorMatch = infoText.match(/([高低中]楼层(?:[/共]\\d+层)?)/) || infoText.match(/(\\d+\\/\\d+层|\\d+层)/);

        // ★ 小区和区域提取（贝壳优化）
        let community = '';
        let district = '';
        
        // 策略1：专属选择器
        const addressSelectors = [
          '.content__list--item--des',
          '.address', '.community', '.comm', '.location',
          '[class*="address"]', '[class*="community"]'
        ];
        for (const sel of addressSelectors) {
          const el = container.querySelector(sel);
          if (!el) continue;
          const addrText = el.textContent.trim();
          
          const commMatch = addrText.match(/([\\u4e00-\\u9fa5]{2,20}(?:小区|花园|公寓|里|苑|家园|新村|大厦|中心|广场|城|庭|园|邸|府|轩|居|坊|阁|湾|庄))/);
          if (commMatch && !community) community = commMatch[1];
          
          const distMatch = addrText.match(/([\\u4e00-\\u9fa5]{2,10}(?:区|县|镇|街道))/);
          if (distMatch && !district) district = distMatch[1];
        }
        
        // 策略2：标题解析
        if (!community || !district) {
          const parts = title.split(/[·｜\\-]/);
          for (const part of parts) {
            const p = part.trim();
            if (!district && /[\\u4e00-\\u9fa5]{2,10}(?:区|县)$/.test(p)) district = p;
            if (!community && /(?:小区|花园|公寓|里|苑|家园|新村|大厦|中心|广场|城)$/.test(p) && p.length >= 3) community = p;
          }
        }
        
        // 策略3：全文提取
        if (!community) {
          const commMatch = text.match(/([\\u4e00-\\u9fa5]{2,20}(?:小区|花园|公寓|里|苑|家园|新村|大厦|中心|广场|城))/);
          if (commMatch) community = commMatch[1];
        }
        if (!district) {
          const distMatch = text.match(/([\\u4e00-\\u9fa5]{2,10}(?:区|县))/);
          if (distMatch) district = distMatch[1];
        }
        
        // 必须有位置信息
        if (!community && !district) return;

        // ★ 标签提取（精准化）
        const tagEls = container.querySelectorAll('.tag, .tags, .label, i.tag, span.tag, .content__list--item--bottom i, [class*="tag-"]');
        let rawTags = [];
        if (tagEls.length > 0) {
          rawTags = Array.from(tagEls).map(el => {
            const t = el.textContent.trim();
            if (t.length < 2 || t.length > 8) return '';
            if (/^[\\d\\.]+$/.test(t)) return '';
            if (/^[·｜,，\\s]+$/.test(t)) return '';
            return t;
          }).filter(Boolean);
        }
        rawTags = [...new Set(rawTags)];

        // ★ URL 提取和验证
        const hrefRaw = anchor.getAttribute('href') || '';
        if (!hrefRaw) return;
        const url = hrefRaw.startsWith('http') ? hrefRaw : new URL(hrefRaw, location.href).toString();
        
        // 确保是真实房源链接
        if (!url.includes('/zufang/') && 
            !url.includes('/chuzu/') &&
            !url.includes('ke.com')) {
          return;
        }
        
        // 去重
        const uniqueKey = url.split('?')[0];
        if (seen.has(uniqueKey)) return;
        seen.add(uniqueKey);

        // ★ 构造房源对象
        const listing = {
          title: title,
          price,
          community: community || '未知小区',
          district: district || '未知区域',
          roomType: roomMatch ? roomMatch[1] : '未知',
          area: areaMatch ? areaMatch[1] : '未知',
          floor: floorMatch ? floorMatch[1] : '',
          tags: rawTags.slice(0, 6),
          url,
          imageUrl: container.querySelector('img')?.getAttribute('src') || '',
          platform: 'beike',
        };

        // 最终质量检查
        if (isValidListing(listing)) {
          listings.push(listing);
        }
      } catch (e) {
        // ignore
      }
    });

    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: 'scrape_result',
      success: true,
      listings,
      count: listings.length,
      debug: {
        title: document.title,
        url: location.href,
        foundCards: houseCards.length,
        validListings: listings.length,
        is404: document.title.includes('404') || document.body.innerText.includes('页面不存在'),
      },
    }));

  } catch (error) {
    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: 'scrape_result',
      success: false,
      reason: error.message || '脚本执行失败',
      error: error.toString(),
      stack: error.stack,
      count: 0,
    }));
  } finally {
    // 确保总是发送完成信号
    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: 'script_completed',
      platform: 'beike',
      timestamp: Date.now()
    }));
  }
})();
`;

// ── 小红书抓取脚本 ────────────────────────────────────────────
export const XIAOHONGSHU_SCRAPER = `
(function() {
  try {
    // ★ 检测登录状态
    if (document.title.includes('登录') || 
        document.querySelector('.login-container, .login-box, [class*="login"]')) {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'scrape_result',
        success: false,
        reason: '需要登录小红书账号，请先在「我的→平台账号」中登录',
        needLogin: true,
        count: 0,
        debug: {
          title: document.title,
          url: location.href,
          needsLogin: true
        }
      }));
      return;
    }
    
    const listings = [];
    const seen = new Set();
    
    // 质量检查函数
    function isValidListing(listing) {
      if (!listing.url || listing.url.length < 10) return false;
      if (!listing.price || listing.price < 300 || listing.price > 50000) return false;
      const title = (listing.title || '').trim();
      if (title.length < 4) return false;
      if (/^[\\d\\s元月]+$/.test(title)) return false;
      return true;
    }
    
    // ★ 小红书笔记卡片选择器（多策略）
    let noteCards = [];
    
    // 策略1：标准笔记卡片
    noteCards = Array.from(document.querySelectorAll(
      '.note-item, ' +
      '[class*="note-card"], ' +
      '[class*="feed-card"], ' +
      '.search-item'
    ));
    
    // 策略2：通用容器 + 租房特征
    if (noteCards.length === 0) {
      noteCards = Array.from(document.querySelectorAll('div, section, article')).filter(el => {
        const text = el.textContent || '';
        const hasPrice = /\\d{3,6}\\s*[元块]/.test(text);
        const hasRent = /租房|出租|整租|合租/.test(text);
        const hasLink = el.querySelector('a[href*="xhslink"], a[href*="xiaohongshu.com"]');
        return hasPrice && hasRent && hasLink && text.length > 30 && text.length < 800;
      });
    }
    
    if (noteCards.length === 0) {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'scrape_result',
        success: false,
        reason: '未找到租房笔记（请确保在小红书搜索结果页）',
        count: 0,
        debug: {
          title: document.title,
          url: location.href,
        },
      }));
      return;
    }
    
    noteCards.forEach((container) => {
      try {
        const text = (container.textContent || '').replace(/\\s+/g, ' ').trim();
        if (!text || text.length < 20) return;
        
        // 必须包含租房相关关键词
        if (!/租房|出租|整租|合租|房源/.test(text)) return;
        
        // ★ 提取链接
        const anchor = container.querySelector('a[href*="xiaohongshu.com"], a[href*="xhslink"], a[href]');
        if (!anchor) return;
        
        const hrefRaw = anchor.getAttribute('href') || '';
        if (!hrefRaw) return;
        
        let url = hrefRaw.startsWith('http') ? hrefRaw : new URL(hrefRaw, location.href).toString();
        
        // 去重
        const uniqueKey = url.split('?')[0];
        if (seen.has(uniqueKey)) return;
        seen.add(uniqueKey);
        
        // ★ 提取标题
        let title = '';
        const titleSelectors = [
          '.title', '.note-title', '[class*="title"]',
          'h3', 'h2', 'h4',
          '.content', '[class*="content"]'
        ];
        
        for (const sel of titleSelectors) {
          const el = container.querySelector(sel);
          if (el && el.textContent.trim().length > 6) {
            title = el.textContent.trim();
            break;
          }
        }
        
        if (!title && anchor) {
          const anchorText = anchor.textContent.trim();
          if (anchorText.length > 10 && !/^[\\d元\\s]+$/.test(anchorText)) {
            title = anchorText;
          }
        }
        
        // 清理标题
        title = title
          .replace(/^[·｜\\-\\s]+|[·｜\\-\\s]+$/g, '')
          .replace(/（广告）|【广告】|\\[广告\\]|推广|置顶|精选/g, '')
          .replace(/\\s{2,}/g, ' ')
          .trim();
        
        if (!title || title.length < 4) return;
        
        // ★ 提取价格
        let price = 0;
        
        // 从文本中提取价格（小红书通常在正文中）
        const pricePatterns = [
          /(\\d{3,6})\\s*[元块]\\/月/,
          /月租\\s*(\\d{3,6})/,
          /租金\\s*(\\d{3,6})/,
          /(\\d{3,6})\\s*[元块]\\s*月/,
          /价格\\s*(\\d{3,6})/
        ];
        
        for (const pattern of pricePatterns) {
          const match = text.match(pattern);
          if (match) {
            price = parseInt(match[1], 10);
            if (price >= 300 && price <= 50000) break;
          }
        }
        
        if (!price || price < 300 || price > 50000) return;
        
        // ★ 提取小区名
        let community = '';
        const commMatch = text.match(/([\\u4e00-\\u9fa5]{2,20}(?:小区|花园|公寓|里|苑|家园|新村|大厦|中心|广场|城|庭|园|邸|府|轩|居|坊|阁|湾|庄))/);
        if (commMatch) community = commMatch[1];
        
        // ★ 提取区域
        let district = '';
        const distMatch = text.match(/([\\u4e00-\\u9fa5]{2,10}(?:区|县))/);
        if (distMatch) district = distMatch[1];
        
        // ★ 提取房型
        let roomType = '';
        const roomMatch = text.match(/(\\d室\\d厅|\\d室|合租|整租|主卧|次卧|一居|两居|三居|四居)/);
        if (roomMatch) roomType = roomMatch[1];
        
        // ★ 提取面积
        let area = '';
        const areaMatch = text.match(/(\\d+(?:\\.\\d+)?\\s*(?:㎡|平米?|平方米))/);
        if (areaMatch) area = areaMatch[1];
        
        // ★ 提取标签
        const tagEls = container.querySelectorAll('.tag, [class*="tag"]');
        let tags = [];
        if (tagEls.length > 0) {
          tags = Array.from(tagEls).map(el => {
            const t = el.textContent.trim();
            if (t.length < 2 || t.length > 8) return '';
            return t;
          }).filter(Boolean);
        }
        tags = [...new Set(tags)];
        
        // ★ 提取图片
        const imgEl = container.querySelector('img');
        const imageUrl = imgEl ? (imgEl.getAttribute('src') || imgEl.getAttribute('data-src') || '') : '';
        
        // ★ 构造房源对象
        const listing = {
          title: title,
          price,
          community: community || '未知小区',
          district: district || '未知区域',
          roomType: roomType || '未知',
          area: area || '未知',
          floor: '',
          tags: tags.slice(0, 5),
          url,
          imageUrl,
          platform: 'xiaohongshu',
        };
        
        // 最终质量检查
        if (isValidListing(listing)) {
          listings.push(listing);
        }
      } catch (e) {
        // ignore
      }
    });
    
    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: 'scrape_result',
      success: true,
      listings,
      count: listings.length,
      debug: {
        title: document.title,
        url: location.href,
        foundCards: noteCards.length,
        validListings: listings.length,
      },
    }));
    
  } catch (error) {
    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: 'scrape_result',
      success: false,
      reason: error.message || '脚本执行失败',
      count: 0,
    }));
  }
})();
`;

// ── 获取对应平台的抓取脚本 ────────────────────────────────────
export function getScraperScript(platform: 'anjuke' | 'beike' | 'lianjia' | 'xiaohongshu'): string {
  switch (platform) {
    case 'anjuke': return ANJUKE_SCRAPER;
    case 'beike': return BEIKE_SCRAPER;
    case 'lianjia': return LIANJIA_SCRAPER;
    case 'xiaohongshu': return XIAOHONGSHU_SCRAPER;
    default: return ANJUKE_SCRAPER;
  }
}

// ── 链家列表页抓取脚本 ──────────────────────────────────────
// 链家和贝壳是同一家公司，页面结构相似，复用贝壳的高质量逻辑
const LIANJIA_SCRAPER = `
(function() {
  // 立即发送脚本启动确认
  window.ReactNativeWebView.postMessage(JSON.stringify({
    type: 'script_started',
    platform: 'lianjia',
    timestamp: Date.now()
  }));
  
  try {
    // ★ 调试：测试各种选择器
    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: 'debug_selectors',
      platform: 'lianjia',
      selectors: {
        'content__list--item': document.querySelectorAll('.content__list--item').length,
        'house-lst li': document.querySelectorAll('.house-lst li').length,
        'data-el-ershoufang': document.querySelectorAll('[data-el="ershoufang"]').length,
        'class-contains-item': document.querySelectorAll('[class*="item"]').length,
        'class-contains-list': document.querySelectorAll('[class*="list"]').length,
        'li-elements': document.querySelectorAll('li').length,
        'div-elements': document.querySelectorAll('div').length,
      },
      pageInfo: {
        title: document.title,
        url: window.location.href,
        bodyLength: document.body.innerHTML.length
      }
    }));
    
    // ★ 检测人机验证页面
    if (document.title === 'CAPTCHA' || 
        document.title.includes('人机验证') ||
        location.href.includes('/captcha') ||
        document.querySelector('.geetest_captcha')) {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'scrape_result',
        success: false,
        reason: '触发人机验证，请先在「我的→平台账号」中登录链家，登录后可避免验证',
        needLogin: true,
        count: 0,
        debug: {
          title: document.title,
          url: location.href,
          isCaptcha: true
        }
      }));
      return;
    }
    
    const listings = [];
    const seen = new Set();
    
    // 质量检查函数
    function isValidListing(listing) {
      if (!listing.url || listing.url.length < 10) return false;
      if (!listing.price || listing.price < 300 || listing.price > 50000) return false;
      const title = (listing.title || '').trim();
      if (title.length < 4) return false;
      if (/^[\\d\\s元月]+$/.test(title)) return false;
      if (/^(未知|unknown)/i.test(title)) return false;
      const hasCommunity = listing.community && listing.community.length >= 2;
      const hasDistrict = listing.district && listing.district.length >= 2;
      if (!hasCommunity && !hasDistrict) return false;
      return true;
    }

    // ★ 精准定位链家房源卡片（与贝壳类似）
    let houseCards = [];
    
    // 策略1：链家标准结构
    houseCards = Array.from(document.querySelectorAll(
      '.content__list--item, ' +
      'div[data-house_code], ' +
      'div[data-id]'
    ));
    
    // 策略2：找包含链家房源链接的 li/div
    if (houseCards.length === 0) {
      houseCards = Array.from(document.querySelectorAll('li, div')).filter(el => {
        const anchor = el.querySelector('a[href*="lianjia.com"], a[href*="zufang"]');
        const text = el.textContent || '';
        return anchor && text.length > 50 && /\\d{3,6}\\s*元/.test(text);
      });
    }
    
    // 策略3：通用容器 + 房源特征
    if (houseCards.length === 0) {
      houseCards = Array.from(document.querySelectorAll('div, section, article')).filter(el => {
        const text = el.textContent || '';
        const hasPrice = /\\d{3,6}\\s*元/.test(text);
        const hasRoom = /\\d室\\d厅|整租|合租/.test(text);
        const hasLink = el.querySelector('a[href*="lianjia.com"], a[href*="zufang"]');
        return hasPrice && hasRoom && hasLink && text.length > 50 && text.length < 500;
      });
    }

    if (houseCards.length === 0) {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'scrape_result',
        success: false,
        reason: '未找到房源卡片（请确保在链家租房列表页）',
        count: 0,
        debug: {
          title: document.title,
          url: location.href,
        },
      }));
      return;
    }

    houseCards.forEach((container) => {
      try {
        const anchor = container.querySelector('a[href*="lianjia.com"], a[href*="zufang"], a[href]');
        if (!anchor) return;
        const text = (container.textContent || '').replace(/\\s+/g, ' ').trim();
        if (!text || text.length < 30) return;

        // ★ 标题提取
        let title = '';
        const titleSelectors = [
          '.content__list--item--title',
          '.house-title', '.title', 'h3', 'h2',
          'p.title', 'div.title',
          '[class*="title"]', '[class*="Title"]'
        ];
        for (const sel of titleSelectors) {
          const el = container.querySelector(sel);
          if (el && el.textContent.trim().length > 6) {
            title = el.textContent.trim();
            break;
          }
        }
        
        if (!title && anchor) {
          const anchorText = anchor.textContent.trim();
          if (anchorText.length > 10 && !/^[\\d元\\s]+$/.test(anchorText)) {
            title = anchorText;
          }
        }
        
        title = title
          .replace(/^[·｜\\-\\s]+|[·｜\\-\\s]+$/g, '')
          .replace(/（广告）|【广告】|\\[广告\\]|推广|置顶|精选/g, '')
          .replace(/\\s{2,}/g, ' ')
          .trim();
        
        if (!title || title.length < 4 || /^[\\d\\s元月]+$/.test(title)) return;

        // ★ 价格提取
        let price = 0;
        const priceSelectors = [
          '.content__list--item-price',
          '.price-num', '.price', '.price-txt', 
          'em.price', 'span.price',
          '[class*="price"]'
        ];
        for (const sel of priceSelectors) {
          const el = container.querySelector(sel);
          if (el) {
            const pm = el.textContent.match(/(\\d{3,6})/);
            if (pm) {
              price = parseInt(pm[1], 10);
              break;
            }
          }
        }
        
        if (!price) {
          const pm = text.match(/(\\d{3,6})\\s*元\\/月|月租\\s*(\\d{3,6})/);
          if (pm) price = parseInt(pm[1] || pm[2], 10);
        }
        
        if (!price || price < 300 || price > 50000) return;

        // ★ 房型、面积、楼层提取
        const infoEl = container.querySelector('.info, .house-info, .details, .content__list--item--des, [class*="info"], [class*="desc"]');
        const infoText = infoEl ? infoEl.textContent : text;
        const roomMatch = infoText.match(/(\\d室\\d厅|\\d室|合租|整租|主卧|次卧|一居|两居|三居|四居)/);
        const areaMatch = infoText.match(/(\\d+(?:\\.\\d+)?\\s*(?:㎡|平米?|平方米))/);
        const floorMatch = infoText.match(/([高低中]楼层(?:[/共]\\d+层)?)/) || infoText.match(/(\\d+\\/\\d+层|\\d+层)/);

        // ★ 小区和区域提取
        let community = '';
        let district = '';
        
        const addressSelectors = [
          '.content__list--item--des',
          '.address', '.community', '.comm', '.location',
          '[class*="address"]', '[class*="community"]'
        ];
        for (const sel of addressSelectors) {
          const el = container.querySelector(sel);
          if (!el) continue;
          const addrText = el.textContent.trim();
          
          const commMatch = addrText.match(/([\\u4e00-\\u9fa5]{2,20}(?:小区|花园|公寓|里|苑|家园|新村|大厦|中心|广场|城|庭|园|邸|府|轩|居|坊|阁|湾|庄))/);
          if (commMatch && !community) community = commMatch[1];
          
          const distMatch = addrText.match(/([\\u4e00-\\u9fa5]{2,10}(?:区|县|镇|街道))/);
          if (distMatch && !district) district = distMatch[1];
        }
        
        if (!community || !district) {
          const parts = title.split(/[·｜\\-]/);
          for (const part of parts) {
            const p = part.trim();
            if (!district && /[\\u4e00-\\u9fa5]{2,10}(?:区|县)$/.test(p)) district = p;
            if (!community && /(?:小区|花园|公寓|里|苑|家园|新村|大厦|中心|广场|城)$/.test(p) && p.length >= 3) community = p;
          }
        }
        
        if (!community && !district) return;

        // ★ 标签提取
        const tagEls = container.querySelectorAll('.tag, .tags, .label, i.tag, span.tag, .content__list--item--bottom i, [class*="tag-"]');
        let rawTags = [];
        if (tagEls.length > 0) {
          rawTags = Array.from(tagEls).map(el => {
            const t = el.textContent.trim();
            if (t.length < 2 || t.length > 8) return '';
            if (/^[\\d\\.]+$/.test(t)) return '';
            return t;
          }).filter(Boolean);
        }
        rawTags = [...new Set(rawTags)];

        // ★ URL 提取和验证
        const hrefRaw = anchor.getAttribute('href') || '';
        if (!hrefRaw) return;
        let url = hrefRaw.startsWith('http') ? hrefRaw : new URL(hrefRaw, location.href).toString();
        
        // 确保是真实房源链接
        if (!url.includes('/zufang/') && !url.includes('/chuzu/') && !url.includes('lianjia.com')) {
          return;
        }
        
        // 去重
        const uniqueKey = url.split('?')[0];
        if (seen.has(uniqueKey)) return;
        seen.add(uniqueKey);

        // ★ 构造房源对象
        const listing = {
          title: title,
          price,
          community: community || '未知小区',
          district: district || '未知区域',
          roomType: roomMatch ? roomMatch[1] : '未知',
          area: areaMatch ? areaMatch[1] : '未知',
          floor: floorMatch ? floorMatch[1] : '',
          tags: rawTags.slice(0, 6),
          url,
          imageUrl: container.querySelector('img')?.getAttribute('src') || '',
          platform: 'lianjia',
        };

        // 最终质量检查
        if (isValidListing(listing)) {
          listings.push(listing);
        }
      } catch (e) {
        // ignore
      }
    });

    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: 'scrape_result',
      success: true,
      listings,
      count: listings.length,
      debug: {
        title: document.title,
        url: location.href,
        foundCards: houseCards.length,
        validListings: listings.length,
        is404: document.title.includes('404') || document.body.innerText.includes('页面不存在'),
      },
    }));

  } catch (error) {
    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: 'scrape_result',
      success: false,
      reason: error.message || '脚本执行失败',
      error: error.toString(),
      stack: error.stack,
      count: 0,
    }));
  } finally {
    // 确保总是发送完成信号
    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: 'script_completed',
      platform: 'lianjia',
      timestamp: Date.now()
    }));
  }
})();
`;

// ── 自如列表页抓取脚本 ──────────────────────────────────────
const ZIROOM_SCRAPER = `
(function() {
  try {
    // ★ 人机验证检测（优先级最高）
    const bodyText = document.body.textContent || '';
    const bodyHTML = document.body.innerHTML || '';
    
    // 检测常见的人机验证特征
    if (
      bodyText.includes('请完成安全验证') ||
      bodyText.includes('人机验证') ||
      bodyText.includes('安全验证') ||
      bodyText.includes('滑动验证') ||
      bodyText.includes('点击验证') ||
      bodyHTML.includes('captcha') ||
      bodyHTML.includes('verify') ||
      bodyHTML.includes('geetest') ||
      document.querySelector('.geetest_panel, .geetest_holder, [class*="captcha"], [class*="verify"]')
    ) {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'scrape_result',
        success: false,
        needLogin: true,
        reason: '检测到人机验证，需要手动完成验证',
        count: 0,
        listings: [],
      }));
      return;
    }

    // ★ 质量验证函数
    function isValidListing(listing) {
      if (!listing.title || listing.title.length < 4) return false;
      if (!listing.price || listing.price < 500 || listing.price > 50000) return false;
      if (!listing.url || !listing.url.includes('ziroom.com')) return false;
      return true;
    }

    const listings = [];
    const seen = new Set();

    // ★ 多策略选择器：尝试多种可能的房源容器
    const containerSelectors = [
      '.Z_list-box .item',
      '.rooms_list .item',
      '[class*="room_card"]',
      '[class*="Z_list"]>div',
      '[class*="roomList"]>div',
      '.list-box .item',
      '.room-list .room-item',
      '[data-id]',
    ];

    let houseCards = [];
    for (const selector of containerSelectors) {
      houseCards = Array.from(document.querySelectorAll(selector));
      if (houseCards.length > 0) {
        console.log('[Ziroom Scraper] Found ' + houseCards.length + ' cards with selector: ' + selector);
        break;
      }
    }

    if (houseCards.length === 0) {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'scrape_result',
        success: false,
        reason: '未找到房源列表，可能需要登录或页面结构已变化',
        count: 0,
        listings: [],
        debug: {
          title: document.title,
          url: location.href,
          bodyLength: document.body.innerHTML.length,
        },
      }));
      return;
    }

    // ★ 遍历每个房源卡片
    houseCards.forEach(function(container) {
      try {
        const text = container.textContent || '';

        // ★ 标题和链接提取（多策略）
        const titleSelectors = [
          '.title a',
          '.info_title a',
          '[class*="title"] a',
          'a[href*="/z/vr/"]',
          'a[href*="/x/"]',
          'a[href*="/detail/"]',
          'h3 a',
          'h4 a',
        ];

        let anchor = null;
        let title = '';
        
        for (const sel of titleSelectors) {
          anchor = container.querySelector(sel);
          if (anchor) {
            title = (anchor.textContent || anchor.innerText || '')
              .replace(/\\s{2,}/g, ' ')
              .trim();
            if (title && title.length >= 4) break;
          }
        }

        if (!title || title.length < 4) return;

        // ★ 价格提取（多策略）
        let price = 0;
        const priceSelectors = [
          '.price .num',
          '[class*="price"] .num',
          '[class*="price"] span',
          '.num',
          'em.price',
          'span.price',
          '[class*="price"]',
        ];

        for (const sel of priceSelectors) {
          const el = container.querySelector(sel);
          if (el) {
            const pm = el.textContent.match(/(\\d{3,6})/);
            if (pm) {
              price = parseInt(pm[1], 10);
              break;
            }
          }
        }

        if (!price) {
          const pm = text.match(/(\\d{3,6})\\s*元\\/月|月租\\s*(\\d{3,6})/);
          if (pm) price = parseInt(pm[1] || pm[2], 10);
        }

        if (!price || price < 500 || price > 50000) return;

        // ★ 描述信息提取
        const descSelectors = [
          '.desc',
          '.info',
          '[class*="desc"]',
          '[class*="info"]',
          '.room-info',
        ];

        let desc = '';
        for (const sel of descSelectors) {
          const descEl = container.querySelector(sel);
          if (descEl) {
            desc = (descEl.textContent || '').trim();
            if (desc.length > 5) break;
          }
        }

        // ★ 从描述中提取信息（自如通常格式：小区名/房型/面积）
        const parts = desc.split('/').map(p => p.trim());
        let community = parts[0] || '';
        let roomType = parts[1] || '';
        let area = parts[2] || '';

        // 如果描述解析失败，尝试从文本中提取
        if (!community) {
          const commMatch = text.match(/([\\u4e00-\\u9fa5]{2,20}(?:小区|花园|公寓|里|苑|家园|新村|大厦|中心|广场|城|庭|园|邸|府|轩|居|坊|阁|湾|庄))/);
          if (commMatch) community = commMatch[1];
        }

        if (!roomType) {
          const roomMatch = text.match(/(\\d室\\d厅|\\d室|合租|整租|主卧|次卧|一居|两居|三居|四居)/);
          if (roomMatch) roomType = roomMatch[1];
        }

        if (!area) {
          const areaMatch = text.match(/(\\d+(?:\\.\\d+)?\\s*(?:㎡|平米?|平方米))/);
          if (areaMatch) area = areaMatch[1];
        }

        // ★ 标签提取
        const tagEls = container.querySelectorAll('.tag, .label, [class*="tag"], [class*="label"]');
        let rawTags = [];
        if (tagEls.length > 0) {
          rawTags = Array.from(tagEls).map(el => {
            const t = el.textContent.trim();
            if (t.length < 2 || t.length > 10) return '';
            if (/^[\\d\\.]+$/.test(t)) return '';
            return t;
          }).filter(Boolean);
        }
        rawTags = [...new Set(rawTags)];

        // ★ URL 提取和验证
        const hrefRaw = anchor ? anchor.getAttribute('href') : '';
        if (!hrefRaw) return;
        
        let url = hrefRaw;
        if (url.indexOf('http') !== 0) {
          if (url[0] === '/') url = 'https://www.ziroom.com' + url;
          else url = 'https://www.ziroom.com/' + url;
        }

        // 确保是真实房源链接
        if (!url.includes('ziroom.com')) return;

        // 去重
        const uniqueKey = url.split('?')[0];
        if (seen.has(uniqueKey)) return;
        seen.add(uniqueKey);

        // ★ 图片提取
        let imageUrl = '';
        const imgEl = container.querySelector('img');
        if (imgEl) {
          imageUrl = imgEl.getAttribute('src') || imgEl.getAttribute('data-src') || '';
        }

        // ★ 构造房源对象
        const listing = {
          title: title,
          price: price,
          community: community || '未知小区',
          district: '', // 自如通常不显示区域
          roomType: roomType || '未知',
          area: area || '未知',
          floor: '', // 自如通常不显示楼层
          tags: rawTags.slice(0, 6),
          url: url,
          imageUrl: imageUrl,
          platform: 'ziroom',
        };

        // 最终质量检查
        if (isValidListing(listing)) {
          listings.push(listing);
        }
      } catch (e) {
        // ignore individual item errors
      }
    });

    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: 'scrape_result',
      success: true,
      listings: listings,
      count: listings.length,
      debug: {
        title: document.title,
        url: location.href,
        foundCards: houseCards.length,
        validListings: listings.length,
      },
    }));

  } catch (error) {
    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: 'scrape_result',
      success: false,
      reason: error.message || '脚本执行失败',
      count: 0,
    }));
  }
})();
`;

// ── 58同城列表页抓取脚本 ────────────────────────────────────
const W58_SCRAPER = `
(function() {
  try {
    // ★ 人机验证检测（优先级最高）
    const bodyText = document.body.textContent || '';
    const bodyHTML = document.body.innerHTML || '';
    
    // 检测常见的人机验证特征
    if (
      bodyText.includes('请完成安全验证') ||
      bodyText.includes('人机验证') ||
      bodyText.includes('安全验证') ||
      bodyText.includes('滑动验证') ||
      bodyText.includes('点击验证') ||
      bodyText.includes('验证码') ||
      bodyHTML.includes('captcha') ||
      bodyHTML.includes('verify') ||
      bodyHTML.includes('geetest') ||
      document.querySelector('.geetest_panel, .geetest_holder, [class*="captcha"], [class*="verify"], [class*="slider"]')
    ) {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'scrape_result',
        success: false,
        needLogin: true,
        reason: '检测到人机验证，需要手动完成验证',
        count: 0,
        listings: [],
      }));
      return;
    }

    // ★ 质量验证函数
    function isValidListing(listing) {
      if (!listing.title || listing.title.length < 4) return false;
      if (!listing.price || listing.price < 300 || listing.price > 50000) return false;
      if (!listing.url || !listing.url.includes('58.com')) return false;
      // 过滤广告标题
      if (/^(推广|广告|置顶)/.test(listing.title)) return false;
      return true;
    }

    const listings = [];
    const seen = new Set();

    // ★ 多策略选择器：尝试多种可能的房源容器
    const containerSelectors = [
      '.listUl>li',
      '.house-list>li',
      '[class*="house-list"]>li',
      '[class*="listUl"]>li',
      '.list-con>div',
      '[class*="listInfo"]',
      '.house-cell',
      '[class*="houseList"]>li',
      '[data-id]',
    ];

    let houseCards = [];
    for (const selector of containerSelectors) {
      houseCards = Array.from(document.querySelectorAll(selector));
      if (houseCards.length > 0) {
        console.log('[58 Scraper] Found ' + houseCards.length + ' cards with selector: ' + selector);
        break;
      }
    }

    if (houseCards.length === 0) {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'scrape_result',
        success: false,
        reason: '未找到房源列表，可能需要登录或页面结构已变化',
        count: 0,
        listings: [],
        debug: {
          title: document.title,
          url: location.href,
          bodyLength: document.body.innerHTML.length,
        },
      }));
      return;
    }

    // ★ 遍历每个房源卡片
    houseCards.forEach(function(container) {
      try {
        const text = container.textContent || '';

        // ★ 标题和链接提取（多策略）
        const titleSelectors = [
          '.des h2 a',
          '.house-desc h2 a',
          '[class*="title"] a',
          'a[href*="/zufang/"]',
          'h2 a',
          'h3 a',
          '.house-title a',
          '[class*="houseName"] a',
        ];

        let anchor = null;
        let title = '';
        
        for (const sel of titleSelectors) {
          anchor = container.querySelector(sel);
          if (anchor) {
            title = (anchor.textContent || anchor.innerText || '')
              .replace(/\\s{2,}/g, ' ')
              .trim();
            if (title && title.length >= 4) break;
          }
        }

        // 过滤广告和无效标题
        if (!title || title.length < 4) return;
        if (/^(推广|广告|置顶|精选|热门推荐)/.test(title)) return;

        // ★ 价格提取（多策略）
        let price = 0;
        const priceSelectors = [
          '.money b',
          '[class*="money"] b',
          '[class*="price"] b',
          '.price',
          '[class*="price"]',
          '.money',
          'b.price',
        ];

        for (const sel of priceSelectors) {
          const el = container.querySelector(sel);
          if (el) {
            const pm = el.textContent.match(/(\\d{3,6})/);
            if (pm) {
              price = parseInt(pm[1], 10);
              break;
            }
          }
        }

        if (!price) {
          const pm = text.match(/(\\d{3,6})\\s*元\\/月|月租\\s*(\\d{3,6})/);
          if (pm) price = parseInt(pm[1] || pm[2], 10);
        }

        if (!price || price < 300 || price > 50000) return;

        // ★ 描述信息提取
        const descSelectors = [
          '.des',
          '.house-desc',
          '[class*="desc"]',
          '.house-info',
          '[class*="info"]',
        ];

        let desc = '';
        for (const sel of descSelectors) {
          const descEl = container.querySelector(sel);
          if (descEl) {
            desc = (descEl.textContent || '').trim();
            if (desc.length > 5) break;
          }
        }

        // ★ 从描述中提取信息（58同城通常格式：小区名/房型/面积）
        const parts = desc.split('/').map(p => p.trim());
        let community = parts[0] || '';
        let roomType = parts[1] || '';
        let area = parts[2] || '';

        // 如果描述解析失败，尝试从文本中提取
        if (!community) {
          const commMatch = text.match(/([\\u4e00-\\u9fa5]{2,20}(?:小区|花园|公寓|里|苑|家园|新村|大厦|中心|广场|城|庭|园|邸|府|轩|居|坊|阁|湾|庄))/);
          if (commMatch) community = commMatch[1];
        }

        if (!roomType) {
          const roomMatch = text.match(/(\\d室\\d厅|\\d室|合租|整租|主卧|次卧|一居|两居|三居|四居)/);
          if (roomMatch) roomType = roomMatch[1];
        }

        if (!area) {
          const areaMatch = text.match(/(\\d+(?:\\.\\d+)?\\s*(?:㎡|平米?|平方米))/);
          if (areaMatch) area = areaMatch[1];
        }

        // ★ 标签提取
        const tagEls = container.querySelectorAll('.tag, .label, [class*="tag"], [class*="label"]');
        let rawTags = [];
        if (tagEls.length > 0) {
          rawTags = Array.from(tagEls).map(el => {
            const t = el.textContent.trim();
            if (t.length < 2 || t.length > 10) return '';
            if (/^[\\d\\.]+$/.test(t)) return '';
            if (/^(推广|广告|置顶)$/.test(t)) return '';
            return t;
          }).filter(Boolean);
        }
        rawTags = [...new Set(rawTags)];

        // ★ URL 提取和验证
        const hrefRaw = anchor ? anchor.getAttribute('href') : '';
        if (!hrefRaw) return;
        
        let url = hrefRaw;
        if (url.indexOf('http') !== 0) {
          if (url[0] === '/') url = 'https://bj.58.com' + url;
          else url = 'https://bj.58.com/' + url;
        }

        // 确保是真实房源链接
        if (!url.includes('58.com') || !url.includes('zufang')) return;

        // 去重
        const uniqueKey = url.split('?')[0];
        if (seen.has(uniqueKey)) return;
        seen.add(uniqueKey);

        // ★ 图片提取
        let imageUrl = '';
        const imgEl = container.querySelector('img');
        if (imgEl) {
          imageUrl = imgEl.getAttribute('src') || imgEl.getAttribute('data-src') || imgEl.getAttribute('lazy-src') || '';
        }

        // ★ 构造房源对象
        const listing = {
          title: title,
          price: price,
          community: community || '未知小区',
          district: '', // 58同城通常不显示区域
          roomType: roomType || '未知',
          area: area || '未知',
          floor: '', // 58同城通常不显示楼层
          tags: rawTags.slice(0, 6),
          url: url,
          imageUrl: imageUrl,
          platform: 'w58',
        };

        // 最终质量检查
        if (isValidListing(listing)) {
          listings.push(listing);
        }
      } catch (e) {
        // ignore individual item errors
      }
    });

    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: 'scrape_result',
      success: true,
      listings: listings,
      count: listings.length,
      debug: {
        title: document.title,
        url: location.href,
        foundCards: houseCards.length,
        validListings: listings.length,
      },
    }));

  } catch (error) {
    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: 'scrape_result',
      success: false,
      reason: error.message || '脚本执行失败',
      count: 0,
    }));
  }
})();
`;

// ── 详情页内容提取脚本 ────────────────────────────────────────
// 在房源详情 WebView 中注入，提取正文摘要 + 设施词 + 图片 URL
export const DETAIL_EXTRACT_SCRIPT = `
(function() {
  try {
    var text = ((document.body && document.body.innerText) || '').trim().slice(0, 2000);
    var facilities = [];
    var facilityWords = ['空调','冰箱','洗衣机','热水器','燃气','天然气','暖气','地暖','电梯','宽带','WiFi','wifi','衣柜','床','沙发','电视','书桌','电磁炉','微波炉','独卫','阳台','油烟机','洗碗机'];
    var i, w, u;
    for (i = 0; i < facilityWords.length; i++) {
      w = facilityWords[i];
      if (text.indexOf(w) >= 0 && facilities.indexOf(w) < 0) facilities.push(w);
    }
    // 挂牌天数
    var daysHint = '';
    var daysMatch = text.match(/(\\d+)天前发布|(\\d+)天前更新|挂牌(\\d+)天/);
    if (daysMatch) daysHint = daysMatch[0];
    
    // 图片 URL（增强提取，针对不同平台）
    var imgs = [];
    var seenUrls = {};
    
    // 策略1：优先提取实拍图（贝壳）- 增强选择器
    var beikeImgs = document.querySelectorAll('.imgList img, .album-img img, .picbox img, [class*="album"] img, [class*="photo"] img, [class*="imgList"] img, [class*="picList"] img, .houseDetail img, .house-detail img');
    for (i = 0; i < beikeImgs.length && imgs.length < 8; i++) {
      u = beikeImgs[i].getAttribute('src') || beikeImgs[i].getAttribute('data-original') || beikeImgs[i].getAttribute('data-src') || beikeImgs[i].getAttribute('data-lazy-src') || beikeImgs[i].getAttribute('data-img');
      if (!u) continue;
      if (u.indexOf('//') === 0) u = 'https:' + u;
      if (u.indexOf('http') !== 0) continue;
      if (/\\.svg($|\\?)/i.test(u)) continue;
      if (/icon|logo|avatar|placeholder|default/i.test(u)) continue;
      if (u.indexOf('data:image') === 0) continue;
      if (!seenUrls[u]) {
        seenUrls[u] = true;
        imgs.push(u);
      }
    }
    
    // 策略2：安居客实拍图 - 增强选择器
    var anjukeImgs = document.querySelectorAll('.house-photo img, .photo-list img, .pic-list img, [class*="housePhoto"] img, [class*="photoList"] img, [class*="picList"] img, .house-img img, [class*="houseImg"] img, .detail-img img');
    for (i = 0; i < anjukeImgs.length && imgs.length < 8; i++) {
      u = anjukeImgs[i].getAttribute('src') || anjukeImgs[i].getAttribute('data-src') || anjukeImgs[i].getAttribute('data-original') || anjukeImgs[i].getAttribute('data-lazy-src') || anjukeImgs[i].getAttribute('data-img');
      if (!u) continue;
      if (u.indexOf('//') === 0) u = 'https:' + u;
      if (u.indexOf('http') !== 0) continue;
      if (/\\.svg($|\\?)/i.test(u)) continue;
      if (/icon|logo|avatar|placeholder|default/i.test(u)) continue;
      if (u.indexOf('data:image') === 0) continue;
      if (!seenUrls[u]) {
        seenUrls[u] = true;
        imgs.push(u);
      }
    }
    
    // 策略3：通用图片（过滤小图标）
    if (imgs.length < 3) {
      var allImgs = document.querySelectorAll('img[src]');
      for (i = 0; i < allImgs.length && imgs.length < 8; i++) {
        u = allImgs[i].getAttribute('src') || allImgs[i].getAttribute('data-src') || allImgs[i].getAttribute('data-original');
        if (!u) continue;
        if (u.indexOf('//') === 0) u = 'https:' + u;
        if (u.indexOf('http') !== 0) continue;
        if (/\\.svg($|\\?)/i.test(u)) continue;
        if (/icon|logo|avatar|placeholder|btn|button/i.test(u)) continue;
        var w2 = allImgs[i].naturalWidth || allImgs[i].width;
        var h2 = allImgs[i].naturalHeight || allImgs[i].height;
        if (w2 && w2 < 100) continue;
        if (h2 && h2 < 100) continue;
        if (!seenUrls[u]) {
          seenUrls[u] = true;
          imgs.push(u);
        }
      }
    }
    
    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: 'pageExtract',
      text: text,
      facilities: facilities,
      imageUrls: imgs,
      listedDaysHint: daysHint,
    }));
  } catch(e) {
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'detail_extract', text: '', facilities: [], imageUrls: [], listedDaysHint: '' }));
  }
})();
true;
`;

export function getDetailExtractScript(): string {
  return DETAIL_EXTRACT_SCRIPT;
}
