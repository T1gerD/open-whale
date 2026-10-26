// 视觉基调：浅色为主、深色自适应，像一个“个人助理”而不是开发者工具。
//
// 设计语言（v2.2.0 重做）：
//  * 圆角卡片 + 很轻的阴影 + 大留白，层级靠“表面色差”而不是边框；
//  * 状态一律用胶囊（StatusPill），参与者用头像色块（Avatar）；
//  * 主色只出现在“可操作”的东西上：发送、主按钮、未读、链接；
//  * 深浅色用同一套 token，页面里不出现任何写死的颜色。
//
// 文案同一条原则：面向用户说话（“有什么我可以帮你的？”），不要出现协议词
// （“帧”“握手”“endpoint”）——那些只出现在“高级/诊断”里。

import { createContext, useContext } from 'react'
import { useColorScheme, type ViewStyle } from 'react-native'

/**
 * 绝对定位铺满父容器的显式样式对象。
 *
 * RN 0.86 的类型里已没有 `StyleSheet.absoluteFillObject`（运行时也不保证有），
 * 在 StyleSheet.create 里展开它会直接报错/踩空；显式写四个方向最稳。
 */
export const absoluteFill: ViewStyle = { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }

export type ColorScheme = 'light' | 'dark'
/** 用户在设置里选的外观；system = 跟随系统。 */
export type AppearancePref = 'system' | 'light' | 'dark'

export interface Palette {
  /** 页面底色。 */
  background: string
  /** 卡片/列表所在的表面。 */
  surface: string
  /** 比 surface 更低一层的填充（输入框、次级按钮、代码行）。 */
  surfaceAlt: string
  /** 再低一层（进度条槽、分隔区域）。 */
  surfaceSunken: string
  border: string
  borderStrong: string
  text: string
  textSecondary: string
  textMuted: string
  textFaint: string
  accent: string
  accentPressed: string
  accentSoft: string
  accentText: string
  success: string
  successSoft: string
  warning: string
  warningSoft: string
  danger: string
  dangerSoft: string
  info: string
  infoSoft: string
  bubbleUser: string
  bubbleUserText: string
  bubbleAssistant: string
  bubbleAssistantBorder: string
  bubbleAssistantText: string
  composer: string
  overlay: string
  shadow: string
  codeBackground: string
  codeBorder: string
  codeText: string
  online: string
  offline: string
  /** 头像在线小圆点的描边色（跟所在表面一致，看起来才像“挖”出来的）。 */
  presenceRing: string
}

export interface Theme {
  scheme: ColorScheme
  colors: Palette
  /** 卡片阴影；深色模式几乎不用阴影，靠表面色差。 */
  shadow: { card: ViewStyle; floating: ViewStyle; composer: ViewStyle }
}

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 28,
  xxxl: 40,
} as const

export const radius = {
  xs: 6,
  sm: 10,
  md: 14,
  lg: 20,
  xl: 26,
  pill: 999,
} as const

export const font = {
  display: 28,
  title: 22,
  headline: 18,
  body: 16,
  callout: 15,
  small: 13,
  tiny: 11,
  mono: 'ui-monospace, Menlo, monospace',
} as const

const lightColors: Palette = {
  background: '#F4F5F8',
  surface: '#FFFFFF',
  surfaceAlt: '#F0F2F7',
  surfaceSunken: '#E9ECF3',
  border: '#E4E7EE',
  borderStrong: '#CBD2E0',
  text: '#111827',
  textSecondary: '#374151',
  textMuted: '#6B7280',
  textFaint: '#9CA3AF',
  accent: '#3B6BF5',
  accentPressed: '#2E56CC',
  accentSoft: '#EBF0FF',
  accentText: '#FFFFFF',
  success: '#0E9F6E',
  successSoft: '#E6F7F0',
  warning: '#B25E09',
  warningSoft: '#FFF3E0',
  danger: '#D92D20',
  dangerSoft: '#FEECEA',
  info: '#3B6BF5',
  infoSoft: '#EBF0FF',
  bubbleUser: '#3B6BF5',
  bubbleUserText: '#FFFFFF',
  bubbleAssistant: '#FFFFFF',
  bubbleAssistantBorder: '#E7EAF1',
  bubbleAssistantText: '#111827',
  composer: '#FFFFFF',
  overlay: 'rgba(17, 24, 39, 0.42)',
  shadow: 'rgba(17, 24, 39, 0.10)',
  codeBackground: '#F5F7FB',
  codeBorder: '#E1E5EE',
  codeText: '#1F2937',
  online: '#0E9F6E',
  offline: '#9CA3AF',
  presenceRing: '#FFFFFF',
}

const darkColors: Palette = {
  background: '#0B1020',
  surface: '#151B2E',
  surfaceAlt: '#1C2438',
  surfaceSunken: '#232C43',
  border: '#26304A',
  borderStrong: '#394662',
  text: '#EEF2FB',
  textSecondary: '#C9D3E8',
  textMuted: '#93A1C0',
  textFaint: '#6B7897',
  accent: '#7C96FF',
  accentPressed: '#6580E8',
  accentSoft: '#1C2748',
  accentText: '#0B1020',
  success: '#3DDC97',
  successSoft: '#122D24',
  warning: '#FFC46B',
  warningSoft: '#33270F',
  danger: '#FF7A7A',
  dangerSoft: '#331A1F',
  info: '#7C96FF',
  infoSoft: '#1C2748',
  bubbleUser: '#3B5BD6',
  bubbleUserText: '#F4F7FF',
  bubbleAssistant: '#1A2237',
  bubbleAssistantBorder: '#28324B',
  bubbleAssistantText: '#EEF2FB',
  composer: '#151B2E',
  overlay: 'rgba(3, 6, 15, 0.62)',
  shadow: 'rgba(0, 0, 0, 0.45)',
  codeBackground: '#121a2c',
  codeBorder: '#2A3450',
  codeText: '#DCE4F5',
  online: '#3DDC97',
  offline: '#6B7897',
  presenceRing: '#151B2E',
}

const lightShadow: Theme['shadow'] = {
  card: {
    shadowColor: lightColors.shadow,
    shadowOpacity: 1,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 6 },
    elevation: 2,
  },
  floating: {
    shadowColor: lightColors.shadow,
    shadowOpacity: 1,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 5 },
    elevation: 6,
  },
  composer: {
    shadowColor: lightColors.shadow,
    shadowOpacity: 1,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: -4 },
    elevation: 10,
  },
}

const darkShadow: Theme['shadow'] = {
  card: { elevation: 0 },
  floating: { elevation: 0 },
  composer: { elevation: 0 },
}

export const lightTheme: Theme = { scheme: 'light', colors: lightColors, shadow: lightShadow }
export const darkTheme: Theme = { scheme: 'dark', colors: darkColors, shadow: darkShadow }

export function themeFor(scheme: ColorScheme): Theme {
  return scheme === 'dark' ? darkTheme : lightTheme
}

/** 用户选择的外观（'system' 时跟随系统）。由根布局写入。 */
export const AppearanceContext = createContext<AppearancePref>('system')

/** 只用于调试/诊断：当前外观偏好（不改颜色）。 */
export function useAppearancePref(): AppearancePref {
  return useContext(AppearanceContext)
}

/** 最终生效的深浅色。 */
export function useThemeScheme(): ColorScheme {
  const pref = useContext(AppearanceContext)
  // 系统外观变化会触发重渲染；用户显式选择时忽略系统。
  const system = useColorScheme()
  if (pref === 'light' || pref === 'dark') return pref
  return system === 'dark' ? 'dark' : 'light'
}

export function useTheme(): Theme {
  return themeFor(useThemeScheme())
}

/**
 * 把样式工厂按“浅/深/工厂”缓存起来：每个组件只创建一次 StyleSheet，
 * 不会因为一次流式 delta 就重新 create 一遍样式。
 */
const STYLE_CACHE = new WeakMap<(theme: Theme) => unknown, Partial<Record<ColorScheme, unknown>>>()

export function useThemedStyles<T>(factory: (theme: Theme) => T): T {
  const theme = useTheme()
  let entry = STYLE_CACHE.get(factory)
  if (!entry) {
    entry = {}
    STYLE_CACHE.set(factory, entry)
  }
  const cached = entry[theme.scheme]
  if (cached !== undefined) return cached as T
  const created = factory(theme)
  entry[theme.scheme] = created
  return created
}
