import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Text, View, StyleSheet } from 'react-native';

const TAB_PRIMARY = '#06c755';

function TabIcon({
  nameActive,
  nameInactive,
  label,
  focused,
}: {
  nameActive: keyof typeof Ionicons.glyphMap;
  nameInactive: keyof typeof Ionicons.glyphMap;
  label: string;
  focused: boolean;
}) {
  return (
    <View style={tabStyles.iconWrap}>
      <Ionicons
        name={focused ? nameActive : nameInactive}
        size={22}
        color={focused ? TAB_PRIMARY : '#9e9e9e'}
      />
      <Text style={[tabStyles.label, focused && tabStyles.labelActive]}>{label}</Text>
    </View>
  );
}

const tabStyles = StyleSheet.create({
  iconWrap: { alignItems: 'center', justifyContent: 'center', paddingTop: 4 },
  label: { fontSize: 10, color: '#9e9e9e', marginTop: 2 },
  labelActive: { color: TAB_PRIMARY, fontWeight: '600' },
});

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: '#ffffff',
          borderTopWidth: 1,
          borderTopColor: '#efefef',
          height: 60,
          paddingBottom: 8,
          paddingTop: 4,
        },
        tabBarShowLabel: false,
        tabBarActiveTintColor: TAB_PRIMARY,
        tabBarInactiveTintColor: '#9e9e9e',
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          tabBarIcon: ({ focused }) => (
            <TabIcon nameActive="home" nameInactive="home-outline" label="首页" focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="search"
        options={{
          tabBarIcon: ({ focused }) => (
            <TabIcon nameActive="search" nameInactive="search-outline" label="找房" focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="chat"
        options={{
          tabBarIcon: ({ focused }) => (
            <TabIcon nameActive="chatbubbles" nameInactive="chatbubbles-outline" label="助手" focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          tabBarIcon: ({ focused }) => (
            <TabIcon nameActive="person" nameInactive="person-outline" label="我的" focused={focused} />
          ),
        }}
      />
    </Tabs>
  );
}
