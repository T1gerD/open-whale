// 视觉基调：深色、低饱和，像一个“个人助理”而不是开发者工具。
//
// 文案同一条原则：面向用户说话（“有什么我可以帮你的？”），不要出现协议词
// （“帧”“握手”“endpoint”）——那些只出现在“高级/诊断”里。

export const colors = {
  background: '#0b1220',
  surface: '#131c31',
  surfaceAlt: '#1b2540',
  border: '#24304d',
  text: '#e8eefc',
  textMuted: '#93a4c8',
  accent: '#5b8cff',
  accentText: '#ffffff',
  success: '#3ddc97',
  warning: '#ffd479',
  danger: '#ff7a7a',
  bubbleUser: '#2a46a0',
  bubbleAssistant: '#1b2540',
} as const

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const

export const radius = {
  sm: 8,
  md: 12,
  lg: 18,
  pill: 999,
} as const

export const font = {
  title: 20,
  body: 16,
  small: 13,
  tiny: 11,
  mono: 'ui-monospace, Menlo, monospace',
} as const
