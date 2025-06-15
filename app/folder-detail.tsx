import { useFocusEffect } from '@react-navigation/native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, Platform, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import FolderSelectorModal from './components/FolderSelectorModal';
import {
    addListingToFolder,
    getFolderListings,
    removeListingFromFolder,
    type Listing,
} from './lib/storage';

export default function FolderDetailPage() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const folderId = params.folderId as string;
  const folderName = params.folderName as string;
  
  const [records, setRecords] = useState<Listing[]>([]);
  const [showFolderSelector, setShowFolderSelector] = useState(false);
  const [selectedListingForMove, setSelectedListingForMove] = useState<Listing | null>(null);

  const loadData = useCallback(async () => {
    if (!folderId) return;
    const listings = await getFolderListings(folderId);
    setRecords(listings);
  }, [folderId]);

  useFocusEffect(
    useCallback(() => {
      loadData();
    }, [loadData])
  );

  async function handleRemove(listingId: string) {
    await removeListingFromFolder(listingId, folderId);
    await loadData();
  }

  // 长按房源卡片，弹出移动选项
  async function handleListingLongPress(listing: Listing) {
    Alert.alert(
      '房源操作',
      '选择操作',
      [
        {
          text: '移动到其他收藏夹',
          onPress: () => {
            setSelectedListingForMove(listing);
            setShowFolderSelector(true);
          },
        },
        {
          text: '移除收藏',
          style: 'destructive',
          onPress: () => {
            Alert.alert('确认移除', '将该房源从收藏夹中移除？', [
              { text: '取消', style: 'cancel' },
              { text: '移除', style: 'destructive', onPress: () => handleRemove(listing.id) },
            ]);
          },
        },
        { text: '取消', style: 'cancel' },
      ]
    );
  }

  // 选择目标收藏夹后移动房源
  async function handleMoveToFolder(targetFolderId: string) {
    if (!selectedListingForMove) return;
    
    // 如果目标收藏夹就是当前收藏夹，不需要移动
    if (targetFolderId === folderId) {
      Alert.alert('提示', '房源已在该收藏夹中');
      setSelectedListingForMove(null);
      return;
    }
    
    // 从当前收藏夹移除
    await removeListingFromFolder(selectedListingForMove.id, folderId);
    
    // 添加到目标收藏夹
    await addListingToFolder(selectedListingForMove, targetFolderId);
    
    // 刷新数据
    await loadData();
    
    Alert.alert('移动成功', '已移动到目标收藏夹');
    
    setSelectedListingForMove(null);
  }

  const hasNoListings = records.length === 0;

  return (
    <SafeAreaView style={s.safe} edges={Platform.OS === 'android' ? [] : ['top']}>
      <View style={s.navbar}>
        <TouchableOpacity style={s.navBack} onPress={() => router.back()}>
          <Text style={s.navBackText}>←</Text>
        </TouchableOpacity>
        <Text style={s.navTitle}>{folderName || '收藏夹'}</Text>
        <View style={{ width: 28 }} />
      </View>

      {hasNoListings ? (
        <View style={s.emptyWrap}>
          <Text style={s.emptyIcon}>🤍</Text>
          <Text style={s.emptyTitle}>收藏夹是空的</Text>
          <Text style={s.emptyDesc}>在找房页点心形即可加入收藏</Text>
          <TouchableOpacity style={s.goBtn} onPress={() => router.replace('/search')}>
            <Text style={s.goBtnText}>去找房</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <ScrollView style={s.body} showsVerticalScrollIndicator={false}>
          {records.map((item) => (
            <TouchableOpacity
              key={item.id}
              style={s.row}
              activeOpacity={0.8}
              onPress={() => router.push(`/listing/${item.id}`)}
              onLongPress={() => handleListingLongPress(item)}
            >
              <Text style={s.title} numberOfLines={2}>
                {item.title || '未知标题'}
              </Text>
              <Text style={s.meta}>
                {item.price ? `${item.price} 元/月` : '价格未知'} · {item.roomType || '户型未知'} ·{' '}
                {item.area || '面积未知'}
              </Text>
              <Text style={s.comment} numberOfLines={2}>
                {item.aiComment || '暂无AI点评'}
              </Text>
              <View style={s.actions}>
                <TouchableOpacity style={s.detailBtn} onPress={() => router.push(`/listing/${item.id}`)}>
                  <Text style={s.detailBtnText}>查看详情</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={s.removeBtn}
                  onPress={() =>
                    Alert.alert('确认移除', '将该房源从收藏夹中移除？', [
                      { text: '取消', style: 'cancel' },
                      { text: '移除', style: 'destructive', onPress: () => handleRemove(item.id) },
                    ])
                  }
                >
                  <Text style={s.removeBtnText}>移除收藏</Text>
                </TouchableOpacity>
              </View>
            </TouchableOpacity>
          ))}
          <View style={{ height: 20 }} />
        </ScrollView>
      )}

      {/* 收藏夹选择器 */}
      <FolderSelectorModal
        visible={showFolderSelector}
        onClose={() => {
          setShowFolderSelector(false);
          setSelectedListingForMove(null);
        }}
        onSelectFolder={handleMoveToFolder}
        currentFolderId={folderId}
        title="移动到收藏夹"
      />
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
  actions: { flexDirection: 'row', gap: 8, marginTop: 10 },
  detailBtn: {
    flex: 1,
    borderRadius: 8,
    paddingVertical: 9,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#00ae66',
    backgroundColor: '#f0faf5',
  },
  detailBtnText: { fontSize: 13, color: '#00ae66', fontWeight: '600' },
  removeBtn: {
    flex: 1,
    borderRadius: 8,
    paddingVertical: 9,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#ffd9d9',
    backgroundColor: '#fff5f5',
  },
  removeBtnText: { fontSize: 13, color: '#e74c3c', fontWeight: '600' },
  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  emptyIcon: { fontSize: 40, marginBottom: 8 },
  emptyTitle: { fontSize: 15, fontWeight: '700', color: '#333' },
  emptyDesc: { fontSize: 13, color: '#999', marginTop: 6 },
  goBtn: {
    marginTop: 14,
    backgroundColor: '#00ae66',
    borderRadius: 8,
    paddingHorizontal: 24,
    paddingVertical: 10,
  },
  goBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },
});
