// ── 后台 WebView 抓取组件 ────────────────────────────────────
// 完全隐藏的 WebView，用于在后台加载页面并提取数据

import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { getScraperScript } from '../lib/scraper';
import type { ScrapeResult } from '../lib/webview-scraper';
import { parseScrapeMessage } from '../lib/webview-scraper';

type BackgroundWebViewProps = {
  url: string;
  platform: 'anjuke' | 'beike' | 'lianjia';
  onExtracted: (result: ScrapeResult) => void;
  onError: (error: string) => void;
  onCaptchaDetected?: (url: string) => void; // 检测到 CAPTCHA 时的回调
  timeout?: number; // 超时时间（毫秒），默认 15 秒
};

/**
 * 后台 WebView 抓取组件
 * 
 * 特点：
 * - 完全隐藏（width: 0, height: 0, position: absolute）
 * - 页面加载完成后自动注入提取脚本
 * - 通过 onMessage 接收提取结果
 * - 支持超时处理
 * - 自动清理
 */
export function BackgroundWebView({
  url,
  platform,
  onExtracted,
  onError,
  onCaptchaDetected,
  timeout = 15000,
}: BackgroundWebViewProps) {
  const webViewRef = useRef<WebView>(null);
  const [hasExtracted, setHasExtracted] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [injectedJS, setInjectedJS] = useState<string>('');

  useEffect(() => {
    // ★ 贝壳平台：生成 Cookie 注入脚本
    if (platform === 'beike') {
      (async () => {
        try {
          const { getBeikeCookie } = require('../lib/storage');
          const cookieString = await getBeikeCookie();
          
          if (cookieString) {
            console.log('[BackgroundWebView] Beike cookie available, length:', cookieString.length);
            
            // 转义 Cookie 字符串，防止注入错误
            const escapedCookie = cookieString
              .replace(/\\/g, '\\\\')
              .replace(/"/g, '\\"')
              .replace(/\n/g, '')
              .replace(/\r/g, '');
            
            // 生成注入脚本：在页面加载前设置 Cookie
            const script = `
              (function() {
                try {
                  const cookieStr = "${escapedCookie}";
                  const pairs = cookieStr.split(';');
                  let count = 0;
                  
                  pairs.forEach(pair => {
                    const trimmed = pair.trim();
                    if (trimmed && trimmed.includes('=')) {
                      // 为每个 Cookie 设置 domain 和 path
                      document.cookie = trimmed + '; domain=.ke.com; path=/';
                      count++;
                    }
                  });
                  
                  console.log('[Cookie Injected] ' + count + ' cookies set before page load');
                } catch (e) {
                  console.error('[Cookie Injection Failed]', e);
                }
              })();
              true;
            `;
            
            setInjectedJS(script);
            console.log('[BackgroundWebView] Cookie injection script prepared');
          } else {
            console.log('[BackgroundWebView] No Beike cookie found, may need login');
          }
        } catch (error) {
          console.error('[BackgroundWebView] Failed to prepare cookie injection:', error);
        }
      })();
    }
    
    // ★ 链家平台：生成 Cookie 注入脚本
    if (platform === 'lianjia') {
      (async () => {
        try {
          const { getLianjiaCookie } = require('../lib/storage');
          const cookieString = await getLianjiaCookie();
          
          if (cookieString) {
            console.log('[BackgroundWebView] Lianjia cookie available, length:', cookieString.length);
            
            // 转义 Cookie 字符串，防止注入错误
            const escapedCookie = cookieString
              .replace(/\\/g, '\\\\')
              .replace(/"/g, '\\"')
              .replace(/\n/g, '')
              .replace(/\r/g, '');
            
            // 生成注入脚本：在页面加载前设置 Cookie
            const script = `
              (function() {
                try {
                  const cookieStr = "${escapedCookie}";
                  const pairs = cookieStr.split(';');
                  let count = 0;
                  
                  pairs.forEach(pair => {
                    const trimmed = pair.trim();
                    if (trimmed && trimmed.includes('=')) {
                      // 为每个 Cookie 设置 domain 和 path（链家域名）
                      document.cookie = trimmed + '; domain=.lianjia.com; path=/';
                      count++;
                    }
                  });
                  
                  console.log('[Cookie Injected] ' + count + ' cookies set before page load');
                } catch (e) {
                  console.error('[Cookie Injection Failed]', e);
                }
              })();
              true;
            `;
            
            setInjectedJS(script);
            console.log('[BackgroundWebView] Lianjia cookie injection script prepared');
          } else {
            console.log('[BackgroundWebView] No Lianjia cookie found, may need login');
          }
        } catch (error) {
          console.error('[BackgroundWebView] Failed to prepare Lianjia cookie injection:', error);
        }
      })();
    }

    // 设置超时定时器
    timeoutRef.current = setTimeout(() => {
      if (!hasExtracted) {
        onError('抓取超时（15秒），请检查网络或稍后重试');
      }
    }, timeout);

    // 清理函数
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [hasExtracted, timeout, onError, platform]);

  function handleLoadEnd() {
    // 页面加载完成后，延迟注入脚本（等待动态内容加载）
    setTimeout(() => {
      if (!hasExtracted) {
        // 先发送调试信息
        webViewRef.current?.injectJavaScript(`
          (function() {
            // 收集所有可能的房源容器类名
            const allClasses = new Set();
            const allElements = document.querySelectorAll('*');
            for (let i = 0; i < Math.min(allElements.length, 200); i++) {
              const el = allElements[i];
              if (el.className && typeof el.className === 'string') {
                el.className.split(/\\s+/).forEach(cls => {
                  if (cls && (cls.includes('list') || cls.includes('item') || cls.includes('card') || cls.includes('house') || cls.includes('zu'))) {
                    allClasses.add(cls);
                  }
                });
              }
            }
            
            // 检查各种可能的选择器
            const selectorTests = {
              'li.list-item': document.querySelectorAll('li.list-item').length,
              'li[data-id]': document.querySelectorAll('li[data-id]').length,
              '.zu-itemmod': document.querySelectorAll('.zu-itemmod').length,
              '.house-item': document.querySelectorAll('.house-item').length,
              '.list-item': document.querySelectorAll('.list-item').length,
              'li': document.querySelectorAll('li').length,
              'a[href*="zufang"]': document.querySelectorAll('a[href*="zufang"]').length,
              'a[href*="/props/"]': document.querySelectorAll('a[href*="/props/"]').length,
            };
            
            // 分析租房链接的父容器结构
            const zufangLinks = document.querySelectorAll('a[href*="zufang"]');
            const linkParentInfo = [];
            for (let i = 0; i < Math.min(zufangLinks.length, 5); i++) {
              const link = zufangLinks[i];
              const parent = link.parentElement;
              const grandParent = parent ? parent.parentElement : null;
              linkParentInfo.push({
                href: link.href.substring(0, 80),
                text: link.textContent.trim().substring(0, 50),
                parentTag: parent ? parent.tagName : '',
                parentClass: parent ? parent.className : '',
                grandParentTag: grandParent ? grandParent.tagName : '',
                grandParentClass: grandParent ? grandParent.className : '',
                parentHTML: parent ? parent.outerHTML.substring(0, 300) : ''
              });
            }
            
            // 获取第一个房源卡片的完整 HTML 结构
            const firstCard = document.querySelector('.zu-itemmod');
            const firstCardHTML = firstCard ? firstCard.outerHTML.substring(0, 3000) : null;
            
            window.ReactNativeWebView.postMessage(JSON.stringify({
              type: 'debug',
              title: document.title,
              url: window.location.href,
              bodyLength: document.body.innerHTML.length,
              selectorTests: selectorTests,
              foundClasses: Array.from(allClasses).slice(0, 30),
              linkParentInfo: linkParentInfo,
              first1000: document.body.innerHTML.substring(0, 1000),
              hasReactRoot: !!document.querySelector('#root, #app, [id*="root"], [id*="app"]'),
              bodyClasses: document.body.className,
              first_card_html: firstCardHTML
            }));
          })();
        `);
        
        // 然后注入主抓取脚本
        const script = getScraperScript(platform);
        webViewRef.current?.injectJavaScript(script);
      }
    }, 3000); // 等待 3 秒让页面完全加载
  }

  function handleMessage(event: { nativeEvent: { data: string } }) {
    if (hasExtracted) return; // 防止重复处理

    // 尝试解析消息
    try {
      const data = JSON.parse(event.nativeEvent.data);
      
      // 处理调试消息
      if (data.type === 'debug') {
        console.log('[BackgroundWebView Debug]', JSON.stringify(data, null, 2));
        return; // 调试消息不触发提取完成
      }
      
      // ★ 检测是否为 CAPTCHA 错误
      if (data.type === 'scrape_result' && !data.success && data.needLogin) {
        console.log('[BackgroundWebView] CAPTCHA detected:', data.reason);
        setHasExtracted(true);
        
        // 清除超时定时器
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current);
        }
        
        // 通知父组件检测到 CAPTCHA
        if (onCaptchaDetected) {
          onCaptchaDetected(url);
        } else {
          // 如果没有提供 CAPTCHA 处理回调，则当作普通错误处理
          onError(data.reason || '触发人机验证');
        }
        return;
      }
    } catch (e) {
      // 如果不是 JSON，继续用原来的方式处理
    }

    const result = parseScrapeMessage(event.nativeEvent.data);
    
    if (result) {
      console.log('[BackgroundWebView] Scrape result received:', {
        success: result.success,
        count: result.listings?.length || 0,
        firstListingUrl: result.listings?.[0]?.url?.substring(0, 100),
        firstListingTitle: result.listings?.[0]?.title?.substring(0, 50),
      });
      
      setHasExtracted(true);
      
      // 清除超时定时器
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
      
      onExtracted(result);
    }
  }

  function handleError() {
    if (!hasExtracted) {
      setHasExtracted(true);
      
      // 清除超时定时器
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
      
      onError('页面加载失败，请检查网络连接');
    }
  }

  return (
    <View style={styles.container}>
      <WebView
        ref={webViewRef}
        source={{ 
          uri: url,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
          }
        }}
        userAgent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        injectedJavaScriptBeforeContentLoaded={injectedJS}
        onLoadEnd={handleLoadEnd}
        onError={handleError}
        onMessage={handleMessage}
        javaScriptEnabled
        domStorageEnabled
        sharedCookiesEnabled
        thirdPartyCookiesEnabled
        style={styles.webview}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: -9999,
    left: -9999,
    width: 0,
    height: 0,
    overflow: 'hidden',
    opacity: 0,
  },
  webview: {
    width: 0,
    height: 0,
  },
});
