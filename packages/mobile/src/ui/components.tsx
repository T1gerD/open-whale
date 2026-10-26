// 基础 UI 积木。样式集中在这里，屏幕文件只关心布局与交互。
//
// 约定：
//  * 组件**纯展示**：不读 store、不发请求、不写业务判断；回调由屏幕传入。
//  * 颜色一律从 useTheme() 取，深浅色同一套组件，页面里不许出现写死的颜色。
//  * 样式工厂写在本文件底部，经 useThemedStyles 按浅/深缓存（流式 delta 不会重建 StyleSheet）。

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ActivityIndicator,
  Animated,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { absoluteFill, font, radius, spacing, useTheme, useThemedStyles, type Palette, type Theme } from './theme'

// ---------------------------------------------------------------------------
// 容器 / 文本
// ---------------------------------------------------------------------------

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const styles = useThemedStyles(createCardStyles)
  return <View style={[styles.card, style]}>{children}</View>
}

/** 设置页的分组卡片：标题 + 说明 + 一组行。 */
export function SectionCard({
  title,
  subtitle,
  children,
  footer,
  style,
}: {
  title?: string
  subtitle?: string
  children: ReactNode
  footer?: ReactNode
  style?: StyleProp<ViewStyle>
}) {
  const styles = useThemedStyles(createCardStyles)
  return (
    <View style={[styles.card, styles.sectionCard, style]}>
      {title ? (
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>{title}</Text>
          {subtitle ? <Text style={styles.sectionSubtitle}>{subtitle}</Text> : null}
        </View>
      ) : null}
      {children}
      {footer ? <View style={styles.sectionFooter}>{footer}</View> : null}
    </View>
  )
}

export function SectionTitle({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  const styles = useThemedStyles(createTextStyles)
  return <Text style={[styles.sectionLabel, style]}>{children}</Text>
}

export function Divider({ style }: { style?: StyleProp<ViewStyle> }) {
  const styles = useThemedStyles(createCardStyles)
  return <View style={[styles.divider, style]} />
}

export function Muted({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  const styles = useThemedStyles(createTextStyles)
  return <Text style={[styles.muted, style]}>{children}</Text>
}

/** 一行“标签 — 值”，用于设置页的连接信息/诊断。 */
export function KeyValue({ label, value }: { label: string; value: ReactNode }) {
  const styles = useThemedStyles(createTextStyles)
  return (
    <View style={styles.kvRow}>
      <Text style={styles.kvLabel}>{label}</Text>
      {typeof value === 'string' ? (
        <Text style={styles.kvValue} numberOfLines={2}>
          {value}
        </Text>
      ) : (
        value
      )}
    </View>
  )
}

// ---------------------------------------------------------------------------
// 按钮
// ---------------------------------------------------------------------------

export function PrimaryButton({
  label,
  onPress,
  disabled,
  loading,
  tone = 'accent',
  style,
}: {
  label: string
  onPress: () => void
  disabled?: boolean
  loading?: boolean
  tone?: 'accent' | 'danger'
  style?: StyleProp<ViewStyle>
}) {
  const styles = useThemedStyles(createButtonStyles)
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        styles.button,
        tone === 'danger' ? styles.primaryDanger : styles.primary,
        (disabled || loading) && styles.disabled,
        pressed && styles.pressed,
        style,
      ]}
    >
      {loading ? <ActivityIndicator size="small" color="#FFFFFF" /> : <Text style={styles.primaryText}>{label}</Text>}
    </Pressable>
  )
}

export function SecondaryButton({
  label,
  onPress,
  disabled,
  tone = 'default',
  style,
}: {
  label: string
  onPress: () => void
  disabled?: boolean
  tone?: 'default' | 'danger'
  style?: StyleProp<ViewStyle>
}) {
  const styles = useThemedStyles(createButtonStyles)
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        styles.secondary,
        tone === 'danger' && styles.secondaryDanger,
        disabled && styles.disabled,
        pressed && styles.pressed,
        style,
      ]}
    >
      <Text style={[styles.secondaryText, tone === 'danger' && styles.secondaryDangerText]}>{label}</Text>
    </Pressable>
  )
}

/** 圆形图标按钮：输入栏、滚动到底部、Header 动作。glyph 用字符（不引图标库）。 */
export function IconButton({
  glyph,
  label,
  onPress,
  disabled,
  tone = 'default',
  size = 40,
  style,
}: {
  glyph: string
  label: string
  onPress: () => void
  disabled?: boolean
  tone?: 'default' | 'accent' | 'danger' | 'ghost'
  size?: number
  style?: StyleProp<ViewStyle>
}) {
  const theme = useTheme()
  const styles = useThemedStyles(createButtonStyles)
  const background =
    tone === 'accent' ? theme.colors.accent : tone === 'danger' ? theme.colors.dangerSoft : tone === 'ghost' ? 'transparent' : theme.colors.surfaceAlt
  const color = tone === 'accent' ? theme.colors.accentText : tone === 'danger' ? theme.colors.danger : theme.colors.textSecondary
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      disabled={disabled}
      hitSlop={6}
      style={({ pressed }) => [
        styles.iconButton,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: background },
        disabled && styles.disabled,
        pressed && styles.pressed,
        style,
      ]}
    >
      <Text style={[styles.iconGlyph, { color, fontSize: Math.round(size * 0.42) }]}>{glyph}</Text>
    </Pressable>
  )
}

/** 设置页里的一行可点项（标题 + 说明 + 右侧箭头/自定义尾部）。 */
export function ListRow({
  title,
  subtitle,
  leading,
  trailing,
  onPress,
  danger,
  style,
}: {
  title: string
  subtitle?: string
  leading?: ReactNode
  trailing?: ReactNode
  onPress?: () => void
  danger?: boolean
  style?: StyleProp<ViewStyle>
}) {
  const theme = useTheme()
  const styles = useThemedStyles(createListRowStyles)
  const content = (
    <>
      {leading ? <View style={styles.leading}>{leading}</View> : null}
      <View style={styles.body}>
        <Text style={[styles.title, danger && { color: theme.colors.danger }]} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={styles.subtitle} numberOfLines={2}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {trailing ?? (onPress ? <Text style={styles.chevron}>›</Text> : null)}
    </>
  )
  if (!onPress) return <View style={[styles.row, style]}>{content}</View>
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.row, pressed && styles.rowPressed, style]}>
      {content}
    </Pressable>
  )
}

export function SwitchRow({
  label,
  description,
  value,
  onValueChange,
  disabled,
  style,
}: {
  label: string
  description?: string
  value: boolean
  onValueChange: (value: boolean) => void
  disabled?: boolean
  style?: StyleProp<ViewStyle>
}) {
  const theme = useTheme()
  const styles = useThemedStyles(createListRowStyles)
  return (
    <View style={[styles.row, style]}>
      <View style={styles.body}>
        <Text style={[styles.title, disabled && { color: theme.colors.textFaint }]}>{label}</Text>
        {description ? (
          <Text style={styles.subtitle} numberOfLines={4}>
            {description}
          </Text>
        ) : null}
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        trackColor={{ false: theme.colors.surfaceSunken, true: theme.colors.accent }}
        thumbColor="#FFFFFF"
      />
    </View>
  )
}

// ---------------------------------------------------------------------------
// 状态 / 标识
// ---------------------------------------------------------------------------

export type StatusTone = 'online' | 'offline' | 'connecting' | 'error' | 'warning' | 'accent' | 'neutral'

function tonePalette(colors: Palette, tone: StatusTone): { bg: string; fg: string; dot: string } {
  switch (tone) {
    case 'online':
      return { bg: colors.successSoft, fg: colors.success, dot: colors.online }
    case 'error':
      return { bg: colors.dangerSoft, fg: colors.danger, dot: colors.danger }
    case 'warning':
    case 'connecting':
      return { bg: colors.warningSoft, fg: colors.warning, dot: colors.warning }
    case 'accent':
      return { bg: colors.accentSoft, fg: colors.accent, dot: colors.accent }
    case 'offline':
      return { bg: colors.surfaceSunken, fg: colors.textMuted, dot: colors.offline }
    default:
      return { bg: colors.surfaceAlt, fg: colors.textMuted, dot: colors.textFaint }
  }
}

/** 状态胶囊：在线 / 重连中 / 连接失败 / 固定标签。可点（例如点“离线”去重连）。 */
export function StatusPill({
  label,
  tone = 'neutral',
  onPress,
  style,
}: {
  label: string
  tone?: StatusTone
  onPress?: () => void
  style?: StyleProp<ViewStyle>
}) {
  const theme = useTheme()
  const styles = useThemedStyles(createPillStyles)
  const palette = tonePalette(theme.colors, tone)
  const body = (
    <View style={[styles.pill, { backgroundColor: palette.bg }, style]}>
      <View style={[styles.pillDot, { backgroundColor: palette.dot }]} />
      <Text style={[styles.pillLabel, { color: palette.fg }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  )
  if (!onPress) return body
  return (
    <Pressable accessibilityRole="button" onPress={onPress} hitSlop={6}>
      {body}
    </Pressable>
  )
}

/** 小标签：网络类型、协作模式等。 */
export function Chip({
  label,
  tone = 'neutral',
  style,
}: {
  label: string
  tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger'
  style?: StyleProp<ViewStyle>
}) {
  const theme = useTheme()
  const styles = useThemedStyles(createPillStyles)
  const map: Record<string, { bg: string; fg: string }> = {
    neutral: { bg: theme.colors.surfaceAlt, fg: theme.colors.textMuted },
    accent: { bg: theme.colors.accentSoft, fg: theme.colors.accent },
    success: { bg: theme.colors.successSoft, fg: theme.colors.success },
    warning: { bg: theme.colors.warningSoft, fg: theme.colors.warning },
    danger: { bg: theme.colors.dangerSoft, fg: theme.colors.danger },
  }
  const colors = map[tone] ?? map.neutral!
  return (
    <View style={[styles.chip, { backgroundColor: colors.bg }, style]}>
      <Text style={[styles.chipLabel, { color: colors.fg }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  )
}

export function StatusDot({ online, connecting, size = 8 }: { online: boolean; connecting?: boolean; size?: number }) {
  const theme = useTheme()
  const color = online ? theme.colors.online : connecting ? theme.colors.warning : theme.colors.offline
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />
}

// ---------------------------------------------------------------------------
// 头像
// ---------------------------------------------------------------------------

const AVATAR_TONES = ['#3B6BF5', '#8B5CF6', '#0E9F6E', '#E68A00', '#DB2777', '#0891B2', '#EA580C', '#4F46E5']

function avatarTone(seed: string): string {
  let hash = 0
  for (const char of seed) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 100000
  return AVATAR_TONES[hash % AVATAR_TONES.length] ?? AVATAR_TONES[0]!
}

function initialOf(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) return '?'
  return Array.from(trimmed)[0]!.toUpperCase()
}

/** 参与者/助理头像：取名字首字母，颜色由名字稳定决定；右下角在线小圆点。 */
export function Avatar({
  name,
  size = 40,
  online,
  isMe,
  style,
}: {
  name: string
  size?: number
  online?: boolean
  isMe?: boolean
  style?: StyleProp<ViewStyle>
}) {
  const theme = useTheme()
  const styles = useThemedStyles(createAvatarStyles)
  const dot = Math.max(8, Math.round(size * 0.28))
  return (
    <View style={[{ width: size, height: size }, style]}>
      <View
        style={[
          styles.avatar,
          {
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: avatarTone(name),
            borderColor: isMe ? theme.colors.accent : 'transparent',
            borderWidth: isMe ? 2 : 0,
            opacity: online === false ? 0.55 : 1,
          },
        ]}
      >
        <Text style={[styles.avatarText, { fontSize: Math.round(size * 0.42) }]}>{initialOf(name)}</Text>
      </View>
      {online !== undefined ? (
        <View
          style={[
            styles.presence,
            {
              width: dot,
              height: dot,
              borderRadius: dot / 2,
              backgroundColor: online ? theme.colors.online : theme.colors.offline,
              borderColor: theme.colors.presenceRing,
              borderWidth: 2,
              right: 0,
              bottom: 0,
            },
          ]}
        />
      ) : null}
    </View>
  )
}

export interface Person {
  deviceId: string
  name: string
  online: boolean
  isMe?: boolean
}

/** 聊天页/设置页顶部的参与者头像条：在线绿点，自己带主色描边。 */
export function AvatarBar({
  people,
  style,
  max = 8,
}: {
  people: Person[]
  style?: StyleProp<ViewStyle>
  max?: number
}) {
  const styles = useThemedStyles(createAvatarStyles)
  if (people.length === 0) return null
  const shown = people.slice(0, max)
  const hidden = people.length - shown.length
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={[styles.bar, style]}>
      {shown.map(person => (
        <View key={person.deviceId} style={styles.barItem}>
          <Avatar name={person.name} size={28} online={person.online} isMe={person.isMe} />
          <Text style={styles.barName} numberOfLines={1}>
            {person.isMe ? '我' : person.name}
          </Text>
        </View>
      ))}
      {hidden > 0 ? <View style={styles.barItem}><Chip label={`+${hidden}`} /></View> : null}
    </ScrollView>
  )
}

// ---------------------------------------------------------------------------
// 空态 / 横幅 / 进度
// ---------------------------------------------------------------------------

/** 空态引导：glyph 大圆、标题、说明，可选 1-2-3 步骤和主按钮。 */
export function EmptyState({
  glyph = '✦',
  title,
  hint,
  steps,
  actionLabel,
  onAction,
  style,
}: {
  glyph?: string
  title: string
  hint?: string
  steps?: string[]
  actionLabel?: string
  onAction?: () => void
  style?: StyleProp<ViewStyle>
}) {
  const styles = useThemedStyles(createEmptyStyles)
  return (
    <View style={[styles.empty, style]}>
      <View style={styles.glyphRing}>
        <Text style={styles.glyph}>{glyph}</Text>
      </View>
      <Text style={styles.title}>{title}</Text>
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
      {steps && steps.length > 0 ? (
        <View style={styles.steps}>
          {steps.map((step, index) => (
            <View key={step} style={styles.stepRow}>
              <View style={styles.stepIndex}>
                <Text style={styles.stepIndexText}>{index + 1}</Text>
              </View>
              <Text style={styles.stepText}>{step}</Text>
            </View>
          ))}
        </View>
      ) : null}
      {actionLabel && onAction ? (
        <PrimaryButton label={actionLabel} onPress={onAction} style={styles.emptyAction} />
      ) : null}
    </View>
  )
}

export interface InlineBannerProps {
  tone?: 'info' | 'warning' | 'error' | 'success'
  title?: string
  children?: ReactNode
  actionLabel?: string
  onAction?: () => void
  style?: StyleProp<ViewStyle>
}

/** 页内横幅：信息 / 提醒 / 错误，可带一个动作（“重连”“去设置”）。 */
export function InlineBanner({ tone = 'info', title, children, actionLabel, onAction, style }: InlineBannerProps) {
  const theme = useTheme()
  const styles = useThemedStyles(createBannerStyles)
  const palette =
    tone === 'error'
      ? { bg: theme.colors.dangerSoft, line: theme.colors.danger, glyph: '!' }
      : tone === 'warning'
        ? { bg: theme.colors.warningSoft, line: theme.colors.warning, glyph: '!' }
        : tone === 'success'
          ? { bg: theme.colors.successSoft, line: theme.colors.success, glyph: '✓' }
          : { bg: theme.colors.infoSoft, line: theme.colors.info, glyph: 'i' }
  return (
    <View style={[styles.banner, { backgroundColor: palette.bg, borderColor: palette.line }, style]}>
      <View style={[styles.bannerGlyph, { backgroundColor: palette.line }]}>
        <Text style={styles.bannerGlyphText}>{palette.glyph}</Text>
      </View>
      <View style={styles.bannerBody}>
        {title ? <Text style={styles.bannerTitle}>{title}</Text> : null}
        {/*
          正文永远包在 <Text> 里：调用方常传数组（`{error.message}{hint ? … : ''}`），
          而 RN 不会渲染 View 下的裸字符串。只判 string 会让数组分支静默消失。
        */}
        {children ? <Text style={styles.bannerText}>{children}</Text> : null}
      </View>
      {actionLabel && onAction ? (
        <Pressable onPress={onAction} accessibilityRole="button" hitSlop={8} style={styles.bannerAction}>
          <Text style={[styles.bannerActionText, { color: palette.line }]}>{actionLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  )
}

/** 兼容旧名字：屏幕里原来叫 Banner。 */
export function Banner(props: InlineBannerProps) {
  return <InlineBanner {...props} />
}

export function ProgressBar({ progress, tone = 'accent' }: { progress?: number; tone?: 'accent' | 'success' | 'danger' }) {
  const theme = useTheme()
  const styles = useThemedStyles(createProgressStyles)
  const color = tone === 'success' ? theme.colors.success : tone === 'danger' ? theme.colors.danger : theme.colors.accent
  // 进度未知（大小未声明）时不画确定进度，避免百分比撒谎；用 35% 的“呼吸条”表示还在走。
  return (
    <View style={styles.track}>
      <View style={[styles.fill, { width: progress === undefined ? '35%' : `${Math.max(0, Math.min(1, progress)) * 100}%`, backgroundColor: color }]} />
    </View>
  )
}

// ---------------------------------------------------------------------------
// 分段控件
// ---------------------------------------------------------------------------

export interface SegmentOption<T extends string> {
  value: T
  label: string
}

/** 胶囊分段控件：扫码页三个页签、连接方式四选一。 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  disabled,
  style,
}: {
  options: ReadonlyArray<SegmentOption<T>>
  /** 不传表示“当前没有统一选择”（例如多台电脑连接方式不一致）。 */
  value?: T
  onChange: (value: T) => void
  disabled?: boolean
  style?: StyleProp<ViewStyle>
}) {
  const styles = useThemedStyles(createSegmentedStyles)
  return (
    <View style={[styles.track, style]}>
      {options.map(option => {
        const active = option.value === value
        return (
          <Pressable
            key={option.value}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            disabled={disabled}
            onPress={() => onChange(option.value)}
            style={({ pressed }) => [styles.segment, active && styles.segmentActive, pressed && !active && styles.segmentPressed]}
          >
            <Text style={[styles.segmentLabel, active && styles.segmentLabelActive]} numberOfLines={1}>
              {option.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

// ---------------------------------------------------------------------------
// ActionSheet（长按菜单）
// ---------------------------------------------------------------------------

export interface ActionSheetOption {
  key: string
  label: string
  description?: string
  icon?: string
  tone?: 'default' | 'danger'
  disabled?: boolean
  onPress: () => void
}

/**
 * 底部动作表：长按消息/文件时弹出。
 * 纯展示：不关心“复制还是删除”，只负责把选项铺出来；点选项先关面板再回调。
 */
export function ActionSheet({
  visible,
  title,
  subtitle,
  options,
  onClose,
}: {
  visible: boolean
  title?: string
  subtitle?: string
  options: ActionSheetOption[]
  onClose: () => void
}) {
  const theme = useTheme()
  const styles = useThemedStyles(createActionSheetStyles)
  const insets = useSafeAreaInsets()
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.root}>
        <Pressable style={[styles.backdrop, { backgroundColor: theme.colors.overlay }]} onPress={onClose} accessibilityLabel="关闭菜单" />
        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, spacing.md) + spacing.sm }]}>
          <View style={styles.grabber} />
          {title ? <Text style={styles.title}>{title}</Text> : null}
          {subtitle ? (
            <Text style={styles.subtitle} numberOfLines={2}>
              {subtitle}
            </Text>
          ) : null}
          <View style={styles.optionList}>
            {options.map(option => (
              <Pressable
                key={option.key}
                accessibilityRole="button"
                disabled={option.disabled}
                onPress={() => {
                  onClose()
                  option.onPress()
                }}
                style={({ pressed }) => [styles.option, pressed && styles.optionPressed, option.disabled && styles.optionDisabled]}
              >
                {option.icon ? (
                  <View style={[styles.optionIcon, option.tone === 'danger' && { backgroundColor: theme.colors.dangerSoft }]}>
                    <Text style={[styles.optionIconText, option.tone === 'danger' && { color: theme.colors.danger }]}>{option.icon}</Text>
                  </View>
                ) : null}
                <View style={styles.optionBody}>
                  <Text style={[styles.optionLabel, option.tone === 'danger' && { color: theme.colors.danger }]}>{option.label}</Text>
                  {option.description ? (
                    <Text style={styles.optionDescription} numberOfLines={1}>
                      {option.description}
                    </Text>
                  ) : null}
                </View>
              </Pressable>
            ))}
          </View>
          <Pressable accessibilityRole="button" onPress={onClose} style={({ pressed }) => [styles.cancel, pressed && styles.optionPressed]}>
            <Text style={styles.cancelLabel}>取消</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

export type ToastTone = 'default' | 'success' | 'error'

/** 轻提示：复制成功、保存成功之类，2.2 秒后自动消失。 */
export function Toast({ message, tone = 'default' }: { message?: string; tone?: ToastTone }) {
  const theme = useTheme()
  const styles = useThemedStyles(createToastStyles)
  if (!message) return null
  const background = tone === 'error' ? theme.colors.danger : tone === 'success' ? theme.colors.success : theme.colors.text
  return (
    <View pointerEvents="none" style={styles.wrap}>
      <View style={[styles.toast, { backgroundColor: background }]}>
        <Text style={styles.toastText}>{message}</Text>
      </View>
    </View>
  )
}

/** 让屏幕少写几行状态管理：showToast('已复制')。 */
export function useToast(): { toast?: { message: string; tone: ToastTone }; showToast: (message: string, tone?: ToastTone) => void } {
  const [toast, setToast] = useState<{ message: string; tone: ToastTone } | undefined>()
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const showToast = useCallback((message: string, tone: ToastTone = 'default') => {
    if (timer.current) clearTimeout(timer.current)
    setToast({ message, tone })
    timer.current = setTimeout(() => setToast(undefined), 2200)
  }, [])
  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])
  return { toast, showToast }
}

// ---------------------------------------------------------------------------
// 聊天气泡内的富文本：``` 代码块 / `行内代码`
// ---------------------------------------------------------------------------

type MessageSegment = { kind: 'text'; value: string } | { kind: 'code'; value: string; language?: string }

/** 把消息文本按 ``` 围栏切成「普通文本 / 代码块」。没有闭合的围栏按普通文本处理。 */
export function splitCodeFences(text: string): MessageSegment[] {
  const segments: MessageSegment[] = []
  // 用 new RegExp 而不是字面量：围栏字符本身是反引号，字面量里会和模板字符串互相干扰。
  const fence = new RegExp('```([^\\n`]*)\\n?([\\s\\S]*?)```', 'g')
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = fence.exec(text)) !== null) {
    if (match.index > cursor) segments.push({ kind: 'text', value: text.slice(cursor, match.index) })
    segments.push({ kind: 'code', language: (match[1] ?? '').trim() || undefined, value: (match[2] ?? '').replace(/\n$/, '') })
    cursor = match.index + match[0].length
  }
  if (cursor < text.length) segments.push({ kind: 'text', value: text.slice(cursor) })
  return segments
}

/** 行内代码与普通文本的同级 <Text> 拆分（行内代码可长按复制）。 */
function InlineText({
  text,
  style,
  onCopyText,
  cursor,
}: {
  text: string
  style: StyleProp<TextStyle>
  onCopyText?: (value: string) => void
  cursor?: boolean
}) {
  const theme = useTheme()
  const styles = useThemedStyles(createCodeStyles)
  const parts: Array<{ kind: 'text' | 'inline'; value: string }> = []
  const inline = new RegExp('`([^`\\n]+)`', 'g')
  // 注意别和 props.cursor（流式光标开关）重名：这里的是正则扫描位置。
  let position = 0
  let match: RegExpExecArray | null
  while ((match = inline.exec(text)) !== null) {
    if (match.index > position) parts.push({ kind: 'text', value: text.slice(position, match.index) })
    parts.push({ kind: 'inline', value: match[1] ?? '' })
    position = match.index + match[0].length
  }
  if (position < text.length) parts.push({ kind: 'text', value: text.slice(position) })
  if (parts.length === 0) parts.push({ kind: 'text', value: text })
  return (
    <Text style={style}>
      {parts.map((part, index) =>
        part.kind === 'inline' ? (
          <Text
            key={`inline-${index}`}
            onLongPress={onCopyText ? () => onCopyText(part.value) : undefined}
            style={[styles.inlineCode, { color: theme.colors.accent }]}
          >
            {part.value}
          </Text>
        ) : (
          <Text key={`text-${index}`}>{part.value}</Text>
        ),
      )}
      {cursor ? <Text style={[styles.cursor, { color: theme.colors.accent }]}>▍</Text> : null}
    </Text>
  )
}

/** 代码块：浅色/深色都用“凹进去”的代码面板，右上角可复制。 */
export function CodeBlock({ code, language, onCopy }: { code: string; language?: string; onCopy?: (code: string) => void }) {
  const styles = useThemedStyles(createCodeStyles)
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="代码块，长按复制"
      disabled={!onCopy}
      onLongPress={onCopy ? () => onCopy(code) : undefined}
      style={styles.codeBlock}
    >
      <View style={styles.codeHeader}>
        <Text style={styles.codeLang}>{language ? language.toUpperCase() : '代码'}</Text>
        {onCopy ? (
          <Pressable onPress={() => onCopy(code)} hitSlop={10} accessibilityRole="button" accessibilityLabel="复制代码">
            <Text style={styles.codeCopy}>复制</Text>
          </Pressable>
        ) : null}
      </View>
      <Text style={styles.codeText} selectable>
        {code}
      </Text>
    </Pressable>
  )
}

/**
 * 消息正文渲染：代码块独立成卡片（长按只复制代码），其余文本支持 `行内代码` 长按复制。
 * 不引入 markdown 库：AI 回复里真正需要区别对待的只有代码围栏。
 * `cursor` 为真时在正文末尾追加流式光标（回答还在写）。
 */
export function MessageText({
  text,
  style,
  onCopyText,
  cursor,
}: {
  text: string
  style?: StyleProp<TextStyle>
  onCopyText?: (value: string) => void
  cursor?: boolean
}) {
  const segments = splitCodeFences(text)
  if (segments.length === 1 && segments[0]!.kind === 'text') {
    return <InlineText text={segments[0]!.value} style={style} onCopyText={onCopyText} cursor={cursor} />
  }
  return (
    <View style={stylesWrapForMessageText}>
      {segments.map((segment, index) =>
        segment.kind === 'code' ? (
          <CodeBlock key={`code-${index}`} code={segment.value} language={segment.language} onCopy={onCopyText} />
        ) : segment.value.trim() ? (
          <InlineText
            key={`text-${index}`}
            text={segment.value}
            style={style}
            onCopyText={onCopyText}
            cursor={cursor && index === segments.length - 1}
          />
        ) : null,
      )}
    </View>
  )
}

// MessageText 的多段布局只需要一个“无样式容器”，避免再开一个样式工厂。
const stylesWrapForMessageText: ViewStyle = { flexDirection: 'column', gap: spacing.sm }

/** 流式输出光标：一闪一闪的方块（回答还在写）。 */
export function StreamingCursor() {
  const theme = useTheme()
  const opacity = useRef(new Animated.Value(1)).current
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.15, duration: 520, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 520, useNativeDriver: true }),
      ]),
    )
    loop.start()
    return () => loop.stop()
  }, [opacity])
  return <Animated.Text style={{ color: theme.colors.accent, fontSize: font.body, lineHeight: 23, opacity }}>▍</Animated.Text>
}

/** “正在输入…”行：三点动画点 + 文案。 */
export function TypingIndicator({ label = '正在输入…' }: { label?: string }) {
  const theme = useTheme()
  const styles = useThemedStyles(createTypingStyles)
  const dots = [useRef(new Animated.Value(0.3)).current, useRef(new Animated.Value(0.3)).current, useRef(new Animated.Value(0.3)).current]
  useEffect(() => {
    const animations = dots.map((dot, index) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(index * 140),
          Animated.timing(dot, { toValue: 1, duration: 320, useNativeDriver: true }),
          Animated.timing(dot, { toValue: 0.3, duration: 320, useNativeDriver: true }),
          Animated.delay((2 - index) * 140),
        ]),
      ),
    )
    animations.forEach(animation => animation.start())
    return () => animations.forEach(animation => animation.stop())
    // dots 是稳定引用（useRef），只需要挂载时启动一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <View style={styles.typingRow}>
      <View style={styles.typingBubble}>
        {dots.map((dot, index) => (
          <Animated.View key={index} style={[styles.typingDot, { backgroundColor: theme.colors.textMuted, opacity: dot }]} />
        ))}
      </View>
      <Text style={styles.typingLabel}>{label}</Text>
    </View>
  )
}

// ---------------------------------------------------------------------------
// 样式工厂（按主题缓存）
// ---------------------------------------------------------------------------

const createCardStyles = (theme: Theme) =>
  StyleSheet.create({
    card: {
      backgroundColor: theme.colors.surface,
      borderRadius: radius.lg,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
      padding: spacing.lg,
      ...theme.shadow.card,
    },
    sectionCard: { paddingVertical: spacing.sm, paddingHorizontal: spacing.lg, marginBottom: spacing.md },
    sectionHeader: { paddingTop: spacing.sm, paddingBottom: spacing.sm },
    sectionTitle: { color: theme.colors.text, fontSize: font.body, fontWeight: '600' },
    sectionSubtitle: { color: theme.colors.textMuted, fontSize: font.small, marginTop: 2, lineHeight: 18 },
    sectionFooter: { paddingTop: spacing.sm, paddingBottom: spacing.sm },
    divider: { height: StyleSheet.hairlineWidth, backgroundColor: theme.colors.border, marginVertical: spacing.sm },
  })

const createTextStyles = (theme: Theme) =>
  StyleSheet.create({
    sectionLabel: {
      color: theme.colors.textMuted,
      fontSize: font.tiny,
      fontWeight: '600',
      letterSpacing: 1.2,
      textTransform: 'uppercase',
      marginBottom: spacing.sm,
      marginTop: spacing.md,
      marginLeft: spacing.xs,
    },
    muted: { color: theme.colors.textMuted, fontSize: font.small, lineHeight: 19 },
    kvRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', paddingVertical: 6, gap: spacing.md },
    kvLabel: { color: theme.colors.textMuted, fontSize: font.small, flexShrink: 0 },
    kvValue: { color: theme.colors.text, fontSize: font.small, flexShrink: 1, textAlign: 'right' },
  })

const createButtonStyles = (theme: Theme) =>
  StyleSheet.create({
    button: { minHeight: 48, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.lg },
    primary: { backgroundColor: theme.colors.accent },
    primaryDanger: { backgroundColor: theme.colors.danger },
    primaryText: { color: '#FFFFFF', fontSize: font.body, fontWeight: '600' },
    secondary: {
      backgroundColor: theme.colors.surfaceAlt,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
    },
    secondaryDanger: { backgroundColor: theme.colors.dangerSoft, borderColor: theme.colors.danger },
    secondaryText: { color: theme.colors.text, fontSize: font.body, fontWeight: '500' },
    secondaryDangerText: { color: theme.colors.danger, fontWeight: '600' },
    disabled: { opacity: 0.45 },
    pressed: { opacity: 0.82 },
    iconButton: { alignItems: 'center', justifyContent: 'center' },
    iconGlyph: { textAlign: 'center', includeFontPadding: false },
  })

const createListRowStyles = (theme: Theme) =>
  StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingVertical: spacing.md,
      minHeight: 48,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.border,
    },
    rowPressed: { opacity: 0.7 },
    leading: { alignItems: 'center', justifyContent: 'center' },
    body: { flex: 1 },
    title: { color: theme.colors.text, fontSize: font.body, fontWeight: '500' },
    subtitle: { color: theme.colors.textMuted, fontSize: font.small, marginTop: 2, lineHeight: 18 },
    chevron: { color: theme.colors.textFaint, fontSize: 22, marginLeft: spacing.sm },
  })

const createPillStyles = (_theme: Theme) =>
  StyleSheet.create({
    pill: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.sm + 2, paddingVertical: 5, borderRadius: radius.pill },
    pillDot: { width: 6, height: 6, borderRadius: 3, marginRight: 6 },
    pillLabel: { fontSize: font.tiny, fontWeight: '600' },
    chip: { paddingHorizontal: spacing.sm, paddingVertical: 3, borderRadius: radius.pill, alignSelf: 'flex-start' },
    chipLabel: { fontSize: font.tiny, fontWeight: '500' },
  })

const createAvatarStyles = (theme: Theme) =>
  StyleSheet.create({
    avatar: { alignItems: 'center', justifyContent: 'center' },
    avatarText: { color: '#FFFFFF', fontWeight: '700' },
    presence: { position: 'absolute' },
    bar: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.sm },
    barItem: { alignItems: 'center', gap: 4, maxWidth: 64 },
    barName: { color: theme.colors.textMuted, fontSize: font.tiny, maxWidth: 64 },
  })

const createEmptyStyles = (theme: Theme) =>
  StyleSheet.create({
    empty: { alignItems: 'center', paddingVertical: spacing.xxl, paddingHorizontal: spacing.lg },
    glyphRing: {
      width: 72,
      height: 72,
      borderRadius: 36,
      backgroundColor: theme.colors.accentSoft,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: spacing.lg,
    },
    glyph: { fontSize: 30, color: theme.colors.accent },
    title: { color: theme.colors.text, fontSize: font.title, fontWeight: '700', textAlign: 'center', marginBottom: spacing.sm },
    hint: { color: theme.colors.textMuted, fontSize: font.callout, textAlign: 'center', lineHeight: 22, maxWidth: 320 },
    steps: { alignSelf: 'stretch', marginTop: spacing.xl, gap: spacing.md, maxWidth: 340 },
    stepRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
    stepIndex: {
      width: 24,
      height: 24,
      borderRadius: 12,
      backgroundColor: theme.colors.surfaceAlt,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: 1,
    },
    stepIndexText: { color: theme.colors.textMuted, fontSize: font.tiny, fontWeight: '700' },
    stepText: { flex: 1, color: theme.colors.textSecondary, fontSize: font.small, lineHeight: 20 },
    emptyAction: { alignSelf: 'stretch', marginTop: spacing.xl, maxWidth: 340 },
  })

const createBannerStyles = (theme: Theme) =>
  StyleSheet.create({
    banner: {
      flexDirection: 'row',
      alignItems: 'center',
      borderRadius: radius.md,
      padding: spacing.md,
      marginBottom: spacing.md,
      borderWidth: StyleSheet.hairlineWidth,
      gap: spacing.md,
    },
    bannerGlyph: { width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
    bannerGlyphText: { color: '#FFFFFF', fontSize: font.tiny, fontWeight: '700' },
    bannerBody: { flex: 1 },
    bannerTitle: { color: theme.colors.text, fontWeight: '600', fontSize: font.small, marginBottom: 2 },
    bannerText: { color: theme.colors.textSecondary, fontSize: font.small, lineHeight: 19 },
    bannerAction: { paddingHorizontal: spacing.sm, paddingVertical: spacing.xs },
    bannerActionText: { fontSize: font.small, fontWeight: '700' },
  })

const createProgressStyles = (theme: Theme) =>
  StyleSheet.create({
    track: { height: 4, borderRadius: 2, backgroundColor: theme.colors.surfaceSunken, overflow: 'hidden', marginTop: spacing.sm },
    fill: { height: 4, borderRadius: 2 },
  })

const createSegmentedStyles = (theme: Theme) =>
  StyleSheet.create({
    track: {
      flexDirection: 'row',
      backgroundColor: theme.colors.surfaceAlt,
      borderRadius: radius.md,
      padding: 3,
      gap: 3,
    },
    segment: { flex: 1, minHeight: 38, borderRadius: radius.md - 3, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.sm },
    segmentActive: { backgroundColor: theme.colors.surface, ...theme.shadow.card },
    segmentPressed: { opacity: 0.7 },
    segmentLabel: { color: theme.colors.textMuted, fontSize: font.small, fontWeight: '500' },
    segmentLabelActive: { color: theme.colors.text, fontWeight: '700' },
  })

const createActionSheetStyles = (theme: Theme) =>
  StyleSheet.create({
    root: { flex: 1, justifyContent: 'flex-end' },
    backdrop: { ...absoluteFill },
    sheet: {
      backgroundColor: theme.colors.surface,
      borderTopLeftRadius: radius.xl,
      borderTopRightRadius: radius.xl,
      paddingTop: spacing.sm,
      paddingHorizontal: spacing.lg,
    },
    grabber: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: theme.colors.borderStrong, marginBottom: spacing.md },
    title: { color: theme.colors.text, fontSize: font.body, fontWeight: '600' },
    subtitle: { color: theme.colors.textMuted, fontSize: font.small, marginTop: 2, lineHeight: 18 },
    optionList: { marginTop: spacing.sm },
    option: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.md, borderRadius: radius.md, paddingHorizontal: spacing.sm },
    optionPressed: { backgroundColor: theme.colors.surfaceAlt },
    optionDisabled: { opacity: 0.4 },
    optionIcon: {
      width: 34,
      height: 34,
      borderRadius: 17,
      backgroundColor: theme.colors.surfaceAlt,
      alignItems: 'center',
      justifyContent: 'center',
    },
    optionIconText: { color: theme.colors.textSecondary, fontSize: 15 },
    optionBody: { flex: 1 },
    optionLabel: { color: theme.colors.text, fontSize: font.body, fontWeight: '500' },
    optionDescription: { color: theme.colors.textMuted, fontSize: font.tiny, marginTop: 2 },
    cancel: { marginTop: spacing.sm, borderRadius: radius.md, backgroundColor: theme.colors.surfaceAlt, alignItems: 'center', paddingVertical: spacing.md },
    cancelLabel: { color: theme.colors.text, fontSize: font.body, fontWeight: '600' },
  })

const createToastStyles = (_theme: Theme) =>
  StyleSheet.create({
    wrap: { position: 'absolute', left: 0, right: 0, bottom: 120, alignItems: 'center', zIndex: 30 },
    toast: { borderRadius: radius.pill, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, maxWidth: '80%' },
    toastText: { color: '#FFFFFF', fontSize: font.small, fontWeight: '500', textAlign: 'center' },
  })

const createCodeStyles = (theme: Theme) =>
  StyleSheet.create({
    codeBlock: {
      backgroundColor: theme.colors.codeBackground,
      borderRadius: radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.codeBorder,
      padding: spacing.md,
      gap: spacing.sm,
    },
    codeHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    codeLang: { color: theme.colors.textMuted, fontSize: font.tiny, fontWeight: '600', letterSpacing: 0.8 },
    codeCopy: { color: theme.colors.accent, fontSize: font.tiny, fontWeight: '600' },
    codeText: { color: theme.colors.codeText, fontFamily: font.mono, fontSize: font.small, lineHeight: 19 },
    inlineCode: { fontFamily: font.mono, fontSize: font.small },
    cursor: { fontFamily: font.mono, fontSize: font.small },
  })

const createTypingStyles = (theme: Theme) =>
  StyleSheet.create({
    typingRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.md },
    typingBubble: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      backgroundColor: theme.colors.surfaceAlt,
      borderRadius: radius.pill,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
    },
    typingDot: { width: 6, height: 6, borderRadius: 3 },
    typingLabel: { color: theme.colors.textMuted, fontSize: font.tiny },
  })
