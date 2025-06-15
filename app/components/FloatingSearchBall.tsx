/**
 * 浮动搜索球组件
 * 
 * 功能：
 * - 显示跨平台对比结果
 * - 显示验证提示
 * - 三种状态：收起、展开、隐藏
 * - 自动收起（3秒后）
 * - 支持拖动
 * - 半透明样式
 */

import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useRef, useState } from 'react';
import { Animated, Dimensions, PanResponder, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { floatingBallManager, type FloatingBallContent, type FloatingBallState } from '../lib/floating-ball-state';

const SCREEN_HEIGHT = Dimensions.get('window').height;
const SCREEN_WIDTH = Dimensions.get('window').width;
const BALL_SIZE = 60;
const EXPANDED_WIDTH = 280;
const EDGE_MARGIN = 16;

export function FloatingSearchBall() {
  const [state, setState] = useState<FloatingBallState>('hidden');
  const [content, setContent] = useState<FloatingBallContent | null>(null);
  const [scaleAnim] = useState(new Animated.Value(0));
  const [widthAnim] = useState(new Animated.Value(BALL_SIZE));
  const [opacityAnim] = useState(new Animated.Value(0.85));
  
  // 位置动画值
  const pan = useRef(new Animated.ValueXY({
    x: SCREEN_WIDTH - BALL_SIZE - EDGE_MARGIN,
    y: SCREEN_HEIGHT / 2 - BALL_SIZE / 2,
  })).current;
  
  const isDragging = useRef(false);

  // 创建 PanResponder 用于拖动
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, gestureState) => {
        // 只有移动超过5像素才认为是拖动
        return Math.abs(gestureState.dx) > 5 || Math.abs(gestureState.dy) > 5;
      },
      onPanResponderGrant: () => {
        isDragging.current = false;
        // 设置当前位置为偏移量
        pan.setOffset({
          x: (pan.x as any)._value,
          y: (pan.y as any)._value,
        });
        pan.setValue({ x: 0, y: 0 });
      },
      onPanResponderMove: (_, gestureState) => {
        isDragging.current = true;
        Animated.event([null, { dx: pan.x, dy: pan.y }], {
          useNativeDriver: false,
        })(_, gestureState);
      },
      onPanResponderRelease: (_, gestureState) => {
        pan.flattenOffset();
        
        const currentX = (pan.x as any)._value;
        const currentY = (pan.y as any)._value;
        
        // 计算边界
        const maxX = SCREEN_WIDTH - (state === 'expanded' ? EXPANDED_WIDTH : BALL_SIZE) - EDGE_MARGIN;
        const maxY = SCREEN_HEIGHT - BALL_SIZE - EDGE_MARGIN;
        
        // 限制在屏幕范围内
        const boundedX = Math.max(EDGE_MARGIN, Math.min(maxX, currentX));
        const boundedY = Math.max(EDGE_MARGIN, Math.min(maxY, currentY));
        
        // 吸附到最近的边缘（左或右）
        const snapToRight = boundedX > SCREEN_WIDTH / 2;
        const finalX = snapToRight 
          ? SCREEN_WIDTH - (state === 'expanded' ? EXPANDED_WIDTH : BALL_SIZE) - EDGE_MARGIN
          : EDGE_MARGIN;
        
        // 动画移动到最终位置
        Animated.spring(pan, {
          toValue: { x: finalX, y: boundedY },
          useNativeDriver: false,
          tension: 50,
          friction: 8,
        }).start();
        
        // 延迟一点再允许点击，避免拖动后误触
        setTimeout(() => {
          isDragging.current = false;
        }, 100);
      },
    })
  ).current;

  useEffect(() => {
    // 订阅状态变化
    const unsubscribe = floatingBallManager.subscribe(() => {
      const newState = floatingBallManager.getState();
      const newContent = floatingBallManager.getContent();
      setState(newState);
      setContent(newContent);
    });

    return unsubscribe;
  }, []);

  useEffect(() => {
    // 根据状态执行动画
    if (state === 'hidden') {
      Animated.parallel([
        Animated.spring(scaleAnim, {
          toValue: 0,
          useNativeDriver: true,
          tension: 50,
          friction: 7,
        }),
        Animated.timing(opacityAnim, {
          toValue: 0,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start();
    } else if (state === 'collapsed') {
      Animated.parallel([
        Animated.spring(scaleAnim, {
          toValue: 1,
          useNativeDriver: true,
          tension: 50,
          friction: 7,
        }),
        Animated.spring(widthAnim, {
          toValue: BALL_SIZE,
          useNativeDriver: false,
          tension: 50,
          friction: 7,
        }),
        Animated.timing(opacityAnim, {
          toValue: 0.75,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start(() => {
        // 收起后调整位置到边缘
        const currentX = (pan.x as any)._value;
        const snapToRight = currentX > SCREEN_WIDTH / 2;
        const finalX = snapToRight 
          ? SCREEN_WIDTH - BALL_SIZE - EDGE_MARGIN
          : EDGE_MARGIN;
        
        Animated.spring(pan.x, {
          toValue: finalX,
          useNativeDriver: false,
          tension: 50,
          friction: 8,
        }).start();
      });
    } else if (state === 'expanded') {
      Animated.parallel([
        Animated.spring(scaleAnim, {
          toValue: 1,
          useNativeDriver: true,
          tension: 50,
          friction: 7,
        }),
        Animated.spring(widthAnim, {
          toValue: EXPANDED_WIDTH,
          useNativeDriver: false,
          tension: 50,
          friction: 7,
        }),
        Animated.timing(opacityAnim, {
          toValue: 0.95,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start(() => {
        // 展开后调整位置，确保不超出屏幕
        const currentX = (pan.x as any)._value;
        const maxX = SCREEN_WIDTH - EXPANDED_WIDTH - EDGE_MARGIN;
        
        if (currentX > maxX) {
          Animated.spring(pan.x, {
            toValue: maxX,
            useNativeDriver: false,
            tension: 50,
            friction: 8,
          }).start();
        }
      });
    }
  }, [state, scaleAnim, widthAnim, opacityAnim, pan]);

  if (state === 'hidden' || !content) {
    return null;
  }

  const handlePress = () => {
    // 如果正在拖动，不响应点击
    if (isDragging.current) {
      return;
    }
    
    if (state === 'collapsed') {
      floatingBallManager.expand();
    } else {
      if (content?.onAction) {
        content.onAction();
      }
    }
  };

  const handleClose = () => {
    floatingBallManager.hide();
  };

  const getIcon = () => {
    switch (content.type) {
      case 'comparison':
        return 'git-compare-outline';
      case 'verification':
        return 'shield-checkmark-outline';
      case 'info':
        return 'information-circle-outline';
      default:
        return 'information-circle-outline';
    }
  };

  const getColor = () => {
    switch (content.type) {
      case 'comparison':
        return '#00ae66';
      case 'verification':
        return '#ff9500';
      case 'info':
        return '#007aff';
      default:
        return '#007aff';
    }
  };

  return (
    <Animated.View
      {...panResponder.panHandlers}
      style={[
        styles.container,
        {
          transform: [
            { translateX: pan.x },
            { translateY: pan.y },
            { scale: scaleAnim },
          ],
          width: widthAnim,
          backgroundColor: getColor(),
          opacity: opacityAnim,
        },
      ]}
    >
      <TouchableOpacity
        style={styles.touchable}
        onPress={handlePress}
        activeOpacity={0.9}
        disabled={isDragging.current}
      >
        <View style={styles.content}>
          <Ionicons name={getIcon() as any} size={24} color="#fff" />
          
          {state === 'expanded' && (
            <View style={styles.textContainer}>
              <Text style={styles.title} numberOfLines={1}>
                {content.title}
              </Text>
              <Text style={styles.message} numberOfLines={2}>
                {content.message}
              </Text>
              {content.actionLabel && (
                <Text style={styles.actionLabel}>
                  {content.actionLabel} →
                </Text>
              )}
            </View>
          )}

          {state === 'expanded' && (
            <TouchableOpacity
              style={styles.closeButton}
              onPress={handleClose}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <Ionicons name="close" size={20} color="#fff" />
            </TouchableOpacity>
          )}
        </View>
      </TouchableOpacity>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: 0,
    top: 0,
    height: BALL_SIZE,
    borderRadius: 30,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 8,
    zIndex: 9999,
  },
  touchable: {
    flex: 1,
    borderRadius: 30,
  },
  content: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  textContainer: {
    flex: 1,
    marginLeft: 12,
    marginRight: 8,
  },
  title: {
    fontSize: 14,
    fontWeight: '600',
    color: '#fff',
    marginBottom: 2,
  },
  message: {
    fontSize: 12,
    color: 'rgba(255, 255, 255, 0.9)',
    lineHeight: 16,
  },
  actionLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#fff',
    marginTop: 4,
  },
  closeButton: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
