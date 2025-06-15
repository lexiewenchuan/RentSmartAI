import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Colors, Radius, Spacing, Typography } from './design';
import type { ScrapedListing } from './scraper';
import {
  checkScraperHealth,
  fetchAnjukeFromServer,
  fetchBeikeCookieStatus,
  fetchBeikeFromServer,
  updateBeikeCookie,
} from './scraper-backend';

type ServerScraperProps = {
  cityCode: string;
  onScrapingComplete: (listings: ScrapedListing[], count: number) => Promise<void>;
};

/**
 * 自动筛选组件
 *
 * 功能：
 * 1. 显示爬虫服务状态（在线/离线）
 * 2. 安居客和贝壳抓取按钮
 * 3. 页码显示和翻页功能
 * 4. 贝壳 Cookie 状态检查
 * 5. 手机端贝壳 Cookie 设置
 */
export function ServerScraper({ cityCode, onScrapingComplete }: ServerScraperProps) {
  const [scraping, setScraping] = useState(false);
  const [page, setPage] = useState(1);
  const [scraperOnline, setScraperOnline] = useState(false);
  const [checkingHealth, setCheckingHealth] = useState(true);
  const [beikeCookieReady, setBeikeCookieReady] = useState(false);
  const [showCookieModal, setShowCookieModal] = useState(false);
  const [cookieInput, setCookieInput] = useState('');
  const [savingCookie, setSavingCookie] = useState(false);

  // 页面加载时检查爬虫服务健康状态
  useEffect(() => {
    checkHealth();
  }, [cityCode]);

  async function checkHealth() {
    setCheckingHealth(true);
    const isOnline = await checkScraperHealth();
    setScraperOnline(isOnline);
    setCheckingHealth(false);

    if (isOnline) {
      // 检查贝壳 Cookie 状态
      const cookieStatus = await fetchBeikeCookieStatus(cityCode);
      setBeikeCookieReady(cookieStatus.hasCookie);
    }
  }

  async function handleScrapeAnjuke() {
    if (scraping) return;

    setScraping(true);
    try {
      const result = await fetchAnjukeFromServer(cityCode, page);

      if (!result.success) {
        Alert.alert('抓取失败', result.reason);
        return;
      }

      if (result.count === 0) {
        Alert.alert('提示', '当前页没有找到房源');
        return;
      }

      await onScrapingComplete(result.listings, result.count);
      Alert.alert('抓取成功', `已获取 ${result.count} 套房源`);
    } catch (error: any) {
      Alert.alert('错误', error?.message || '抓取过程中出现异常');
    } finally {
      setScraping(false);
    }
  }

  async function handleScrapeBeike() {
    if (scraping) return;

    // 先检查 Cookie 状态
    const cookieStatus = await fetchBeikeCookieStatus(cityCode);

    if (!cookieStatus.hasCookie) {
      Alert.alert(
        '需要登录贝壳',
        '请选择登录方式：',
        [
          {
            text: '内置浏览器登录（推荐）',
            onPress: () => {
              // 使用 router 需要从 expo-router 导入
              const { router } = require('expo-router');
              router.push(`/platform-login?platform=beike`);
            },
          },
          {
            text: '手动输入 Cookie',
            onPress: () => setShowCookieModal(true),
          },
          {
            text: '电脑端设置',
            onPress: () => {
              Alert.alert(
                'Cookie 已失效',
                '贝壳登录已过期，请重新登录以继续使用',
                [
                  { text: '取消', style: 'cancel' },
                  { 
                    text: '去登录', 
                    onPress: () => {
                      // 跳转到平台登录页面
                      const router = require('expo-router').router;
                      router.push(`/platform-login?platform=beike`);
                    }
                  },
                ]
              );
            },
          },
          { text: '取消', style: 'cancel' },
        ],
      );
      return;
    }

    setScraping(true);
    try {
      const result = await fetchBeikeFromServer(cityCode, page);

      if (!result.success) {
        Alert.alert('抓取失败', result.reason);
        return;
      }

      if (result.count === 0) {
        Alert.alert('提示', '当前页没有找到房源');
        return;
      }

      await onScrapingComplete(result.listings, result.count);
      Alert.alert('抓取成功', `已获取 ${result.count} 套房源`);
    } catch (error: any) {
      Alert.alert('错误', error?.message || '抓取过程中出现异常');
    } finally {
      setScraping(false);
    }
  }

  async function handleSaveCookie() {
    const trimmed = cookieInput.trim();
    if (!trimmed) {
      Alert.alert('提示', '请输入 Cookie');
      return;
    }

    setSavingCookie(true);
    try {
      const result = await updateBeikeCookie(cityCode, trimmed);
      if (result.success) {
        Alert.alert('成功', result.message);
        setShowCookieModal(false);
        setCookieInput('');
        // 重新检查状态
        await checkHealth();
      } else {
        Alert.alert('失败', result.message);
      }
    } catch (error: any) {
      Alert.alert('错误', error?.message || '保存失败');
    } finally {
      setSavingCookie(false);
    }
  }

  function handleNextPage() {
    setPage((prev) => prev + 1);
  }

  function handlePrevPage() {
    setPage((prev) => Math.max(1, prev - 1));
  }

  return (
    <View style={s.container}>
      {/* 标题和状态 */}
      <View style={s.header}>
        <Text style={s.label}>自动筛选</Text>
        <View style={s.statusRow}>
          <View style={[s.statusDot, scraperOnline ? s.statusOnline : s.statusOffline]} />
          <Text style={s.statusText}>
            {checkingHealth ? '检查中...' : scraperOnline ? '爬虫服务运行中' : '爬虫服务未启动'}
          </Text>
          <TouchableOpacity onPress={checkHealth} style={s.refreshBtn}>
            <Text style={s.refreshText}>↻</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* 抓取按钮和页码 */}
      <View style={s.controls}>
        <TouchableOpacity
          style={[s.platformBtn, s.anjukeBtn, (scraping || !scraperOnline) && s.btnDisabled]}
          onPress={handleScrapeAnjuke}
          disabled={scraping || !scraperOnline}
        >
          {scraping ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text style={s.platformBtnText}>安居客</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          style={[s.platformBtn, s.beikeBtn, (scraping || !scraperOnline) && s.btnDisabled]}
          onPress={handleScrapeBeike}
          disabled={scraping || !scraperOnline}
        >
          {scraping ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <View style={s.beikeBtnContent}>
              <Text style={s.platformBtnText}>贝壳</Text>
              {!beikeCookieReady && scraperOnline && <Text style={s.cookieWarning}>⚠️</Text>}
            </View>
          )}
        </TouchableOpacity>

        <View style={s.pageControls}>
          <TouchableOpacity
            style={[s.pageBtn, (page === 1 || scraping) && s.btnDisabled]}
            onPress={handlePrevPage}
            disabled={page === 1 || scraping}
          >
            <Text style={s.pageBtnText}>◀</Text>
          </TouchableOpacity>

          <View style={s.pageDisplay}>
            <Text style={s.pageText}>第 {page} 页</Text>
          </View>

          <TouchableOpacity
            style={[s.pageBtn, scraping && s.btnDisabled]}
            onPress={handleNextPage}
            disabled={scraping}
          >
            <Text style={s.pageBtnText}>▶</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* 提示信息 */}
      {!scraperOnline && !checkingHealth && (
        <Text style={s.hint}>💡 爬虫服务未启动，请在电脑上启动后重试</Text>
      )}
      {scraperOnline && !beikeCookieReady && (
        <TouchableOpacity onPress={() => setShowCookieModal(true)}>
          <Text style={[s.hint, { color: Colors.primary, textDecorationLine: 'underline' }]}>
            💡 点击此处设置贝壳 Cookie
          </Text>
        </TouchableOpacity>
      )}

      {/* Cookie 设置 Modal */}
      <Modal visible={showCookieModal} transparent animationType="slide">
        <View style={s.modalOverlay}>
          <View style={s.modalContent}>
            <ScrollView style={s.modalScroll}>
              <Text style={s.modalTitle}>设置贝壳 Cookie</Text>

              <Text style={s.modalInstructions}>
                1. 在手机浏览器打开贝壳租房网站并登录{'\n'}
                2. 打开浏览器开发者工具（Chrome: F12）{'\n'}
                3. 切换到 Network 标签{'\n'}
                4. 刷新页面，找到任意请求{'\n'}
                5. 复制 Request Headers 中的 Cookie 值{'\n'}
                6. 粘贴到下方输入框
              </Text>

              <TextInput
                style={s.cookieInput}
                placeholder="粘贴 Cookie 字符串..."
                value={cookieInput}
                onChangeText={setCookieInput}
                multiline
                numberOfLines={6}
                textAlignVertical="top"
              />

              <View style={s.modalButtons}>
                <TouchableOpacity
                  style={[s.modalBtn, s.modalBtnCancel]}
                  onPress={() => {
                    setShowCookieModal(false);
                    setCookieInput('');
                  }}
                  disabled={savingCookie}
                >
                  <Text style={s.modalBtnText}>取消</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[s.modalBtn, s.modalBtnSave, savingCookie && s.btnDisabled]}
                  onPress={handleSaveCookie}
                  disabled={savingCookie}
                >
                  {savingCookie ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Text style={[s.modalBtnText, { color: '#fff' }]}>保存</Text>
                  )}
                </TouchableOpacity>
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  container: {
    backgroundColor: Colors.bgPrimary,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: Colors.divider,
  },

  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: Spacing.sm,
  },

  label: {
    ...Typography.body2,
    color: Colors.textSecondary,
    fontWeight: '600',
  },

  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
  },

  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },

  statusOnline: {
    backgroundColor: '#00ae66',
  },

  statusOffline: {
    backgroundColor: '#999',
  },

  statusText: {
    fontSize: 11,
    color: Colors.textTertiary,
  },

  refreshBtn: {
    paddingHorizontal: Spacing.xs,
  },

  refreshText: {
    fontSize: 16,
    color: Colors.primary,
  },

  controls: {
    flexDirection: 'row',
    gap: Spacing.sm,
    alignItems: 'center',
  },

  platformBtn: {
    flex: 1,
    paddingVertical: Spacing.sm,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 36,
  },

  anjukeBtn: {
    backgroundColor: '#ff6000',
  },

  beikeBtn: {
    backgroundColor: '#0066CC',
  },

  btnDisabled: {
    opacity: 0.5,
  },

  platformBtnText: {
    fontSize: 13,
    fontWeight: '600',
    color: Colors.textInverse,
  },

  beikeBtnContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
  },

  cookieWarning: {
    fontSize: 12,
  },

  pageControls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
  },

  pageBtn: {
    width: 32,
    height: 32,
    borderRadius: Radius.sm,
    backgroundColor: Colors.bgSecondary,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: Colors.divider,
  },

  pageBtnText: {
    fontSize: 12,
    color: Colors.textPrimary,
  },

  pageDisplay: {
    paddingHorizontal: Spacing.sm,
  },

  pageText: {
    fontSize: 12,
    color: Colors.textPrimary,
    fontWeight: '600',
  },

  hint: {
    fontSize: 11,
    color: Colors.textTertiary,
    marginTop: Spacing.sm,
    fontStyle: 'italic',
  },

  // Modal styles
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },

  modalContent: {
    backgroundColor: Colors.bgPrimary,
    borderTopLeftRadius: Radius.lg,
    borderTopRightRadius: Radius.lg,
    maxHeight: '80%',
  },

  modalScroll: {
    padding: Spacing.lg,
  },

  modalTitle: {
    ...Typography.h3,
    marginBottom: Spacing.md,
    textAlign: 'center',
  },

  modalInstructions: {
    ...Typography.body2,
    color: Colors.textSecondary,
    marginBottom: Spacing.md,
    lineHeight: 20,
  },

  cookieInput: {
    borderWidth: 1,
    borderColor: Colors.divider,
    borderRadius: Radius.md,
    padding: Spacing.md,
    fontSize: 12,
    fontFamily: 'monospace',
    minHeight: 120,
    marginBottom: Spacing.md,
  },

  modalButtons: {
    flexDirection: 'row',
    gap: Spacing.sm,
  },

  modalBtn: {
    flex: 1,
    paddingVertical: Spacing.md,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },

  modalBtnCancel: {
    backgroundColor: Colors.bgSecondary,
    borderWidth: 1,
    borderColor: Colors.divider,
  },

  modalBtnSave: {
    backgroundColor: Colors.primary,
  },

  modalBtnText: {
    ...Typography.body2,
    fontWeight: '600',
  },
});
