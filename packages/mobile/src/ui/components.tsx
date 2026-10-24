// 基础 UI 积木。样式集中在这里，屏幕文件只关心布局与交互。

import type { ReactNode } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'

import { colors, font, radius, spacing } from './theme'

export function Card({ children, style }: { children: ReactNode; style?: object }) {
  return <View style={[styles.card, style]}>{children}</View>
}

export function Divider() {
  return <View style={styles.divider} />
}

export function Muted({ children, style }: { children: ReactNode; style?: object }) {
  return <Text style={[styles.muted, style]}>{children}</Text>
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <Text style={styles.sectionTitle}>{children}</Text>
}

export function PrimaryButton({
  label,
  onPress,
  disabled,
  loading,
}: {
  label: string
  onPress: () => void
  disabled?: boolean
  loading?: boolean
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [styles.button, styles.buttonPrimary, (disabled || loading) && styles.buttonDisabled, pressed && styles.buttonPressed]}
    >
      {loading ? <ActivityIndicator color={colors.accentText} /> : <Text style={styles.buttonPrimaryText}>{label}</Text>}
    </Pressable>
  )
}

export function SecondaryButton({
  label,
  onPress,
  disabled,
  tone = 'default',
}: {
  label: string
  onPress: () => void
  disabled?: boolean
  tone?: 'default' | 'danger'
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        styles.buttonSecondary,
        tone === 'danger' && styles.buttonDanger,
        disabled && styles.buttonDisabled,
        pressed && styles.buttonPressed,
      ]}
    >
      <Text style={[styles.buttonSecondaryText, tone === 'danger' && styles.buttonDangerText]}>{label}</Text>
    </Pressable>
  )
}

/** 一条横幅：信息 / 提醒 / 错误。可带一个动作按钮（例如“重连”）。 */
export function Banner({
  tone = 'info',
  title,
  children,
  actionLabel,
  onAction,
}: {
  tone?: 'info' | 'warning' | 'error' | 'success'
  title?: string
  children?: ReactNode
  actionLabel?: string
  onAction?: () => void
}) {
  const toneStyle =
    tone === 'error'
      ? styles.bannerError
      : tone === 'warning'
        ? styles.bannerWarning
        : tone === 'success'
          ? styles.bannerSuccess
          : styles.bannerInfo
  return (
    <View style={[styles.banner, toneStyle]}>
      <View style={styles.bannerBody}>
        {title ? <Text style={styles.bannerTitle}>{title}</Text> : null}
        {/*
          永远包在 <Text> 里。
          调用方常传数组（例如 `{error.message}{hint ? ... : ''}`），而 React Native
          不会渲染 View 下的裸字符串——正文会静默消失。之前的写法只处理了
          `typeof children === 'string'`，数组走 else 分支后就什么都不显示，
          于是所有绑定失败提示都变成了没有正文的空横幅。
        */}
        {children ? <Text style={styles.bannerText}>{children}</Text> : null}
      </View>
      {actionLabel && onAction ? (
        <Pressable onPress={onAction} accessibilityRole="button" style={styles.bannerAction}>
          <Text style={styles.bannerActionText}>{actionLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  )
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>{title}</Text>
      {hint ? <Text style={styles.emptyHint}>{hint}</Text> : null}
    </View>
  )
}

export function StatusDot({ online, connecting }: { online: boolean; connecting?: boolean }) {
  const color = online ? colors.success : connecting ? colors.warning : colors.textMuted
  return <View style={[styles.dot, { backgroundColor: color }]} />
}

export function ProgressBar({ progress }: { progress?: number }) {
  return (
    <View style={styles.progressTrack}>
      {/* 进度未知（大小未声明）时不画确定进度，避免百分比撒谎 */}
      <View style={[styles.progressFill, { width: progress === undefined ? '35%' : `${Math.round(progress * 100)}%` }]} />
    </View>
  )
}

export function KeyValue({ label, value }: { label: string; value: ReactNode }) {
  return (
    <View style={styles.kvRow}>
      <Text style={styles.kvLabel}>{label}</Text>
      {typeof value === 'string' ? <Text style={styles.kvValue}>{value}</Text> : value}
    </View>
  )
}

export const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
    marginVertical: spacing.md,
  },
  muted: { color: colors.textMuted, fontSize: font.small },
  sectionTitle: {
    color: colors.textMuted,
    fontSize: font.small,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: spacing.sm,
  },
  button: {
    minHeight: 44,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  buttonPrimary: { backgroundColor: colors.accent },
  buttonPrimaryText: { color: colors.accentText, fontSize: font.body, fontWeight: '600' },
  buttonSecondary: { backgroundColor: colors.surfaceAlt, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  buttonSecondaryText: { color: colors.text, fontSize: font.body },
  buttonDanger: { backgroundColor: '#3a1c24', borderColor: colors.danger },
  buttonDangerText: { color: colors.danger },
  buttonDisabled: { opacity: 0.5 },
  buttonPressed: { opacity: 0.8 },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  bannerBody: { flex: 1 },
  bannerInfo: { backgroundColor: '#16233f', borderColor: colors.border },
  bannerWarning: { backgroundColor: '#33280f', borderColor: colors.warning },
  bannerError: { backgroundColor: '#331a1f', borderColor: colors.danger },
  bannerSuccess: { backgroundColor: '#12301f', borderColor: colors.success },
  bannerTitle: { color: colors.text, fontWeight: '600', marginBottom: 2 },
  bannerText: { color: colors.text, fontSize: font.small, lineHeight: 19 },
  bannerAction: { paddingHorizontal: spacing.sm, paddingVertical: spacing.xs },
  bannerActionText: { color: colors.accent, fontWeight: '600' },
  empty: { alignItems: 'center', paddingVertical: spacing.xxl, paddingHorizontal: spacing.xl },
  emptyTitle: { color: colors.text, fontSize: font.title, textAlign: 'center', marginBottom: spacing.sm },
  emptyHint: { color: colors.textMuted, fontSize: font.small, textAlign: 'center', lineHeight: 20 },
  dot: { width: 8, height: 8, borderRadius: 4, marginRight: spacing.sm },
  progressTrack: { height: 4, borderRadius: 2, backgroundColor: colors.surfaceAlt, overflow: 'hidden', marginTop: spacing.sm },
  progressFill: { height: 4, borderRadius: 2, backgroundColor: colors.accent },
  kvRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: spacing.xs },
  kvLabel: { color: colors.textMuted, fontSize: font.small, flexShrink: 0, marginRight: spacing.md },
  kvValue: { color: colors.text, fontSize: font.small, flexShrink: 1, textAlign: 'right' },
})
