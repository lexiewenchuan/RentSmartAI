import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Platform, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Colors, Radius, Shadow, Spacing, Typography } from '../lib/design';
import { getFavoritesCount, getHistory, getStats, type AppStats, type Listing } from '../lib/storage';

export default function HomePage() {
  const router = useRouter();
  const [stats, setStats] = useState<AppStats>({ analyzed: 0, favorited: 0, deepAnalyzed: 0 });
  const [recentListings, setRecentListings] = useState<Listing[]>([]);

  // 页面聚焦时刷新数据
  useFocusEffect(
    useCallback(() => {
      loadData();
    }, [])
  );

  async function loadData() {
    const s = await getStats();
    const history = await getHistory();
    
    // ★ 使用实时收藏数量，确保与实际收藏夹内容一致
    const favoritedCount = await getFavoritesCount();
    
    setStats({ ...s, favorited: favoritedCount });
    setRecentListings(history.slice(0, 5)); // 只显示最近 5 条
  }

  return (
    <SafeAreaView style={s.safe} edges={Platform.OS === 'android' ? [] : ['top']}>
      {/* Header */}
      <View style={s.header}>
        <View>
          <Text style={s.headerTitle}>RentSmart AI</Text>
          <Text style={s.headerSub}>智能租房助手</Text>
        </View>
        <View style={s.headerBadge}>
          <Ionicons name="home" size={22} color={Colors.primary} />
        </View>
      </View>

      <ScrollView style={s.body} showsVerticalScrollIndicator={false}>
        {/* Quick Actions */}
        <View style={s.section}>
          <Text style={s.sectionTitle}>快捷操作</Text>
          <View style={s.quickRow}>
            <TouchableOpacity style={s.quickCard} onPress={() => router.push('/search')}>
              <View style={s.quickIconWrap}>
                <Ionicons name="search-outline" size={26} color={Colors.primary} />
              </View>
              <Text style={s.quickLabel}>找房</Text>
              <Text style={s.quickDesc}>AI智能筛选</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.quickCard} onPress={() => router.push('/chat')}>
              <View style={s.quickIconWrap}>
                <Ionicons name="chatbubbles-outline" size={26} color={Colors.primary} />
              </View>
              <Text style={s.quickLabel}>问AI</Text>
              <Text style={s.quickDesc}>租房咨询</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.quickCard} onPress={() => router.push('/compare')}>
              <View style={s.quickIconWrap}>
                <Ionicons name="bar-chart-outline" size={26} color={Colors.primary} />
              </View>
              <Text style={s.quickLabel}>对比</Text>
              <Text style={s.quickDesc}>房源PK</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Stats */}
        <View style={s.section}>
          <View style={s.statsRow}>
            <TouchableOpacity style={s.statCard} onPress={() => router.push('/history')}>
              <Text style={s.statNum}>{stats.analyzed}</Text>
              <Text style={s.statLabel}>已分析</Text>
            </TouchableOpacity>
            <View style={s.statDivider} />
            <TouchableOpacity style={s.statCard} onPress={() => router.push('/favorites')}>
              <Text style={s.statNum}>{stats.favorited}</Text>
              <Text style={s.statLabel}>已收藏</Text>
            </TouchableOpacity>
            <View style={s.statDivider} />
            <TouchableOpacity style={s.statCard} onPress={() => router.push('/deep-analyses')}>
              <Text style={s.statNum}>{stats.deepAnalyzed}</Text>
              <Text style={s.statLabel}>已精筛</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Recent */}
        <View style={s.section}>
          <View style={s.sectionHeader}>
            <Text style={s.sectionTitle}>最近分析</Text>
            <TouchableOpacity onPress={() => router.push('/history')}>
              <Text style={s.sectionLink}>查看全部</Text>
            </TouchableOpacity>
          </View>

          {recentListings.length === 0 ? (
            <View style={s.emptyState}>
              <View style={s.emptyIconWrap}>
                <Ionicons name="document-text-outline" size={44} color={Colors.textTertiary} />
              </View>
              <Text style={s.emptyTitle}>还没有分析记录</Text>
              <Text style={s.emptyDesc}>去「找房」页面开始你的第一次AI筛选</Text>
              <TouchableOpacity style={s.emptyBtn} onPress={() => router.push('/search')}>
                <Text style={s.emptyBtnText}>开始找房</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <>
              {recentListings.map(listing => (
                <View key={listing.id} style={s.historyCard}>
                  <View style={s.historyIcon}>
                    <Ionicons name="home-outline" size={26} color={Colors.primary} />
                  </View>
                  <View style={s.historyInfo}>
                    <Text style={s.historyTitle} numberOfLines={1}>
                      {listing.title}
                    </Text>
                    <Text style={s.historyMeta}>
                      {listing.roomType} · {listing.area} · {listing.district}
                    </Text>
                    <Text style={s.historyPrice}>
                      {listing.price} <Text style={s.historyPriceUnit}>元/月</Text>
                    </Text>
                    <Text style={s.historyComment} numberOfLines={1}>
                      {listing.aiComment || '暂无AI点评'}
                    </Text>
                  </View>
                </View>
              ))}
            </>
          )}
        </View>

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.bgSecondary },
  header: {
    backgroundColor: Colors.bgPrimary,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.md,
    paddingBottom: Spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: Colors.divider,
  },
  headerTitle: { ...Typography.h1, color: Colors.textPrimary },
  headerSub: { ...Typography.labelSmall, color: Colors.textTertiary, marginTop: 2 },
  headerBadge: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: { flex: 1, paddingBottom: Spacing.lg },

  section: { marginTop: Spacing.lg },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    marginBottom: Spacing.md,
  },
  sectionTitle: {
    ...Typography.h3,
    color: Colors.textPrimary,
    paddingHorizontal: Spacing.lg,
    marginBottom: Spacing.md,
  },
  sectionLink: { ...Typography.label, color: Colors.primary },

  quickRow: {
    flexDirection: 'row',
    paddingHorizontal: Spacing.lg,
    gap: Spacing.md,
  },
  quickCard: {
    flex: 1,
    backgroundColor: Colors.bgPrimary,
    borderRadius: Radius.lg,
    padding: Spacing.lg,
    alignItems: 'center',
    ...Shadow.xs,
  },
  quickIconWrap: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.md,
  },
  quickLabel: { ...Typography.h4, color: Colors.textPrimary },
  quickDesc: { ...Typography.label, color: Colors.textSecondary, marginTop: 2 },

  statsRow: {
    flexDirection: 'row',
    backgroundColor: Colors.bgPrimary,
    marginHorizontal: Spacing.lg,
    borderRadius: Radius.lg,
    padding: Spacing.lg,
    ...Shadow.xs,
  },
  statCard: { flex: 1, alignItems: 'center' },
  statNum: { fontSize: 24, fontWeight: '700', color: Colors.primary },
  statLabel: { ...Typography.label, color: Colors.textSecondary, marginTop: Spacing.xs },
  statDivider: { width: 1, backgroundColor: Colors.divider, marginVertical: Spacing.xs },

  emptyState: {
    backgroundColor: Colors.bgPrimary,
    marginHorizontal: Spacing.lg,
    borderRadius: Radius.lg,
    padding: Spacing.xxxl,
    alignItems: 'center',
    ...Shadow.xs,
  },
  emptyIconWrap: {
    marginBottom: Spacing.lg,
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: Colors.bgSecondary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyTitle: { ...Typography.h3, color: Colors.textPrimary },
  emptyDesc: { ...Typography.body2, color: Colors.textSecondary, marginTop: Spacing.md, textAlign: 'center' },
  emptyBtn: {
    marginTop: Spacing.lg,
    backgroundColor: Colors.primary,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.md,
  },
  emptyBtnText: { color: Colors.textInverse, ...Typography.h4, fontWeight: '600' },

  historyCard: {
    flexDirection: 'row',
    backgroundColor: Colors.bgPrimary,
    marginHorizontal: Spacing.lg,
    marginBottom: Spacing.md,
    borderRadius: Radius.lg,
    padding: Spacing.md,
    ...Shadow.xs,
  },
  historyIcon: {
    width: 48,
    height: 48,
    borderRadius: Radius.md,
    backgroundColor: Colors.bgSecondary,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: Spacing.md,
  },
  historyInfo: { flex: 1 },
  historyTitle: { ...Typography.h4, color: Colors.textPrimary, marginBottom: Spacing.xs },
  historyMeta: { ...Typography.label, color: Colors.textSecondary, marginBottom: Spacing.xs },
  historyPrice: { fontSize: 16, fontWeight: '700', color: Colors.primary },
  historyPriceUnit: { fontSize: 12, fontWeight: '400', color: Colors.textSecondary },
  historyComment: { ...Typography.label, color: Colors.textSecondary, marginTop: Spacing.xs },
});
