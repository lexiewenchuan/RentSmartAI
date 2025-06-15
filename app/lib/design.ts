/**
 * 全局设计系统：色彩、排版、间距、圆角、阴影
 * 保证整个应用简约清爽、易读、视觉和谐
 */

export const Colors = {
  // 主色：浅绿（清爽专业）
  primary: '#06c755', // 租房app通用的浅绿
  primaryLight: '#e8f5e9', // 浅绿背景
  primaryDark: '#058643', // 深交互状态
  
  // 文本色
  textPrimary: '#222222', // 主文本
  textSecondary: '#757575', // 次文本
  textTertiary: '#999999', // 弱提示
  textInverse: '#ffffff', // 反色文本
  
  // 背景色
  bgPrimary: '#ffffff', // 主背景（卡片）
  bgSecondary: '#f5f5f8', // 次背景（页面）
  bgTertiary: '#fafafa', // 弱背景（悬停）
  
  // 分割线
  divider: '#efefef',
  dividerLight: '#f5f5f5',
  
  // 状态色
  success: '#06c755',
  warning: '#ff9c00',
  error: '#d4453d',
  info: '#1890ff',
  
  // 透明度变量
  transparentBlack05: 'rgba(0, 0, 0, 0.05)',
  transparentBlack10: 'rgba(0, 0, 0, 0.1)',
  transparentWhite10: 'rgba(255, 255, 255, 0.1)',
};

export const Typography = {
  // 标题
  h1: { fontSize: 20, fontWeight: '700' as const, lineHeight: 28, letterSpacing: -0.4 },
  h2: { fontSize: 18, fontWeight: '700' as const, lineHeight: 26 },
  h3: { fontSize: 16, fontWeight: '600' as const, lineHeight: 24 },
  h4: { fontSize: 14, fontWeight: '600' as const, lineHeight: 22 },
  
  // 正文
  body1: { fontSize: 14, fontWeight: '400' as const, lineHeight: 22 },
  body2: { fontSize: 13, fontWeight: '400' as const, lineHeight: 20 },
  
  // 标签/说明
  label: { fontSize: 12, fontWeight: '500' as const, lineHeight: 18 },
  labelSmall: { fontSize: 11, fontWeight: '400' as const, lineHeight: 16 },
};

export const Spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
};

export const Radius = {
  none: 0,
  sm: 6,
  md: 8,
  lg: 12,
  full: 9999,
};

export const Shadow = {
  xs: { shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 2, elevation: 1 },
  sm: { shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.08, shadowRadius: 4, elevation: 2 },
  md: { shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.1, shadowRadius: 8, elevation: 3 },
};

export const Transitions = {
  fast: 150,
  normal: 300,
  slow: 500,
};
