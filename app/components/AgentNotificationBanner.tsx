/**
 * AgentNotificationBanner - Top banner notification for Agent recommendations
 * Shows when user is not on chat screen and Agent has new recommendations
 */

import { Ionicons } from '@expo/vector-icons';
import { router, usePathname } from 'expo-router';
import { useEffect, useState } from 'react';
import {
    Animated,
    Platform,
    Pressable,
    StyleSheet,
    Text,
    View,
} from 'react-native';
import {
    AgentNotification,
    notificationState,
} from '../lib/notification-state';

const Colors = {
  primary: '#007AFF',
  background: '#F2F2F7',
  white: '#FFFFFF',
  textPrimary: '#000000',
  textSecondary: '#8E8E93',
  border: '#C6C6C8',
};

const Typography = {
  body2: {
    fontSize: 14,
    lineHeight: 20,
  },
  caption: {
    fontSize: 12,
    lineHeight: 16,
  },
};

const Spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
};

export function AgentNotificationBanner() {
  const [notification, setNotification] = useState<AgentNotification | null>(null);
  const [slideAnim] = useState(new Animated.Value(-100));
  const pathname = usePathname();

  // Check if user is on chat screen
  const isOnChatScreen = pathname === '/chat' || pathname.includes('/(tabs)/chat');

  useEffect(() => {
    // Subscribe to notification state changes
    const unsubscribe = notificationState.subscribe((newNotification) => {
      setNotification(newNotification);
    });

    return unsubscribe;
  }, []);

  useEffect(() => {
    // Show/hide banner based on notification and current screen
    if (notification && !isOnChatScreen) {
      // Slide in
      Animated.spring(slideAnim, {
        toValue: 0,
        useNativeDriver: true,
        tension: 65,
        friction: 10,
      }).start();
    } else {
      // Slide out
      Animated.timing(slideAnim, {
        toValue: -100,
        duration: 200,
        useNativeDriver: true,
      }).start();
    }
  }, [notification, isOnChatScreen, slideAnim]);

  const handlePress = () => {
    // Navigate to chat screen
    router.push('/(tabs)/chat');
    // Dismiss notification after navigation
    setTimeout(() => {
      notificationState.dismissNotification();
    }, 300);
  };

  const handleDismiss = () => {
    notificationState.dismissNotification();
  };

  if (!notification || isOnChatScreen) {
    return null;
  }

  return (
    <Animated.View
      style={[
        styles.container,
        {
          transform: [{ translateY: slideAnim }],
        },
      ]}
    >
      <Pressable
        style={styles.banner}
        onPress={handlePress}
        android_ripple={{ color: 'rgba(0, 122, 255, 0.1)' }}
      >
        <View style={styles.iconContainer}>
          <Ionicons name="sparkles" size={20} color={Colors.primary} />
        </View>
        
        <View style={styles.content}>
          <Text style={styles.message} numberOfLines={2}>
            {notification.message}
          </Text>
          {notification.folderName && (
            <Text style={styles.subtitle} numberOfLines={1}>
              收藏夹：{notification.folderName}
            </Text>
          )}
        </View>

        <Pressable
          style={styles.dismissButton}
          onPress={handleDismiss}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Ionicons name="close" size={20} color={Colors.textSecondary} />
        </Pressable>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 1000,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.1,
        shadowRadius: 4,
      },
      android: {
        elevation: 4,
      },
    }),
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.white,
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    gap: Spacing.md,
  },
  iconContainer: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: Colors.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  content: {
    flex: 1,
    gap: Spacing.xs,
  },
  message: {
    ...Typography.body2,
    color: Colors.textPrimary,
    fontWeight: '500',
  },
  subtitle: {
    ...Typography.caption,
    color: Colors.textSecondary,
  },
  dismissButton: {
    padding: Spacing.xs,
  },
});
