import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { Colors, Radius, Spacing, Typography } from './lib/design';
import { getPrefs, setPlatformLoggedIn, type PlatformLoginStatus } from './lib/storage';

type PlatformKey = keyof PlatformLoginStatus;

// 桌面版 Chrome UA - 用于小红书等需要绕过移动端限制的平台
const DESKTOP_CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const PLATFORM_CONFIG: Record<string, { label: string; loginUrl: (city: string) => string; userAgent?: string }> = {
  beike: {
    label: '贝壳找房',
    loginUrl: (city) => `https://m.ke.com/chuzu/${city}/zufang/`,
  },
  anjuke: {
    label: '安居客',
    loginUrl: (city) => `https://m.anjuke.com/${city}/zufang/`,
  },
  lianjia: {
    label: '链家',
    loginUrl: (city) => `https://m.lianjia.com/chuzu/${city}/`,
  },
  xiaohongshu: {
    label: '小红书',
    loginUrl: (city) => `https://www.xiaohongshu.com/explore`,
    userAgent: DESKTOP_CHROME_UA, // 使用桌面UA绕过App跳转限制
  },
};

// 注入 JS 提取 Cookie
const COOKIE_EXTRACT_JS = `
  (function() {
    try {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'cookie',
        cookie: document.cookie,
        url: window.location.href
      }));
    } catch (e) {
      console.error('Cookie extract failed:', e);
    }
  })();
  true;
`;

export default function PlatformLoginPage() {
  const router = useRouter();
  const { platform } = useLocalSearchParams<{ platform: string }>();
  const webViewRef = useRef<WebView>(null);
  const [loading, setLoading] = useState(true);
  const [pageTitle, setPageTitle] = useState('');
  const [cityCode, setCityCode] = useState('bj');
  const [autoDetecting, setAutoDetecting] = useState(false);
  const [cookieExtracted, setCookieExtracted] = useState(false);

  const platformKey = (platform || 'beike') as PlatformKey;
  const config = PLATFORM_CONFIG[platformKey] ?? PLATFORM_CONFIG.beike;

  // 加载城市 code 用于构造 URL
  useEffect(() => {
    getPrefs().then(p => setCityCode(p.city || 'bj'));
  }, []);

  const loginUrl = config.loginUrl(cityCode);

  // 处理 WebView 消息（接收 Cookie）
  async function handleMessage(event: any) {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      
      if (data.type === 'cookie' && data.cookie && !cookieExtracted) {
        // ★ Cookie 长度验证：确保有足够的 Cookie 数据
        const cookieLength = data.cookie.length;
        if (cookieLength < 100) {
          console.log('[Login] Cookie too short, likely not logged in yet. Length:', cookieLength);
          return; // 不保存，等待用户真正登录
        }
        
        setCookieExtracted(true);
        
        // ★ 贝壳平台：保存 document.cookie 内容作为登录标记
        if (platformKey === 'beike') {
          try {
            const { saveBeikeCookie } = require('./lib/storage');
            // 直接保存 document.cookie 的内容
            await saveBeikeCookie(data.cookie);
            console.log('[Login] Beike cookie saved, length:', cookieLength);
          } catch (cookieError) {
            console.error('[Login] Failed to save cookie:', cookieError);
          }
        }
        
        // ★ 链家平台：保存 document.cookie 内容作为登录标记
        if (platformKey === 'lianjia') {
          try {
            const { saveLianjiaCookie } = require('./lib/storage');
            await saveLianjiaCookie(data.cookie);
            console.log('[Login] Lianjia cookie saved, length:', cookieLength);
          } catch (cookieError) {
            console.error('[Login] Failed to save Lianjia cookie:', cookieError);
          }
        }
        
        // ★ 小红书平台：保存 document.cookie 内容作为登录标记
        if (platformKey === 'xiaohongshu') {
          try {
            const { saveXiaohongshuCookie } = require('./lib/storage');
            await saveXiaohongshuCookie(data.cookie);
            console.log('[Login] Xiaohongshu cookie saved, length:', cookieLength);
          } catch (cookieError) {
            console.error('[Login] Failed to save Xiaohongshu cookie:', cookieError);
          }
        }
        
        // 保存登录状态标记
        await setPlatformLoggedIn(platformKey, true);
        
        Alert.alert(
          '登录成功',
          `${config.label} 登录状态已保存，WebView 会自动使用此登录态抓取房源`,
          [{ text: '确定', onPress: () => router.back() }],
        );
      }
    } catch (error) {
      console.error('Handle message error:', error);
    }
  }

  // 导航状态变化处理（仅更新标题，不自动检测登录）
  function handleNavigationStateChange(state: any) {
    if (state.title) setPageTitle(state.title);
    
    // ★ 禁用自动检测，避免误判
    // 原因：登录页面 URL 本身就包含 /zufang/，会导致未登录就被标记为已登录
    // 用户需要手动点击"我已登录"按钮来确认登录完成
  }

  // 手动确认登录（兼容旧流程）
  async function handleDoneLogin() {
    // 先尝试提取 Cookie
    if (platformKey === 'beike' && !cookieExtracted) {
      webViewRef.current?.injectJavaScript(COOKIE_EXTRACT_JS);
      // 给一点时间让 Cookie 提取完成
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    // 如果还没有提取到 Cookie，就只保存登录状态
    if (!cookieExtracted) {
      await setPlatformLoggedIn(platformKey, true);
      Alert.alert(
        '登录完成',
        `${config.label} 登录状态已保存，自动看房时将使用此登录态。`,
        [{ text: '确定', onPress: () => router.back() }],
      );
    }
  }

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      {/* 顶栏 */}
      <View style={s.header}>
        <TouchableOpacity style={s.closeBtn} onPress={() => router.back()}>
          <Ionicons name="close" size={22} color={Colors.textPrimary} />
        </TouchableOpacity>
        <View style={s.headerCenter}>
          <Text style={s.headerTitle} numberOfLines={1}>
            {config.label} 登录
          </Text>
          {pageTitle ? (
            <Text style={s.headerSubtitle} numberOfLines={1}>{pageTitle}</Text>
          ) : null}
        </View>
        <TouchableOpacity style={s.doneBtn} onPress={handleDoneLogin}>
          <Text style={s.doneBtnText}>我已登录</Text>
        </TouchableOpacity>
      </View>

      {/* WebView */}
      <View style={{ flex: 1 }}>
        {loading && (
          <View style={s.loadingOverlay}>
            <ActivityIndicator size="large" color={Colors.primary} />
          </View>
        )}
        <WebView
          ref={webViewRef}
          source={{ uri: loginUrl }}
          userAgent={config.userAgent} // 使用平台特定的UA（小红书使用桌面UA）
          sharedCookiesEnabled
          thirdPartyCookiesEnabled
          javaScriptEnabled
          domStorageEnabled
          style={{ flex: 1 }}
          onLoadStart={() => setLoading(true)}
          onLoadEnd={() => setLoading(false)}
          onNavigationStateChange={handleNavigationStateChange}
          onMessage={handleMessage}
        />
      </View>

      {/* 底部提示 */}
      <View style={s.footer}>
        <Ionicons name="information-circle-outline" size={14} color={Colors.textTertiary} />
        <Text style={s.footerText}>
          {(platformKey === 'beike' || platformKey === 'lianjia' || platformKey === 'xiaohongshu')
            ? '完成登录后将自动保存登录信息，也可手动点击「我已登录」'
            : '完成平台登录后点击「我已登录」，App 将保存登录状态用于自动看房'
          }
        </Text>
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.bgPrimary },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: Colors.divider,
    gap: Spacing.sm,
  },
  closeBtn: { padding: Spacing.xs },
  headerCenter: { flex: 1, alignItems: 'center' },
  headerTitle: { ...Typography.h3, color: Colors.textPrimary },
  headerSubtitle: { ...Typography.label, color: Colors.textTertiary, marginTop: 2 },
  doneBtn: {
    backgroundColor: Colors.primary,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.xs,
    borderRadius: Radius.md,
  },
  doneBtnText: { fontSize: 13, fontWeight: '600', color: Colors.textInverse },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(255,255,255,0.8)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.xs,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
    backgroundColor: Colors.bgSecondary,
    borderTopWidth: 1,
    borderTopColor: Colors.divider,
  },
  footerText: { flex: 1, ...Typography.label, color: Colors.textTertiary, lineHeight: 16 },
});
