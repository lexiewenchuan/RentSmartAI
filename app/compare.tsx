import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import {
  Alert, Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { generateCompareReport } from './lib/api';
import { buildListingDestinationCandidates, calculateCommute } from './lib/geo';
import { MarkdownView } from './lib/markdown';
import { clearCompare, getCompareList, getPrefs, removeFromCompare, type Listing } from './lib/storage';

const COMMUTE_RATE_LIMIT_MS = 350;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 平台标签映射
function getPlatformLabel(platform: string): string {
  const platformMap: Record<string, string> = {
    beike: '贝壳',
    anjuke: '安居客',
    lianjia: '链家',
    xiaohongshu: '小红书',
  };
  return platformMap[platform] || platform;
}

// 平台颜色映射
function getPlatformColor(platform: string): string {
  const colorMap: Record<string, string> = {
    beike: '#00ae66',
    anjuke: '#fe5500',
    lianjia: '#00ae66',
    xiaohongshu: '#ff2442',
  };
  return colorMap[platform] || '#666';
}

export default function ComparePage() {
  const router = useRouter();
  const [compareList, setCompareList] = useState<Listing[]>([]);
  const [reportLoading, setReportLoading] = useState(false);
  const [report, setReport] = useState('');
  const [commuteById, setCommuteById] = useState<Record<string, string>>({});
  const [commuteLoading, setCommuteLoading] = useState(false);
  const [workAddressConfigured, setWorkAddressConfigured] = useState(false);

  const loadCommuteBatch = useCallback(async (list: Listing[]) => {
    const prefs = await getPrefs();
    const workAddress = String(prefs.workAddress || '').trim();
    if (!workAddress) {
      setWorkAddressConfigured(false);
      setCommuteById({});
      return;
    }

    setWorkAddressConfigured(true);
    setCommuteLoading(true);
    const next: Record<string, string> = {};
    let hasApiError = false;
    let apiErrorMessage = '';
    
    for (let i = 0; i < list.length; i += 1) {
      const listing = list[i];
      
      // 多候选地理编码，无法保证每套都能算出通勤
      const cityCode = listing.cityCode || prefs.city || 'bj';
      const candidates = buildListingDestinationCandidates(listing);
      if (!candidates.length) {
        next[listing.id] = '地址不完整';
        continue;
      }
      const [primary, ...fallbacks] = candidates;
      
      try {
        const result = await calculateCommute(workAddress, primary, cityCode, fallbacks);
        if (result.success) {
          const modeSuffix = result.routeModeLabel ? `（${result.routeModeLabel}）` : '';
          next[listing.id] = `${result.distance} / ${result.duration}${modeSuffix}`;
        } else {
          // 检查是否是API配置错误
          if (result.errorReason && (
            result.errorReason.includes('API Key') ||
            result.errorReason.includes('未配置') ||
            result.errorReason.includes('无效') ||
            result.errorReason.includes('配额')
          )) {
            hasApiError = true;
            apiErrorMessage = result.errorReason;
            next[listing.id] = 'API配置错误';
          } else {
            next[listing.id] = '暂无法估算';
          }
          
          if (result.errorReason) {
            console.log(`[通勤] ${listing.title}: ${result.errorReason}`);
          }
        }
      } catch (error: any) {
        console.error(`[通勤] ${listing.title} 异常:`, error);
        const errorMsg = error?.message || '';
        if (errorMsg.includes('API Key') || errorMsg.includes('未配置')) {
          hasApiError = true;
          apiErrorMessage = errorMsg;
          next[listing.id] = 'API配置错误';
        } else {
          next[listing.id] = '计算失败';
        }
      }
      
      if (i < list.length - 1) {
        await sleep(COMMUTE_RATE_LIMIT_MS);
      }
    }
    
    setCommuteById(next);
    setCommuteLoading(false);
    
    // 如果有API错误，提示用户
    if (hasApiError && apiErrorMessage) {
      Alert.alert(
        '通勤计算失败',
        apiErrorMessage + '\n\n请前往「我的」页面检查高德地图 API Key 配置。',
        [{ text: '知道了' }]
      );
    }
  }, []);

  const loadCompareList = useCallback(async () => {
    const list = await getCompareList();
    setCompareList(list);
    await loadCommuteBatch(list);
  }, [loadCommuteBatch]);

  useFocusEffect(
    useCallback(() => {
      loadCompareList();
    }, [loadCompareList])
  );

  async function handleRemove(id: string) {
    const updated = await removeFromCompare(id);
    setCompareList(updated);
    await loadCommuteBatch(updated);
  }

  async function handleClearAll() {
    Alert.alert(
      '清空对比',
      '确定要清空所有对比房源吗？',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '确定',
          style: 'destructive',
          onPress: async () => {
            await clearCompare();
            setCompareList([]);
            setCommuteById({});
          },
        },
      ]
    );
  }

  // 空状态
  if (compareList.length === 0) {
    return (
      <SafeAreaView style={s.safe} edges={Platform.OS === 'android' ? [] : ['top']}>
        <View style={s.navbar}>
          <TouchableOpacity style={s.navBack} onPress={() => router.back()}>
            <Text style={s.navBackText}>←</Text>
          </TouchableOpacity>
          <Text style={s.navTitle}>房源对比</Text>
          <View style={{ width: 40 }} />
        </View>

        <View style={s.emptyState}>
          <Text style={s.emptyIcon}>📊</Text>
          <Text style={s.emptyTitle}>暂无对比房源</Text>
          <Text style={s.emptyDesc}>最多可对比 5 套房源</Text>
          <Text style={s.emptyDesc}>去找房页面挑选心仪的房源加入对比吧</Text>
          <TouchableOpacity
            style={s.emptyBtn}
            onPress={() => router.push('/search')}
          >
            <Text style={s.emptyBtnText}>去挑选房源</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // 对比视图
  return (
    <SafeAreaView style={s.safe} edges={Platform.OS === 'android' ? [] : ['top']}>
      <View style={s.navbar}>
        <TouchableOpacity style={s.navBack} onPress={() => router.back()}>
          <Text style={s.navBackText}>←</Text>
        </TouchableOpacity>
        <Text style={s.navTitle}>房源对比（{compareList.length}/5）</Text>
        <TouchableOpacity style={s.navClear} onPress={handleClearAll}>
          <Text style={s.navClearText}>清空</Text>
        </TouchableOpacity>
      </View>

      <ScrollView style={s.content} showsVerticalScrollIndicator={false}>
        <View style={s.section}>
          <TouchableOpacity
            style={[s.aiReportBtn, reportLoading && s.aiReportBtnDis]}
            disabled={reportLoading}
            onPress={async () => {
              try {
                setReportLoading(true);
                const prefs = await getPrefs();
                const text = await generateCompareReport(compareList, prefs);
                setReport(text);
              } catch (e: any) {
                Alert.alert('生成失败', e?.message || '请检查 API Key 或网络');
              } finally {
                setReportLoading(false);
              }
            }}
          >
            <Text style={s.aiReportBtnText}>
              {reportLoading ? '⏳ 正在生成详细对比报告...' : '🤖 生成 AI 详细对比报告'}
            </Text>
          </TouchableOpacity>
        </View>
        {/* 房源卡片横向滚动 */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={s.cardsRow}
          contentContainerStyle={s.cardsRowContent}
        >
          {compareList.map((listing, index) => (
            <View key={listing.id} style={s.card}>
              {/* 卡片头部 */}
              <View style={s.cardHeader}>
                <View style={s.cardIcon}>
                  <Text style={s.cardIconText}>🏠</Text>
                </View>
                <TouchableOpacity
                  style={s.removeBtn}
                  onPress={() => handleRemove(listing.id)}
                >
                  <Text style={s.removeBtnText}>✕</Text>
                </TouchableOpacity>
              </View>

              {/* 平台标识 */}
              {listing.platform && (
                <View style={s.platformBadge}>
                  <Text style={s.platformText}>
                    {getPlatformLabel(listing.platform)}
                  </Text>
                </View>
              )}

              {/* 标题 */}
              <TouchableOpacity
                onPress={() => router.push(`/listing/${listing.id}`)}
              >
                <Text style={s.cardTitle} numberOfLines={2}>
                  {listing.title}
                </Text>
              </TouchableOpacity>

              {/* 价格 */}
              <View style={s.priceRow}>
                <Text style={s.price}>
                  {listing.price}
                  <Text style={s.priceUnit}> 元/月</Text>
                </Text>
              </View>

              {/* AI 评分 */}
              {listing.aiScore > 0 && (
                <View
                  style={[
                    s.scoreBadge,
                    listing.aiScore >= 8
                      ? s.scoreHigh
                      : listing.aiScore >= 6
                      ? s.scoreMid
                      : s.scoreLow,
                  ]}
                >
                  <Text style={s.scoreText}>
                    AI {listing.aiScore.toFixed(1)}
                  </Text>
                </View>
              )}
            </View>
          ))}
        </ScrollView>

        {/* 对比维度表格 */}
        <View style={s.compareTable}>
          <CompareRow
            label="来源平台"
            values={compareList.map(l => getPlatformLabel(l.platform || '未知'))}
          />
          <CompareRow
            label="户型"
            values={compareList.map(l => l.roomType)}
          />
          <CompareRow
            label="面积"
            values={compareList.map(l => l.area)}
          />
          <CompareRow
            label="楼层"
            values={compareList.map(l => l.floor)}
          />
          <CompareRow
            label="小区"
            values={compareList.map(l => l.community)}
          />
          <CompareRow
            label="区域"
            values={compareList.map(l => l.district)}
          />
          <CompareRow
            label="近地铁"
            values={compareList.map(l => l.hasSubway ? '✓' : '✕')}
            highlight={compareList.map(l => l.hasSubway)}
          />
          <CompareRow
            label="可养宠"
            values={compareList.map(l => l.hasPets ? '✓' : '✕')}
            highlight={compareList.map(l => l.hasPets)}
          />
          <CompareRow
            label="租赁方式"
            values={compareList.map(l => l.isWhole ? '整租' : '合租')}
          />
          <CompareRow
            label="通勤时长"
            values={
              !workAddressConfigured
                ? compareList.map(() => '请先在设置页配置常去地址')
                : commuteLoading
                ? compareList.map(() => '计算通勤中...')
                : compareList.map((l) => commuteById[l.id] || '计算中...')
            }
          />
        </View>

        {/* AI 点评对比 */}
        <View style={s.section}>
          <Text style={s.sectionTitle}>🤖 AI 初筛点评对比</Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={s.commentsRow}
          >
            {compareList.map(listing => (
              <View key={listing.id} style={s.commentCard}>
                <Text style={s.commentTitle} numberOfLines={1}>
                  {listing.community}
                </Text>
                <Text style={s.commentText}>
                  {listing.aiComment || '暂无点评'}
                </Text>
              </View>
            ))}
          </ScrollView>
        </View>

        {report ? (
          <View style={s.section}>
            <Text style={s.sectionTitle}>📄 AI 详细对比报告</Text>
            <View style={s.reportCard}>
              <MarkdownView content={report} />
            </View>
          </View>
        ) : null}

        {/* 房源标签对比 */}
        <View style={s.section}>
          <Text style={s.sectionTitle}>🏷 房源标签对比</Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={s.tagsRow}
          >
            {compareList.map(listing => (
              <View key={listing.id} style={s.tagsCard}>
                <Text style={s.tagsCardTitle} numberOfLines={1}>
                  {listing.community}
                </Text>
                <View style={s.tagsWrap}>
                  {listing.tags.length > 0 ? (
                    listing.tags.map((tag, index) => (
                      <View key={`${listing.id}-tag-${index}-${tag}`} style={s.tag}>
                        <Text style={s.tagText}>{tag}</Text>
                      </View>
                    ))
                  ) : (
                    <Text style={s.noTags}>暂无标签</Text>
                  )}
                </View>
              </View>
            ))}
          </ScrollView>
        </View>

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

// 对比行组件
function CompareRow({
  label,
  values,
  highlight,
}: {
  label: string;
  values: string[];
  highlight?: boolean[];
}) {
  return (
    <View style={s.compareRow}>
      <View style={s.compareLabel}>
        <Text style={s.compareLabelText}>{label}</Text>
      </View>
      <View style={s.compareValues}>
        {values.map((value, index) => (
          <View
            key={index}
            style={[
              s.compareValue,
              highlight && highlight[index] && s.compareValueHighlight,
            ]}
          >
            <Text
              style={[
                s.compareValueText,
                highlight && highlight[index] && s.compareValueTextHighlight,
              ]}
              numberOfLines={2}
            >
              {value}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f5f5f8' },

  navbar: {
    backgroundColor: '#fff',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  navBack: { padding: 4, marginRight: 8 },
  navBackText: { fontSize: 22, color: '#00ae66', fontWeight: '600' },
  navTitle: { flex: 1, fontSize: 16, fontWeight: '600', color: '#222' },
  navClear: { padding: 4, marginLeft: 8 },
  navClearText: { fontSize: 14, color: '#e74c3c' },

  content: { flex: 1 },

  // 空状态
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  emptyIcon: { fontSize: 52, marginBottom: 16 },
  emptyTitle: { fontSize: 17, fontWeight: '700', color: '#333', marginBottom: 8 },
  emptyDesc: {
    fontSize: 13,
    color: '#999',
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 4,
  },
  emptyBtn: {
    marginTop: 20,
    backgroundColor: '#00ae66',
    borderRadius: 10,
    paddingHorizontal: 32,
    paddingVertical: 12,
  },
  emptyBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },

  // 房源卡片
  cardsRow: { backgroundColor: '#fff', paddingVertical: 16 },
  cardsRowContent: { paddingHorizontal: 12, gap: 12 },
  card: {
    width: 200,
    backgroundColor: '#f5f5f8',
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: '#e0e0e0',
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  cardIcon: {
    width: 40,
    height: 40,
    borderRadius: 8,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardIconText: { fontSize: 22 },
  removeBtn: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#e74c3c',
    alignItems: 'center',
    justifyContent: 'center',
  },
  removeBtnText: { fontSize: 12, color: '#fff', fontWeight: '600' },
  platformBadge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    backgroundColor: '#e8f7f0',
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#c8eddc',
  },
  platformText: {
    fontSize: 10,
    fontWeight: '600',
    color: '#00ae66',
  },
  cardTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: '#333',
    lineHeight: 18,
    marginBottom: 12,
    minHeight: 36,
  },
  priceRow: { marginBottom: 8 },
  price: { fontSize: 20, fontWeight: '700', color: '#fe5500' },
  priceUnit: { fontSize: 12, fontWeight: '400', color: '#999' },
  scoreBadge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
  },
  scoreHigh: { backgroundColor: '#e8f7f0' },
  scoreMid: { backgroundColor: '#fff8e6' },
  scoreLow: { backgroundColor: '#fff0f0' },
  scoreText: { fontSize: 12, fontWeight: '600', color: '#00ae66' },

  // 对比表格
  compareTable: {
    backgroundColor: '#fff',
    marginHorizontal: 12,
    marginTop: 12,
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#f0f0f0',
  },
  compareRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  compareLabel: {
    width: 80,
    backgroundColor: '#fafafa',
    padding: 12,
    justifyContent: 'center',
    borderRightWidth: 1,
    borderRightColor: '#f0f0f0',
  },
  compareLabelText: { fontSize: 13, fontWeight: '600', color: '#666' },
  compareValues: { flex: 1, flexDirection: 'row' },
  compareValue: {
    flex: 1,
    padding: 12,
    justifyContent: 'center',
    borderRightWidth: 1,
    borderRightColor: '#f0f0f0',
  },
  compareValueHighlight: { backgroundColor: '#e8f7f0' },
  compareValueText: { fontSize: 12, color: '#333', lineHeight: 18 },
  compareValueTextHighlight: { color: '#00ae66', fontWeight: '600' },

  // 点评区域
  section: {
    marginHorizontal: 12,
    marginTop: 12,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#333',
    marginBottom: 12,
    paddingHorizontal: 4,
  },
  commentsRow: { gap: 12 },
  commentCard: {
    width: 200,
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: '#f0f0f0',
  },
  commentTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: '#666',
    marginBottom: 6,
  },
  commentText: {
    fontSize: 12,
    color: '#555',
    lineHeight: 18,
  },

  // 标签区域
  tagsRow: { gap: 12 },
  tagsCard: {
    width: 200,
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: '#f0f0f0',
  },
  tagsCardTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: '#666',
    marginBottom: 8,
  },
  tagsWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  tag: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
    backgroundColor: '#e8f7f0',
    borderWidth: 1,
    borderColor: '#c8eddc',
  },
  tagText: { fontSize: 10, color: '#00ae66' },
  noTags: { fontSize: 11, color: '#999', fontStyle: 'italic' },

  aiReportBtn: {
    backgroundColor: '#00ae66',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  aiReportBtnDis: { opacity: 0.7 },
  aiReportBtnText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  reportCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: '#f0f0f0',
  },
});
