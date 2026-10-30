// 权限请求卡片（approval/ask → 手机作答）。
//
// 放在输入栏上方而不是消息流里：这条请求有时间窗口（电脑端到点会交回桌面），
// 滚到别处就看不见了，而用户必须现在决定。
//
// 纯展示：倒计时由调用方按 store 每秒的通知重算后传进来（`remainingMs`）。

import { Pressable, StyleSheet, Text, View } from 'react-native'

import { approvalReasonText, formatApprovalCountdown, type ApprovalPrompt } from '../core/approvals.mts'
import { font, radius, spacing, useTheme, useThemedStyles, type Theme } from './theme'

export function ApprovalCard({
  prompt,
  remainingMs,
  disabled,
  onAllow,
  onReject,
}: {
  prompt: ApprovalPrompt
  /** 距电脑端把提示交回桌面的剩余毫秒；undefined 表示这条没有倒计时。 */
  remainingMs?: number
  /** 离线/电脑端不支持时禁用两个按钮（点了也发不出去）。 */
  disabled?: boolean
  onAllow: () => void
  onReject: () => void
}) {
  const theme = useTheme()
  const styles = useThemedStyles(createApprovalStyles)
  const countdown = formatApprovalCountdown(remainingMs)
  return (
    <View style={[styles.card, { backgroundColor: theme.colors.warningSoft, borderColor: theme.colors.warning }]}>
      <View style={styles.head}>
        <View style={[styles.glyph, { backgroundColor: theme.colors.warning }]}>
          <Text style={styles.glyphText}>!</Text>
        </View>
        <View style={styles.headBody}>
          <Text style={[styles.title, { color: theme.colors.text }]} numberOfLines={1}>
            {prompt.toolName} 想运行
          </Text>
          <Text style={[styles.reason, { color: theme.colors.textSecondary }]} numberOfLines={3}>
            {approvalReasonText(prompt)}
          </Text>
        </View>
        {countdown ? <Text style={[styles.countdown, { color: theme.colors.warning }]}>{countdown}</Text> : null}
      </View>
      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="拒绝"
          onPress={onReject}
          disabled={disabled}
          style={({ pressed }) => [
            styles.button,
            styles.reject,
            { borderColor: theme.colors.border, backgroundColor: theme.colors.surface },
            pressed && styles.pressed,
            disabled && styles.disabled,
          ]}
        >
          <Text style={[styles.rejectText, { color: theme.colors.text }]}>拒绝</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="允许一次"
          onPress={onAllow}
          disabled={disabled}
          style={({ pressed }) => [
            styles.button,
            { backgroundColor: theme.colors.accent },
            pressed && styles.pressed,
            disabled && styles.disabled,
          ]}
        >
          <Text style={styles.allowText}>允许一次</Text>
        </Pressable>
      </View>
      <Text style={[styles.hint, { color: theme.colors.textMuted }]}>
        「允许一次」只授权这一次工具调用，不会修改电脑的沙箱设置。
      </Text>
    </View>
  )
}

const createApprovalStyles = (theme: Theme) =>
  StyleSheet.create({
    card: {
      borderRadius: radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      padding: spacing.md,
      marginBottom: spacing.sm,
      gap: spacing.sm,
    },
    head: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
    glyph: { width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
    glyphText: { color: '#FFFFFF', fontSize: font.tiny, fontWeight: '700' },
    headBody: { flex: 1 },
    title: { fontSize: font.small, fontWeight: '700' },
    reason: { fontSize: font.tiny, lineHeight: 17, marginTop: 2 },
    countdown: { fontSize: font.small, fontWeight: '700', fontVariant: ['tabular-nums'] },
    actions: { flexDirection: 'row', gap: spacing.sm },
    button: { flex: 1, minHeight: 38, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center' },
    reject: { borderWidth: StyleSheet.hairlineWidth },
    rejectText: { fontSize: font.small, fontWeight: '600' },
    allowText: { color: '#FFFFFF', fontSize: font.small, fontWeight: '700' },
    hint: { fontSize: font.tiny, lineHeight: 15 },
    pressed: { opacity: 0.85 },
    disabled: { opacity: 0.45 },
  })
