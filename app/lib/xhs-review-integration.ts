/**
 * Xiaohongshu Review Integration Helper
 * 
 * This file contains the complete implementation for integrating XHS reviews
 * into the listing detail page. Import and use these functions in listing/[id].tsx
 */

import { getXHSReviewByListingId, saveXHSReview, type Listing, type XHSReviewRecord } from './storage';
import { collectValidPosts, generateXHSReviewSummary, type XHSPost, type XHSReviewState } from './xiaohongshu-review';
import { buildXHSSearchUrl, XHS_AUTO_SCRAPER } from './xiaohongshu-scraper';

/**
 * XHS Review UI State
 */
export type XHSReviewUIState = {
  loading: boolean;
  error: string;
  reviewState: XHSReviewState | null;
  review: XHSReviewRecord | null;
  showModal: boolean;
  webViewUrl: string;
  showCaptchaModal: boolean; // 新增：显示验证码Modal
};

/**
 * Initialize XHS review state
 */
export function createInitialXHSState(): XHSReviewUIState {
  return {
    loading: false,
    error: '',
    reviewState: null,
    review: null,
    showModal: false,
    webViewUrl: '',
    showCaptchaModal: false,
  };
}

/**
 * Load existing XHS review for a listing
 */
export async function loadExistingXHSReview(listingId: string): Promise<XHSReviewRecord | null> {
  try {
    return await getXHSReviewByListingId(listingId);
  } catch (error) {
    console.error('[XHS] Failed to load existing review:', error);
    return null;
  }
}

/**
 * Start XHS review collection process
 */
export function startXHSReviewCollection(
  listing: Listing
): { url: string; shouldStart: boolean; error?: string } {
  if (!listing.community) {
    return {
      url: '',
      shouldStart: false,
      error: '房源缺少小区信息，无法搜索评价',
    };
  }

  const city = listing.cityCode || 'bj';
  const url = buildXHSSearchUrl(listing.community, listing.roomType);

  return {
    url,
    shouldStart: true,
  };
}

/**
 * Handle WebView message from XHS scraper
 */
export async function handleXHSScraperMessage(
  data: string,
  listing: Listing,
  onStateUpdate: (state: Partial<XHSReviewState>) => void,
  onComplete: (review: XHSReviewRecord) => void,
  onError: (error: string) => void
): Promise<void> {
  try {
    const message = JSON.parse(data);

    // Handle scraper progress updates
    if (message.type === 'xhs_scraper_progress') {
      onStateUpdate({
        status: message.status || 'scraping',
        progress: message.message || '搜索中...',
        totalScraped: message.progress?.current || 0,
        validCount: message.progress?.validCount || 0,
      });
      return;
    }

    // Handle individual post scraped
    if (message.type === 'xhs_post') {
      const preview = message.preview;
      if (preview) {
        onStateUpdate({
          status: 'scraping',
          progress: `已收集 ${preview.validCount} 篇有效评价：${preview.title}`,
          validCount: preview.validCount,
        });
      }
      return;
    }

    // Handle post skipped
    if (message.type === 'xhs_skip') {
      onStateUpdate({
        status: 'scraping',
        progress: `跳过无效内容 (${message.reason})`,
      });
      return;
    }

    // Handle captcha detection (old message type - for compatibility)
    if (message.type === 'xhs_captcha') {
      onStateUpdate({
        status: 'captcha',
        progress: '检测到人机验证，请完成验证',
      });
      return;
    }

    // Handle captcha detected (new message type)
    if (message.type === 'xhs_captcha_detected') {
      onStateUpdate({
        status: 'captcha',
        progress: '⚠️ 检测到人机验证，请在弹出窗口中完成验证',
      });
      return;
    }

    // Handle captcha solved
    if (message.type === 'xhs_captcha_solved') {
      onStateUpdate({
        status: 'scraping',
        progress: `✅ 验证完成！继续爬取... (耗时${message.waitTime || 0}秒)`,
      });
      return;
    }

    // Handle captcha still present
    if (message.type === 'xhs_captcha_still_present') {
      onStateUpdate({
        status: 'captcha',
        progress: '⚠️ 验证尚未完成，请继续完成验证',
      });
      return;
    }

    // Handle user stop
    if (message.type === 'xhs_stopped') {
      onError(`已中断：共收集 ${message.totalViewed} 篇评价`);
      return;
    }

    // Handle completion
    if (message.type === 'xhs_complete') {
      const posts: XHSPost[] = message.posts || [];
      
      if (posts.length === 0) {
        onError('未找到相关评价，请尝试其他小区或关键词');
        return;
      }

      onStateUpdate({
        status: 'validating',
        progress: `已抓取 ${posts.length} 篇笔记，开始AI筛选...`,
        totalScraped: posts.length,
      });

      // Start AI filtering and summary generation
      try {
        const result = await collectValidPosts(posts, 9);

        if (result.validPosts.length === 0) {
          onError('AI筛选后无有效评价，可能都是广告内容');
          return;
        }

        onStateUpdate({
          status: 'generating',
          progress: '生成总评中...',
          validCount: result.validPosts.length,
        });

        const summary = await generateXHSReviewSummary(
          result.validPosts,
          listing.community
        );

        // Create review record - convert invalidPosts format
        const review: XHSReviewRecord = {
          listingId: listing.id,
          community: listing.community,
          validPosts: result.validPosts,
          invalidPosts: result.invalidPosts.map(item => ({
            title: item.post.title,
            reason: item.reason,
          })),
          summary,
          stats: {
            totalScraped: posts.length,
            validCount: result.validPosts.length,
            invalidCount: result.invalidPosts.length,
          },
          createdAt: new Date().toISOString(),
        };

        // Save to storage
        await saveXHSReview(review);

        onStateUpdate({
          status: 'done',
          progress: '完成！',
        });

        onComplete(review);
      } catch (error: any) {
        console.error('[XHS] AI processing failed:', error);
        const errorMsg = error?.message || 'AI处理失败';
        if (errorMsg.includes('API') || errorMsg.includes('key')) {
          onError('AI处理失败：请检查API配置和密钥');
        } else if (errorMsg.includes('network') || errorMsg.includes('timeout')) {
          onError('AI处理失败：网络超时，请重试');
        } else {
          onError(`AI处理失败：${errorMsg}`);
        }
      }
    }

    // Handle scraper errors
    if (message.type === 'xhs_error') {
      const errorType = message.errorType || 'unknown';
      const errorMsg = message.message || '抓取失败';
      
      switch (errorType) {
        case 'global_timeout':
          onError(
            '⏱️ 爬取超时\n\n' +
            '爬取过程超过5分钟，已自动停止。\n\n' +
            `已收集 ${message.totalViewed || 0} 篇评价。\n\n` +
            '💡 建议：\n' +
            '• 检查网络连接是否稳定\n' +
            '• 如果收集到部分评价，可以查看已有结果\n' +
            '• 稍后重试或更换搜索关键词'
          );
          break;
        case 'captcha_timeout':
          onError(
            '⏱️ 验证超时\n\n' +
            '验证过程超过2分钟未完成。\n\n' +
            '💡 建议：\n' +
            '• 重新开始爬取\n' +
            '• 确保网络连接稳定\n' +
            '• 如果验证难度过高，可稍后再试'
          );
          break;
        case 'no_posts':
          onError(
            '❌ ' + errorMsg + '\n\n' +
            '💡 可能原因：\n' +
            '1. 页面未加载完成 - 请稍等片刻重试\n' +
            '2. 搜索无结果 - 尝试更换关键词\n' +
            '3. 小红书页面结构变化 - 请联系开发者\n' +
            '4. 需要登录账号 - 前往"个人中心"登录\n\n' +
            '🔧 建议操作：\n' +
            '• 检查网络连接\n' +
            '• 确认已登录小红书账号\n' +
            '• 尝试手动搜索该小区确认有相关内容'
          );
          break;
        case 'network':
          onError(
            '❌ 网络错误：' + errorMsg + '\n\n' +
            '💡 请检查：\n' +
            '1. 网络连接是否正常\n' +
            '2. 小红书服务是否可访问\n' +
            '3. 是否被防火墙拦截\n\n' +
            '🔧 建议：稍后重试或切换网络环境'
          );
          break;
        case 'timeout':
          onError(
            '⏱️ 请求超时\n\n' +
            '💡 可能原因：\n' +
            '1. 网络速度较慢\n' +
            '2. 小红书服务器响应慢\n\n' +
            '🔧 建议：稍后重试'
          );
          break;
        default:
          onError(
            '❌ ' + errorMsg + '\n\n' +
            '💡 如果问题持续出现，请尝试：\n' +
            '1. 重启应用\n' +
            '2. 清除缓存\n' +
            '3. 联系技术支持'
          );
      }
    }
  } catch (error) {
    console.error('[XHS] Message handling error:', error);
    onError('数据解析失败，请重试');
  }
}

/**
 * Get XHS scraper injection script
 */
export function getXHSScraperScript(): string {
  return XHS_AUTO_SCRAPER;
}

/**
 * Format XHS review state message for display
 */
export function formatXHSStateMessage(state: XHSReviewState | null): string {
  if (!state) return '';

  switch (state.status) {
    case 'idle':
      return '准备中...';
    case 'scraping':
      return state.progress || '正在收集评价...';
    case 'captcha':
      return state.progress || '等待验证完成...';
    case 'validating':
      return state.progress || 'AI审核中...';
    case 'generating':
      return state.progress || '生成总评中...';
    case 'done':
      return '完成！';
    case 'error':
      return state.error || '发生错误';
    default:
      return state.progress || '';
  }
}

/**
 * Check if XHS review is available for listing
 */
export function canGenerateXHSReview(listing: Listing): { can: boolean; reason?: string } {
  if (!listing.community || listing.community.trim().length === 0) {
    return {
      can: false,
      reason: '房源缺少小区信息',
    };
  }

  return { can: true };
}
