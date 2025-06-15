import { Ionicons } from '@expo/vector-icons';
import { useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { Colors, Radius, Spacing, Typography } from './design';
import type { Listing } from './storage';
import {
  canGenerateXHSReview,
  createInitialXHSState,
  formatXHSStateMessage,
  getXHSScraperScript,
  handleXHSScraperMessage,
  loadExistingXHSReview,
  startXHSReviewCollection,
  type XHSReviewUIState,
} from './xhs-review-integration';

// 桌面版 Chrome UA - 用于小红书绕过App跳转限制
const DESKTOP_CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * 小红书房源真实评价 - UI组件
 * 提供按钮、WebView、Modal等完整UI
 */
export function useXHSReview(listing: Listing | null) {
  const [xhsState, setXhsState] = useState<XHSReviewUIState>(createInitialXHSState());
  const xhsWebViewRef = useRef<WebView>(null);

  async function handleGenerateXHSReview() {
    if (xhsState.loading || !listing) return;

    // 检查是否已存在
    const existing = await loadExistingXHSReview(listing.id);
    if (existing) {
      setXhsState(prev => ({ ...prev, review: existing, showModal: true }));
      return;
    }

    // 验证是否可以生成
    const check = canGenerateXHSReview(listing);
    if (!check.can) {
      Alert.alert('无法生成', check.reason);
      return;
    }

    // 开始收集
    const { url, shouldStart, error } = startXHSReviewCollection(listing);
    if (!shouldStart) {
      Alert.alert('无法生成', error);
      return;
    }

    setXhsState(prev => ({
      ...prev,
      loading: true,
      error: '',
      webViewUrl: url,
      showModal: true,
      reviewState: {
        status: 'scraping',
        progress: '正在加载小红书页面...',
        validCount: 0,
        totalScraped: 0,
      },
    }));
  }

  function handleStopScraping() {
    console.log('[XHS] Stopping scraper...');
    
    // 发送停止信号到WebView
    xhsWebViewRef.current?.injectJavaScript(`
      (function() {
        window.postMessage(JSON.stringify({ type: 'xhs_stop' }), '*');
        // 设置全局停止标志
        if (typeof shouldStop !== 'undefined') {
          shouldStop = true;
        }
      })();
      true;
    `);
    
    // 立即更新状态，停止所有操作
    setXhsState(prev => ({
      ...prev,
      loading: false,
      error: '已停止爬取',
      webViewUrl: '',  // 清空 URL，彻底停止 WebView
      showCaptchaModal: false,  // 关闭验证码 Modal
      reviewState: null,  // 清空爬取状态
    }));
  }

  function handleWebViewLoadStart() {
    setXhsState(prev => ({
      ...prev,
      reviewState: {
        status: 'scraping',
        progress: '正在加载小红书页面...',
        validCount: 0,
        totalScraped: 0,
      },
    }));
  }

  function handleWebViewLoadEnd() {
    setXhsState(prev => ({
      ...prev,
      reviewState: {
        ...prev.reviewState!,
        progress: '页面加载完成，准备抓取...',
      },
    }));
  }

  function handleWebViewError(error: string) {
    setXhsState(prev => ({
      ...prev,
      error,
      loading: false,
    }));
  }

  function handleWebViewMessage(event: { nativeEvent: { data: string } }) {
    if (!listing) return;
    
    // 检查是否是验证码相关消息
    try {
      const message = JSON.parse(event.nativeEvent.data);
      
      // 检测到验证码 - 显示验证码 Modal
      if (message.type === 'xhs_captcha_detected') {
        setXhsState(prev => ({
          ...prev,
          showCaptchaModal: true,
          reviewState: prev.reviewState ? {
            ...prev.reviewState,
            status: 'captcha',
            progress: '⚠️ 检测到人机验证，请完成验证',
          } : null,
        }));
        return;
      }
      
      // 验证码已解决 - 关闭验证码 Modal
      if (message.type === 'xhs_captcha_solved') {
        setXhsState(prev => ({
          ...prev,
          showCaptchaModal: false,
        }));
      }
    } catch (e) {
      // 不是 JSON 消息，继续正常处理
    }
    
    handleXHSScraperMessage(
      event.nativeEvent.data,
      listing,
      (state) => {
        setXhsState(prev => {
          const newReviewState = prev.reviewState ? { ...prev.reviewState, ...state } : { ...state };
          
          // 如果状态变为 captcha，显示验证码 Modal
          if (state.status === 'captcha') {
            return { ...prev, reviewState: newReviewState as typeof prev.reviewState, showCaptchaModal: true };
          }
          
          return { ...prev, reviewState: newReviewState as typeof prev.reviewState };
        });
      },
      (review) => {
        setXhsState(prev => ({ ...prev, review, loading: false, showCaptchaModal: false }));
        Alert.alert('完成', '小红书评价已生成');
      },
      (error) => {
        setXhsState(prev => ({ ...prev, error, loading: false, showCaptchaModal: false }));
        Alert.alert('生成失败', error);
      }
    );
  }

  function handleCaptchaContinue() {
    // 发送继续信号到 WebView
    xhsWebViewRef.current?.injectJavaScript(`
      window.postMessage(JSON.stringify({ type: 'xhs_captcha_continue' }), '*');
      true;
    `);
  }

  function handleCaptchaClose() {
    setXhsState(prev => ({ ...prev, showCaptchaModal: false }));
  }

  return {
    xhsState,
    setXhsState,
    xhsWebViewRef,
    handleGenerateXHSReview,
    handleStopScraping,
    handleWebViewMessage,
    handleWebViewLoadStart,
    handleWebViewLoadEnd,
    handleWebViewError,
    handleCaptchaContinue,
    handleCaptchaClose,
  };
}

/**
 * 小红书评价按钮
 */
export function XHSReviewButton({
  loading,
  hasReview,
  onPress,
}: {
  loading: boolean;
  hasReview: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={[styles.secondaryBtn, loading && styles.secondaryBtnDisabled]}
      onPress={onPress}
      disabled={loading}
    >
      {loading ? (
        <ActivityIndicator size="small" color={Colors.primary} />
      ) : (
        <Ionicons name="book-outline" size={15} color={Colors.primary} style={{ marginRight: 5 }} />
      )}
      <Text style={styles.secondaryBtnText}>
        {hasReview ? '查看小红书评价' : '生成小红书评价'}
      </Text>
    </TouchableOpacity>
  );
}

/**
 * 小红书评价WebView（支持验证码显示）
 */
export function XHSReviewWebView({
  url,
  webViewRef,
  onMessage,
  onLoadEnd,
  onLoadStart,
  onError,
  showCaptcha,
  isActive,
}: {
  url: string;
  webViewRef: React.RefObject<WebView | null>;
  onMessage: (event: { nativeEvent: { data: string } }) => void;
  onLoadEnd?: () => void;
  onLoadStart?: () => void;
  onError?: (error: string) => void;
  showCaptcha?: boolean;
  isActive?: boolean;
}) {
  const loadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scriptInjectedRef = useRef(false);

  // 如果需要显示验证码，使用可见的容器；否则隐藏
  const containerStyle = showCaptcha
    ? { flex: 1, backgroundColor: '#fff' }
    : { position: 'absolute' as const, width: 1, height: 1, opacity: 0 };
  
  const pointerEvents = showCaptcha ? 'auto' : 'none';

  return (
    <View style={containerStyle} pointerEvents={pointerEvents}>
      <WebView
        ref={webViewRef}
        source={{ uri: url }}
        userAgent={DESKTOP_CHROME_UA}
        onLoadStart={() => {
          console.log('[XHS WebView] Load started');
          scriptInjectedRef.current = false;
          onLoadStart?.();
          
          // Set timeout for loading (30 seconds)
          loadTimeoutRef.current = setTimeout(() => {
            console.log('[XHS WebView] Load timeout');
            onError?.('页面加载超时，请检查网络连接');
          }, 30000);
        }}
        onLoadEnd={() => {
          console.log('[XHS WebView] Load ended, isActive:', isActive);
          
          // Clear timeout
          if (loadTimeoutRef.current) {
            clearTimeout(loadTimeoutRef.current);
            loadTimeoutRef.current = null;
          }
          
          // ★ 严格检查：只在活跃状态且未注入过脚本时才注入
          if (isActive === true && !scriptInjectedRef.current) {
            scriptInjectedRef.current = true;
            setTimeout(() => {
              console.log('[XHS WebView] Injecting scraper script');
              webViewRef.current?.injectJavaScript(getXHSScraperScript());
            }, 2000);
          } else {
            console.log('[XHS WebView] Skipping script injection (isActive:', isActive, ', injected:', scriptInjectedRef.current, ')');
          }
          
          onLoadEnd?.();
        }}
        onError={(syntheticEvent) => {
          const { nativeEvent } = syntheticEvent;
          console.error('[XHS WebView] Load error:', nativeEvent);
          
          // Clear timeout
          if (loadTimeoutRef.current) {
            clearTimeout(loadTimeoutRef.current);
            loadTimeoutRef.current = null;
          }
          
          onError?.(`页面加载失败: ${nativeEvent.description || '未知错误'}`);
        }}
        onHttpError={(syntheticEvent) => {
          const { nativeEvent } = syntheticEvent;
          console.error('[XHS WebView] HTTP error:', nativeEvent.statusCode);
          
          if (nativeEvent.statusCode >= 400) {
            onError?.(`网络错误 (${nativeEvent.statusCode})`);
          }
        }}
        onMessage={onMessage}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        startInLoadingState={true}
      />
    </View>
  );
}

/**
 * 小红书验证码Modal（同时用于显示爬取进度）
 */
export function XHSCaptchaModal({
  visible,
  webViewUrl,
  webViewRef,
  onMessage,
  onLoadEnd,
  onLoadStart,
  onError,
  onContinue,
  onClose,
}: {
  visible: boolean;
  webViewUrl: string;
  webViewRef: React.RefObject<WebView | null>;
  onMessage: (event: { nativeEvent: { data: string } }) => void;
  onLoadEnd?: () => void;
  onLoadStart?: () => void;
  onError?: (error: string) => void;
  onContinue: () => void;
  onClose: () => void;
}) {
  const [showContinueButton, setShowContinueButton] = useState(false);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent={false}
      onRequestClose={onClose}
    >
      <SafeAreaView style={{ flex: 1, backgroundColor: Colors.bgPrimary }} edges={['top']}>
        <View style={styles.captchaHeader}>
          <TouchableOpacity onPress={onClose} style={styles.captchaCloseBtn}>
            <Ionicons name="close" size={24} color={Colors.textPrimary} />
          </TouchableOpacity>
          <Text style={styles.captchaTitle}>🔍 小红书评价爬取</Text>
          <View style={{ width: 40 }} />
        </View>
        
        <View style={styles.captchaHint}>
          <Ionicons name="information-circle-outline" size={20} color={Colors.primary} />
          <Text style={styles.captchaHintText}>
            正在自动浏览小红书帖子，如遇验证码请完成验证后点击"继续"
          </Text>
        </View>

        <View style={{ flex: 1, backgroundColor: '#fff' }}>
          <XHSReviewWebView
            url={webViewUrl}
            webViewRef={webViewRef}
            onMessage={(event) => {
              onMessage(event);
              // 检测验证码消息，显示继续按钮
              try {
                const msg = JSON.parse(event.nativeEvent.data);
                if (msg.type === 'xhs_captcha_detected') {
                  setShowContinueButton(true);
                } else if (msg.type === 'xhs_captcha_solved') {
                  setShowContinueButton(false);
                }
              } catch (e) {
                // ignore
              }
            }}
            onLoadEnd={onLoadEnd}
            onLoadStart={onLoadStart}
            onError={onError}
            showCaptcha={true}
            isActive={true}
          />
        </View>

        <View style={styles.captchaFooter}>
          {showContinueButton ? (
            <TouchableOpacity
              style={styles.captchaContinueBtn}
              onPress={onContinue}
            >
              <Ionicons name="checkmark-circle" size={20} color="#fff" />
              <Text style={styles.captchaContinueBtnText}>验证完成，继续</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={[styles.captchaContinueBtn, { backgroundColor: '#ff4444' }]}
              onPress={onClose}
            >
              <Ionicons name="stop-circle" size={20} color="#fff" />
              <Text style={styles.captchaContinueBtnText}>停止爬取</Text>
            </TouchableOpacity>
          )}
        </View>
      </SafeAreaView>
    </Modal>
  );
}

/**
 * 小红书评价Modal
 */
export function XHSReviewModal({
  visible,
  loading,
  review,
  reviewState,
  error,
  onClose,
  onStop,
}: {
  visible: boolean;
  loading: boolean;
  review: XHSReviewUIState['review'];
  reviewState: XHSReviewUIState['reviewState'];
  error: string;
  onClose: () => void;
  onStop?: () => void;
}) {
  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}
    >
      <View style={styles.modalOverlay}>
        <View style={styles.modalSheet}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>小红书真实评价</Text>
            <TouchableOpacity onPress={onClose}>
              <Ionicons name="close" size={22} color={Colors.textSecondary} />
            </TouchableOpacity>
          </View>

          {loading && (
            <View style={styles.loadingWrap}>
              <ActivityIndicator size="large" color="#00ae66" />
              <Text style={styles.loadingText}>
                {formatXHSStateMessage(reviewState)}
              </Text>
              
              {/* 进度信息 */}
              {reviewState && reviewState.status === 'scraping' && (
                <View style={styles.progressInfo}>
                  <Text style={styles.progressText}>
                    已收集: {reviewState.validCount || 0} 篇有效评价
                  </Text>
                  {reviewState.totalScraped > 0 && (
                    <Text style={styles.progressText}>
                      已浏览: {reviewState.totalScraped} 篇
                    </Text>
                  )}
                </View>
              )}
              
              {/* 停止按钮 */}
              {onStop && reviewState?.status === 'scraping' && (
                <TouchableOpacity 
                  style={styles.stopButton}
                  onPress={onStop}
                >
                  <Ionicons name="stop-circle-outline" size={20} color="#ff4444" />
                  <Text style={styles.stopButtonText}>停止爬取</Text>
                </TouchableOpacity>
              )}
            </View>
          )}

          {error && !loading && (
            <View style={styles.errorWrap}>
              <Ionicons name="alert-circle-outline" size={20} color={Colors.error} />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          )}

          {review && !loading && (
            <ScrollView style={styles.modalScroll}>
              <Text style={styles.modalSubtitle}>
                {review.community} · 共 {review.stats.validCount} 篇有效评价
              </Text>
              <View style={styles.card}>
                <Text style={styles.sectionTitle}>总评</Text>
                <Text style={styles.summaryText}>{review.summary}</Text>
              </View>
              {review.validPosts.map((post, i) => (
                <View key={i} style={styles.postItem}>
                  <Text style={styles.postTitle}>{post.title}</Text>
                  <Text style={styles.postContent}>{post.content}</Text>
                  <Text style={styles.postAuthor}>作者: {post.author}</Text>
                </View>
              ))}
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  secondaryBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Radius.lg,
    paddingVertical: Spacing.md,
    borderWidth: 1.5,
    borderColor: Colors.primary,
    backgroundColor: Colors.primaryLight,
    minHeight: 44,
  },
  secondaryBtnDisabled: { opacity: 0.6 },
  secondaryBtnText: { fontSize: 13, fontWeight: '600', color: Colors.primary },

  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  modalSheet: {
    backgroundColor: Colors.bgPrimary,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    maxHeight: '80%',
    paddingTop: Spacing.lg,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    paddingBottom: Spacing.sm,
  },
  modalTitle: { ...Typography.h3, color: Colors.textPrimary, fontWeight: '700' },
  modalSubtitle: {
    ...Typography.labelSmall,
    color: Colors.textSecondary,
    paddingHorizontal: Spacing.lg,
    paddingBottom: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: Colors.divider,
  },
  modalScroll: { paddingHorizontal: Spacing.lg },

  loadingWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: Spacing.xxxl,
  },
  loadingText: { ...Typography.h4, color: Colors.textSecondary, marginTop: Spacing.lg },

  progressInfo: {
    marginTop: Spacing.lg,
    alignItems: 'center',
    gap: Spacing.xs,
  },
  progressText: {
    ...Typography.body2,
    color: Colors.textSecondary,
    fontSize: 13,
  },

  stopButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: Spacing.lg,
    paddingVertical: Spacing.sm,
    paddingHorizontal: Spacing.lg,
    backgroundColor: '#fff0f0',
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: '#ff4444',
  },
  stopButtonText: {
    ...Typography.label,
    color: '#ff4444',
    marginLeft: Spacing.xs,
    fontWeight: '600',
  },

  errorWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    margin: Spacing.lg,
    padding: Spacing.md,
    backgroundColor: '#fff0f0',
    borderRadius: Radius.md,
  },
  errorText: { ...Typography.body2, color: Colors.error, marginLeft: Spacing.sm, flex: 1 },

  card: {
    backgroundColor: Colors.bgSecondary,
    marginTop: Spacing.lg,
    borderRadius: Radius.md,
    padding: Spacing.md,
  },
  sectionTitle: { ...Typography.h4, color: Colors.textPrimary, marginBottom: Spacing.sm },
  summaryText: { ...Typography.body2, color: Colors.textPrimary, lineHeight: 20 },

  postItem: {
    marginTop: Spacing.lg,
    padding: Spacing.md,
    backgroundColor: Colors.bgSecondary,
    borderRadius: Radius.md,
    borderLeftWidth: 3,
    borderLeftColor: Colors.primary,
  },
  postTitle: { ...Typography.label, fontWeight: '700', color: Colors.primary, marginBottom: Spacing.xs },
  postContent: { ...Typography.body2, color: Colors.textPrimary, lineHeight: 20, marginBottom: Spacing.xs },
  postAuthor: { ...Typography.labelSmall, color: Colors.textTertiary, fontStyle: 'italic' },

  // 验证码 Modal 样式
  captchaHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: Colors.divider,
  },
  captchaCloseBtn: {
    padding: Spacing.xs,
  },
  captchaTitle: {
    ...Typography.h3,
    color: Colors.textPrimary,
    fontWeight: '700',
  },
  captchaHint: {
    flexDirection: 'row',
    alignItems: 'center',
    margin: Spacing.lg,
    padding: Spacing.md,
    backgroundColor: Colors.primaryLight,
    borderRadius: Radius.md,
    borderLeftWidth: 3,
    borderLeftColor: Colors.primary,
  },
  captchaHintText: {
    ...Typography.body2,
    color: Colors.textPrimary,
    marginLeft: Spacing.sm,
    flex: 1,
  },
  captchaFooter: {
    padding: Spacing.lg,
    borderTopWidth: 1,
    borderTopColor: Colors.divider,
    backgroundColor: Colors.bgPrimary,
  },
  captchaContinueBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.primary,
    paddingVertical: Spacing.md,
    borderRadius: Radius.lg,
    minHeight: 48,
  },
  captchaContinueBtnText: {
    ...Typography.label,
    color: '#fff',
    fontWeight: '700',
    marginLeft: Spacing.xs,
  },
});
