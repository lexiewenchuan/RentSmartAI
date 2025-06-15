/**
 * 小红书自动爬取脚本
 * 用于自动浏览帖子并提取内容
 */

/**
 * 小红书搜索页自动浏览脚本
 * 自动点击帖子、停留随机时间、提取内容、返回列表
 * 优化版：增加随机化、重试机制、更好的错误处理
 */
export const XHS_AUTO_SCRAPER = `
(function() {
  console.log('[XHS Auto Scraper] Starting...');
  
  let currentIndex = 0;
  let viewedPosts = [];
  let retryCount = 0;
  let shouldStop = false; // 支持中断
  const MAX_RETRY = 3; // 最大重试次数
  const MAX_POSTS = 20; // 最多尝试20篇
  const GLOBAL_TIMEOUT = 5 * 60 * 1000; // 全局超时：5分钟
  const startTime = Date.now(); // 记录开始时间
  
  // 随机化参数（反爬虫）
  function getRandomDuration(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }
  
  const VIEW_DURATION = () => getRandomDuration(3000, 8000); // 3-8秒随机停留
  const BACK_DELAY = () => getRandomDuration(800, 1500); // 返回延迟随机化
  const SCROLL_DELAY = () => getRandomDuration(500, 1500); // 滚动延迟
  
  // 检测验证码
  function detectCaptcha() {
    const captchaSelectors = [
      '.captcha', '.verify', '.slider-verify',
      '[class*="captcha"]', '[class*="verify"]',
      '[id*="captcha"]', '[id*="verify"]',
      '[class*="Verify"]', '[class*="slider"]'
    ];
    
    for (const sel of captchaSelectors) {
      if (document.querySelector(sel)) {
        return true;
      }
    }
    
    // 检查是否有验证相关的文本
    const bodyText = document.body.innerText || '';
    if (bodyText.includes('验证') || bodyText.includes('滑动') || bodyText.includes('人机')) {
      return true;
    }
    
    return false;
  }
  
  // 等待验证码完成
  let captchaWaitingStartTime = 0;
  let captchaCheckInterval = null;
  
  function waitForCaptchaCompletion() {
    captchaWaitingStartTime = Date.now();
    
    // 发送验证码检测消息
    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: 'xhs_captcha_detected',
      message: '检测到人机验证，请完成验证',
      timestamp: captchaWaitingStartTime
    }));
    
    // 定期检查验证码是否完成
    captchaCheckInterval = setInterval(() => {
      const hasCaptcha = detectCaptcha();
      const waitTime = Date.now() - captchaWaitingStartTime;
      
      if (!hasCaptcha) {
        // 验证码已完成
        clearInterval(captchaCheckInterval);
        captchaCheckInterval = null;
        
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'xhs_captcha_solved',
          message: '验证完成，继续爬取',
          waitTime: Math.round(waitTime / 1000)
        }));
        
        // 继续爬取流程
        setTimeout(viewNextPost, 1000);
      } else if (waitTime > 120000) {
        // 超过2分钟仍未完成
        clearInterval(captchaCheckInterval);
        captchaCheckInterval = null;
        
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'xhs_error',
          errorType: 'captcha_timeout',
          message: '验证超时，请重新开始'
        }));
      }
    }, 1000);
  }
  
  // 等待页面内容加载
  function waitForContent(selector, timeout = 5000) {
    return new Promise((resolve) => {
      const startTime = Date.now();
      const checkInterval = setInterval(() => {
        const el = document.querySelector(selector);
        if (el || Date.now() - startTime > timeout) {
          clearInterval(checkInterval);
          resolve(!!el);
        }
      }, 100);
    });
  }
  
  // 提取帖子内容（优化版 + 详细日志）
  async function extractPostContent() {
    try {
      console.log('[XHS Extract] Starting extraction for:', window.location.href);
      
      // 等待主要内容加载
      const titleFound = await waitForContent('h1, [class*="title"], [class*="Title"]', 3000);
      console.log('[XHS Extract] Title element found:', titleFound);
      
      const data = {
        title: '',
        content: '',
        author: '',
        images: [],
        url: window.location.href,
        scrapedAt: new Date().toISOString()
      };
      
      // 标题提取（更通用的选择器）
      const titleSelectors = [
        'h1',
        '[class*="title"][class*="note"]',
        '[class*="Title"]',
        '[class*="noteTitle"]',
        '.note-title',
        '.title',
        '#detail-title'
      ];
      for (const sel of titleSelectors) {
        const el = document.querySelector(sel);
        if (el && el.textContent.trim() && el.textContent.trim().length > 2) {
          data.title = el.textContent.trim();
          break;
        }
      }
      
      // 内容提取（更通用的选择器）
      const contentSelectors = [
        '[class*="noteContent"]',
        '[class*="note-content"]',
        '[class*="desc"][class*="note"]',
        '[class*="content"][class*="detail"]',
        '.note-content',
        '.content',
        '.desc',
        '#detail-desc'
      ];
      for (const sel of contentSelectors) {
        const el = document.querySelector(sel);
        if (el && el.textContent.trim().length > 20) {
          data.content = el.textContent.trim();
          break;
        }
      }
      
      // 如果没找到内容，尝试提取所有段落文本
      if (!data.content || data.content.length < 20) {
        const paragraphs = Array.from(document.querySelectorAll('p, div[class*="text"]'))
          .map(el => el.textContent.trim())
          .filter(text => text.length > 10);
        if (paragraphs.length > 0) {
          data.content = paragraphs.join(' ').slice(0, 1000);
        }
      }
      
      // 作者提取（更通用的选择器）
      const authorSelectors = [
        '[class*="author"][class*="name"]',
        '[class*="user"][class*="name"]',
        '[class*="nickname"]',
        '.author-name',
        '.user-name',
        '.nickname',
        'a[href*="/user/"]'
      ];
      for (const sel of authorSelectors) {
        const el = document.querySelector(sel);
        if (el && el.textContent.trim() && el.textContent.trim().length > 1) {
          data.author = el.textContent.trim();
          break;
        }
      }
      
      // 图片提取
      const imgSelectors = [
        '.note-image img', '.content-image img',
        '.swiper-slide img', '[class*="image"] img'
      ];
      const images = new Set();
      imgSelectors.forEach(sel => {
        document.querySelectorAll(sel).forEach(img => {
          const src = img.src || img.getAttribute('data-src') || '';
          if (src && src.startsWith('http') && !src.includes('avatar')) {
            images.add(src);
          }
        });
      });
      data.images = Array.from(images).slice(0, 5);
      
      return data;
    } catch (error) {
      console.error('[XHS] Extract error:', error);
      return null;
    }
  }
  
  // 获取帖子列表
  function getPostElements() {
    const selectors = [
      '.note-item', '.search-item', '.feed-item',
      '[class*="note"]', '[class*="item"]',
      'a[href*="/explore/"]'
    ];
    
    const posts = [];
    for (const sel of selectors) {
      const elements = document.querySelectorAll(sel);
      if (elements.length > 0) {
        elements.forEach(el => {
          // 确保是可点击的帖子链接
          if (el.tagName === 'A' || el.querySelector('a')) {
            posts.push(el);
          }
        });
        if (posts.length > 0) break;
      }
    }
    
    return posts;
  }
  
  // 点击帖子
  function clickPost(postElement) {
    try {
      const link = postElement.tagName === 'A' ? postElement : postElement.querySelector('a');
      if (link) {
        link.click();
        return true;
      }
      postElement.click();
      return true;
    } catch (error) {
      console.error('[XHS] Click error:', error);
      return false;
    }
  }
  
  // 模拟滚动行为（反爬虫）
  function simulateScroll() {
    const scrollHeight = document.documentElement.scrollHeight;
    const viewportHeight = window.innerHeight;
    const maxScroll = scrollHeight - viewportHeight;
    
    if (maxScroll > 0) {
      const scrollTo = Math.random() * Math.min(maxScroll, 500);
      window.scrollTo({
        top: scrollTo,
        behavior: 'smooth'
      });
    }
  }
  
  // 主流程：浏览下一篇帖子
  function viewNextPost() {
    // ★ 检查全局超时
    if (Date.now() - startTime > GLOBAL_TIMEOUT) {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'xhs_error',
        errorType: 'global_timeout',
        message: '爬取超时（5分钟），已自动停止',
        totalViewed: viewedPosts.length,
        posts: viewedPosts
      }));
      shouldStop = true;
      return;
    }
    
    // 检查是否被中断
    if (shouldStop) {
      console.log('[XHS] Stopped by user or timeout');
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'xhs_stopped',
        totalViewed: viewedPosts.length,
        posts: viewedPosts,
        message: '用户中断爬取'
      }));
      return;
    }
    
    // 检查是否完成
    if (currentIndex >= MAX_POSTS) {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'xhs_complete',
        totalViewed: viewedPosts.length,
        posts: viewedPosts,
        reason: 'max_reached'
      }));
      return;
    }
    
    // 检查验证码
    if (detectCaptcha()) {
      // 如果已经在等待验证码，不重复触发
      if (!captchaCheckInterval) {
        waitForCaptchaCompletion();
      }
      return;
    }
    
    // 获取帖子列表
    const posts = getPostElements();
    if (posts.length === 0) {
      // 重试机制
      if (retryCount < MAX_RETRY) {
        retryCount++;
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'xhs_scraper_progress',
          status: 'scraping',
          message: \`未找到帖子列表，重试中 (\${retryCount}/\${MAX_RETRY})...\`
        }));
        setTimeout(viewNextPost, 2000);
        return;
      }
      
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'xhs_error',
        errorType: 'no_posts',
        message: '未找到帖子列表，请确认在小红书搜索结果页'
      }));
      return;
    }
    
    // 重置重试计数
    retryCount = 0;
    
    // 检查索引是否超出
    if (currentIndex >= posts.length) {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'xhs_complete',
        totalViewed: viewedPosts.length,
        posts: viewedPosts,
        reason: 'no_more_posts'
      }));
      return;
    }
    
    // 发送实时进度
    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: 'xhs_scraper_progress',
      status: 'scraping',
      message: \`正在浏览第 \${currentIndex + 1}/\${Math.min(posts.length, MAX_POSTS)} 篇帖子...\`,
      progress: {
        current: currentIndex + 1,
        total: Math.min(posts.length, MAX_POSTS),
        validCount: viewedPosts.length
      }
    }));
    
    // 点击帖子
    const post = posts[currentIndex];
    const clicked = clickPost(post);
    
    if (!clicked) {
      currentIndex++;
      setTimeout(viewNextPost, 500);
      return;
    }
    
    // 随机停留时间
    const viewDuration = VIEW_DURATION();
    
    // 等待页面加载并提取内容
    setTimeout(async () => {
      // ★ 再次检查停止标志
      if (shouldStop) {
        console.log('[XHS] Stopped during post viewing');
        return;
      }
      
      // 模拟滚动阅读
      simulateScroll();
      
      setTimeout(async () => {
        // ★ 再次检查停止标志
        if (shouldStop) {
          console.log('[XHS] Stopped before content extraction');
          return;
        }
        
        const data = await extractPostContent();
        
        if (data && data.title && data.content.length > 20) {
          viewedPosts.push(data);
          
          // 发送帖子数据（带标题预览）
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'xhs_post',
            index: viewedPosts.length - 1,
            data: data,
            preview: {
              title: data.title.slice(0, 30) + (data.title.length > 30 ? '...' : ''),
              validCount: viewedPosts.length
            }
          }));
        } else {
          // 无效帖子，跳过
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'xhs_skip',
            index: currentIndex,
            reason: data ? '内容不足' : '提取失败'
          }));
        }
        
        // ★ 检查停止标志再返回
        if (shouldStop) {
          console.log('[XHS] Stopped before going back');
          return;
        }
        
        // 返回列表
        currentIndex++;
        const backDelay = BACK_DELAY();
        setTimeout(() => {
          if (shouldStop) {
            console.log('[XHS] Stopped before history.back()');
            return;
          }
          window.history.back();
          setTimeout(() => {
            if (!shouldStop) {
              viewNextPost();
            }
          }, backDelay);
        }, 500);
        
      }, SCROLL_DELAY());
      
    }, viewDuration);
  }
  
  // 监听中断信号和验证完成信号
  window.addEventListener('message', function(event) {
    try {
      const message = JSON.parse(event.data);
      if (message.type === 'xhs_stop') {
        shouldStop = true;
        console.log('[XHS] Stop signal received');
        
        // 清理验证码检查定时器
        if (captchaCheckInterval) {
          clearInterval(captchaCheckInterval);
          captchaCheckInterval = null;
        }
      } else if (message.type === 'xhs_captcha_continue') {
        // 用户手动确认验证完成
        console.log('[XHS] User confirmed captcha solved');
        if (captchaCheckInterval) {
          clearInterval(captchaCheckInterval);
          captchaCheckInterval = null;
        }
        
        // 立即检查并继续
        if (!detectCaptcha()) {
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'xhs_captcha_solved',
            message: '验证确认完成，继续爬取'
          }));
          setTimeout(viewNextPost, 1000);
        } else {
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'xhs_captcha_still_present',
            message: '验证尚未完成，请继续'
          }));
        }
      }
    } catch (e) {
      // 忽略非JSON消息
    }
  });
  
  // 发送初始状态
  window.ReactNativeWebView.postMessage(JSON.stringify({
    type: 'xhs_scraper_progress',
    status: 'scraping',
    message: '脚本已注入，开始搜索评价...'
  }));
  
  // 启动
  setTimeout(() => {
    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: 'xhs_scraper_progress',
      status: 'scraping',
      message: '开始自动浏览帖子...'
    }));
    viewNextPost();
  }, 2000);
  
})();
`;

/**
 * 构建小红书搜索URL（支持多种搜索策略）
 */
export function buildXHSSearchUrl(community: string, district?: string, strategy: number = 0): string {
  let query = '';
  
  // 多种搜索策略，提高找到相关内容的概率
  const strategies = [
    // 策略0: 小区名 + 租房（默认）
    `${community} 租房`,
    // 策略1: 小区名 + 居住体验
    `${community} 居住体验`,
    // 策略2: 小区名 + 评价
    `${community} 评价`,
    // 策略3: 区域 + 小区名 + 租房（如果有区域信息）
    district ? `${district} ${community} 租房` : `${community} 租房`,
    // 策略4: 小区名 + 真实感受
    `${community} 真实感受`,
  ];
  
  query = strategies[strategy] || strategies[0];
  
  const encoded = encodeURIComponent(query.trim());
  return `https://www.xiaohongshu.com/search_result?keyword=${encoded}&type=note`;
}

/**
 * 获取所有搜索策略的URL
 */
export function getAllXHSSearchUrls(community: string, district?: string): string[] {
  return [0, 1, 2, 3, 4].map(strategy => buildXHSSearchUrl(community, district, strategy));
}
