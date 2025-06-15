import { useState, useCallback, useMemo } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, TextInput, Alert, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect } from 'expo-router';
import { clearHistory, getHistory, getPrefs, type Listing } from './lib/storage';

export default function HistoryPage() {
  const router = useRouter();
  const [records, setRecords] = useState<Listing[]>([]);
  const [searchText, setSearchText] = useState('');
  const [cityFilter, setCityFilter] = useState<'all' | 'current'>('all');
  const [currentCityCode, setCurrentCityCode] = useState('bj');
  const [currentCityLabel, setCurrentCityLabel] = useState('当前城市');

  useFocusEffect(
    useCallback(() => {
      (async () => {
        const prefs = await getPrefs();
        setCurrentCityCode(prefs.city || 'bj');
        setCurrentCityLabel(prefs.cityLabel || '当前城市');
        const history = await getHistory();
        setRecords(history);
      })();
    }, [])
  );

  const filteredRecords = useMemo(() => {
    const kw = searchText.trim().toLowerCase();
    return records.filter(item => {
      if (cityFilter === 'current' && item.cityCode && item.cityCode !== currentCityCode) {
        return false;
      }
      if (!kw) return true;
      const text = `${item.title || ''} ${item.community || ''} ${item.district || ''} ${item.aiComment || ''}`.toLowerCase();
      return text.includes(kw);
    });
  }, [records, searchText, cityFilter, currentCityCode]);

  async function handleClearAnalyzed() {
    await clearHistory();
    setRecords([]);
    setSearchText('');
    Alert.alert('完成', '已分析记录已清空');
  }

  return (
    <SafeAreaView style={s.safe} edges={Platform.OS === 'android' ? [] : ['top']}>
      <View style={s.navbar}>
        <TouchableOpacity style={s.navBack} onPress={() => router.back()}>
          <Text style={s.navBackText}>←</Text>
        </TouchableOpacity>
        <Text style={s.navTitle}>分析记录</Text>
        <View style={{ width: 28 }} />
      </View>

      <View style={s.toolBar}>
        <View style={s.searchBox}>
          <Text style={s.searchIcon}>🔍</Text>
          <TextInput
            style={s.searchInput}
            placeholder="搜索标题、小区、区域、AI点评"
            placeholderTextColor="#bbb"
            value={searchText}
            onChangeText={setSearchText}
          />
          {searchText ? (
            <TouchableOpacity onPress={() => setSearchText('')}>
              <Text style={s.clearBtn}>✕</Text>
            </TouchableOpacity>
          ) : null}
        </View>
        <View style={s.filterRow}>
          <TouchableOpacity
            style={[s.filterChip, cityFilter === 'all' && s.filterChipActive]}
            onPress={() => setCityFilter('all')}
          >
            <Text style={[s.filterChipText, cityFilter === 'all' && s.filterChipTextActive]}>
              全部城市
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.filterChip, cityFilter === 'current' && s.filterChipActive]}
            onPress={() => setCityFilter('current')}
          >
            <Text style={[s.filterChipText, cityFilter === 'current' && s.filterChipTextActive]}>
              {currentCityLabel}
            </Text>
          </TouchableOpacity>
          <Text style={s.countText}>共 {filteredRecords.length} 条</Text>
        </View>
        <TouchableOpacity
          style={s.clearAnalyzedBtn}
          onPress={() =>
            Alert.alert('确认清空', '确认清空所有已分析记录吗？该操作不可恢复。', [
              { text: '取消', style: 'cancel' },
              { text: '清空', style: 'destructive', onPress: handleClearAnalyzed },
            ])
          }
        >
          <Text style={s.clearAnalyzedBtnText}>🗑 清空已分析记录</Text>
        </TouchableOpacity>
      </View>

      {records.length === 0 ? (
        <View style={s.emptyWrap}>
          <Text style={s.emptyIcon}>📝</Text>
          <Text style={s.emptyTitle}>还没有分析记录</Text>
          <Text style={s.emptyDesc}>先去找房并执行 AI 扫描</Text>
        </View>
      ) : (
        <ScrollView style={s.body} showsVerticalScrollIndicator={false}>
          {filteredRecords.length === 0 ? (
            <View style={s.emptyWrap}>
              <Text style={s.emptyIcon}>🔎</Text>
              <Text style={s.emptyTitle}>没有匹配记录</Text>
              <Text style={s.emptyDesc}>试试更换关键词或切换城市筛选</Text>
            </View>
          ) : filteredRecords.map(item => (
            <View key={item.id} style={s.row}>
              <Text style={s.title} numberOfLines={2}>{item.title || '未知标题'}</Text>
              <Text style={s.meta}>
                {item.price ? `${item.price} 元/月` : '价格未知'} · {item.roomType || '户型未知'} · {item.area || '面积未知'}
              </Text>
              <Text style={s.comment} numberOfLines={2}>{item.aiComment || '暂无AI点评'}</Text>
            </View>
          ))}
          <View style={{ height: 20 }} />
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f5f5f8' },
  navbar: {
    backgroundColor: '#fff',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  navBack: { paddingHorizontal: 6 },
  navBackText: { fontSize: 22, color: '#00ae66', fontWeight: '600' },
  navTitle: { fontSize: 16, fontWeight: '700', color: '#222' },
  toolBar: { paddingHorizontal: 12, paddingTop: 10, paddingBottom: 6 },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: 10,
    paddingHorizontal: 10,
    height: 40,
    borderWidth: 1,
    borderColor: '#f0f0f0',
  },
  searchIcon: { fontSize: 13, marginRight: 6 },
  searchInput: { flex: 1, fontSize: 13, color: '#333', padding: 0 },
  clearBtn: { fontSize: 14, color: '#999', padding: 4 },
  filterRow: { flexDirection: 'row', alignItems: 'center', marginTop: 10, gap: 8 },
  filterChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#f0f0f0',
  },
  filterChipActive: { backgroundColor: '#e8f7f0', borderColor: '#00ae66' },
  filterChipText: { fontSize: 12, color: '#666' },
  filterChipTextActive: { color: '#00ae66', fontWeight: '600' },
  countText: { marginLeft: 'auto', fontSize: 12, color: '#999' },
  clearAnalyzedBtn: {
    marginTop: 10,
    backgroundColor: '#fff5f5',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#ffd9d9',
    paddingVertical: 9,
    alignItems: 'center',
  },
  clearAnalyzedBtnText: { fontSize: 13, color: '#e74c3c', fontWeight: '600' },
  body: { flex: 1, paddingTop: 10 },
  row: {
    backgroundColor: '#fff',
    marginHorizontal: 12,
    marginBottom: 10,
    borderRadius: 12,
    padding: 12,
  },
  title: { fontSize: 14, fontWeight: '700', color: '#222', lineHeight: 20 },
  meta: { fontSize: 12, color: '#666', marginTop: 6 },
  comment: { fontSize: 12, color: '#999', marginTop: 6, lineHeight: 18 },
  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  emptyIcon: { fontSize: 40, marginBottom: 8 },
  emptyTitle: { fontSize: 15, fontWeight: '700', color: '#333' },
  emptyDesc: { fontSize: 13, color: '#999', marginTop: 6 },
});
