// ── 统一的设计系统（链家风格） ──────────────────────────────

// ── 颜色 ──────────────────────────────────────────────────────
export const COLORS = {
  // 主色 - 链家绿
  primary: '#00ae66',
  primaryLight: '#e8f7f0',
  primaryDark: '#008c52',

  // 中性色
  bg: '#f5f5f8',       // 背景
  bgCard: '#fff',      // 卡片背景
  border: '#f0f0f0',   // 边框
  divider: '#f0f0f0',  // 分割线

  // 文字
  textPrimary: '#222',     // 深色文字
  textSecondary: '#555',   // 中等文字
  textTertiary: '#999',    // 浅文字
  textDisabled: '#bbb',    // 禁用文字

  // 功能色
  danger: '#e74c3c',
  dangerBg: '#fff5f5',
  dangerBorder: '#ffe0e0',

  warning: '#f5a623',
  warningBg: '#fff8e6',

  success: '#27ae60',

  // 价格色
  price: '#fe5500',
  priceBg: '#fff5f0',

  // 评分色
  scoreBgHigh: '#e8f7f0',
  scoreBgMid: '#fff8e6',
  scoreBgLow: '#fff0f0',
  scoreTextHigh: '#00ae66',
  scoreTextMid: '#f5a623',
  scoreTextLow: '#e74c3c',
};

// ── 字体大小 ────────────────────────────────────────────────
export const FONT_SIZES = {
  xs: 11,
  sm: 12,
  base: 14,
  lg: 15,
  xl: 16,
  '2xl': 17,
  '3xl': 18,
  '4xl': 22,
  '5xl': 26,
};

// ── 字体权重 ────────────────────────────────────────────────
export const FONT_WEIGHTS = {
  normal: '400' as const,
  medium: '500' as const,
  semibold: '600' as const,
  bold: '700' as const,
  black: '800' as const,
};

// ── 行高 ────────────────────────────────────────────────────
export const LINE_HEIGHTS = {
  tight: 18,
  normal: 20,
  relaxed: 22,
  loose: 28,
};

// ── 间距 ────────────────────────────────────────────────────
export const SPACING = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  '2xl': 24,
  '3xl': 32,
};

// ── 圆角 ────────────────────────────────────────────────────
export const BORDER_RADIUS = {
  sm: 6,
  md: 8,
  lg: 12,
  xl: 16,
  full: 20,
};

// ── 阴影 ────────────────────────────────────────────────────
export const SHADOWS = {
  // React Native shadow 需要 shadowColor, shadowOffset, shadowOpacity, shadowRadius
  sm: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 4,
    elevation: 1,
  },
  md: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 6,
    elevation: 2,
  },
  lg: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 3,
  },
};

// ── 通用样式快捷方式 ────────────────────────────────────────
export const COMMON_STYLES = {
  card: {
    backgroundColor: COLORS.bgCard,
    borderRadius: BORDER_RADIUS.lg,
    ...SHADOWS.sm,
  },
  section: {
    backgroundColor: COLORS.bgCard,
    marginTop: 10,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.lg,
  },
  input: {
    backgroundColor: COLORS.bg,
    borderRadius: BORDER_RADIUS.md,
    padding: SPACING.md,
    fontSize: FONT_SIZES.base,
    color: COLORS.textPrimary,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
};
