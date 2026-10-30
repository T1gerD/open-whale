// 会话选择器（底部面板）。
//
// 纯展示：列表数据、loading、错误都由聊天页从 store 取好后传进来；这里只负责把
// 标题、相对时间、live/当前 两个胶囊铺出来，并把点按回调交回去。
//
// 交互约定（对齐 v2.3.0 契约）：
//  * 离线 / 电脑端不支持 sessions-v1 时，行和「新建会话」都禁用并给一句可操作提示，
//    不做“点了没反应”的假按钮；
//  * 选中后由电脑端推 `session/selected` + `session/state`，面板可以先关掉，
//    聊天页会显示“正在打开…”并在快照到达后整页替换。

import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { relativeSessionTime, sessionSubtitle, type SessionListState, type SessionSummary } from '../core/sessions.mts'
import { Chip, PrimaryButton } from './components'
import { absoluteFill, font, radius, spacing, useTheme, useThemedStyles, type Theme } from './theme'

export function SessionPickerSheet({
  visible,
  list,
  currentId,
  disabledHint,
  loading,
  error,
  onClose,
  onRefresh,
  onSelect,
  onCreate,
}: {
  visible: boolean
  /** 电脑端最近一次给的列表（可能还没拉过）。 */
  list?: SessionListState
  /** 这台手机当前绑定的会话 id（本地记录，列表还没回来时也有值）。 */
  currentId?: string
  /** 非空表示现在不能切换（离线/电脑端太旧），整块禁用并显示这句话。 */
  disabledHint?: string
  loading?: boolean
  error?: string
  onClose: () => void
  onRefresh: () => void
  onSelect: (sessionId: string) => void
  onCreate: () => void
}) {
  const theme = useTheme()
  const styles = useThemedStyles(createSessionStyles)
  const insets = useSafeAreaInsets()
  const sessions = list?.sessions ?? []
  const disabled = Boolean(disabledHint)
  const current = currentId ?? list?.current

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.root}>
        <Pressable style={[styles.backdrop, { backgroundColor: theme.colors.overlay }]} onPress={onClose} accessibilityLabel="关闭会话列表" />
        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, spacing.md) + spacing.sm }]}>
          <View style={styles.grabber} />
          <View style={styles.header}>
            <View style={styles.headerBody}>
              <Text style={styles.title}>电脑上的会话</Text>
              <Text style={styles.subtitle}>
                {disabled ? disabledHint : '选一个继续聊，或新建一个干净的会话。'}
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="刷新会话列表"
              onPress={onRefresh}
              disabled={disabled || loading}
              hitSlop={8}
              style={({ pressed }) => [styles.refresh, pressed && styles.pressed, (disabled || loading) && styles.disabled]}
            >
              <Text style={[styles.refreshText, { color: theme.colors.accent }]}>{loading ? '刷新中…' : '刷新'}</Text>
            </Pressable>
          </View>

          {error ? (
            <View style={[styles.errorBox, { backgroundColor: theme.colors.dangerSoft }]}>
              <Text style={[styles.errorText, { color: theme.colors.danger }]}>{error}</Text>
            </View>
          ) : null}

          <ScrollView style={styles.list} contentContainerStyle={styles.listContent} showsVerticalScrollIndicator={false}>
            {sessions.length === 0 ? (
              <Text style={styles.empty}>
                {loading ? '正在读取电脑上的会话…' : '电脑上还没有会话。点下面的「新建会话」开始。'}
              </Text>
            ) : (
              sessions.map(session => (
                <SessionRow
                  key={session.id}
                  session={session}
                  current={session.id === current}
                  disabled={disabled}
                  onPress={() => onSelect(session.id)}
                />
              ))
            )}
            {list?.truncated ? <Text style={styles.truncated}>只列出了最近的会话。</Text> : null}
          </ScrollView>

          <PrimaryButton label="新建会话" onPress={onCreate} disabled={disabled} style={styles.create} />
          <Text style={styles.footnote}>
            {disabled ? '连上电脑后才能切换会话。' : '新建后这台手机会绑定到新会话，之前的会话仍留在电脑上。'}
          </Text>
        </View>
      </View>
    </Modal>
  )
}

function SessionRow({
  session,
  current,
  disabled,
  onPress,
}: {
  session: SessionSummary
  current: boolean
  disabled: boolean
  onPress: () => void
}) {
  const theme = useTheme()
  const styles = useThemedStyles(createSessionStyles)
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${session.title}${current ? '（当前会话）' : ''}`}
      accessibilityState={{ selected: current }}
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.row,
        { borderColor: current ? theme.colors.accent : theme.colors.border, backgroundColor: current ? theme.colors.accentSoft : theme.colors.surface },
        pressed && styles.pressed,
        disabled && styles.disabled,
      ]}
    >
      <View style={styles.rowBody}>
        <Text style={[styles.rowTitle, { color: theme.colors.text }]} numberOfLines={1}>
          {session.title}
        </Text>
        <Text style={[styles.rowMeta, { color: theme.colors.textMuted }]} numberOfLines={1}>
          {sessionSubtitle(session)}
        </Text>
      </View>
      <View style={styles.rowBadges}>
        {session.live ? <Chip label="运行中" tone="success" /> : null}
        {current ? <Chip label="当前" tone="accent" /> : null}
      </View>
    </Pressable>
  )
}

const createSessionStyles = (theme: Theme) =>
  StyleSheet.create({
    root: { flex: 1, justifyContent: 'flex-end' },
    backdrop: { ...absoluteFill },
    sheet: {
      backgroundColor: theme.colors.surface,
      borderTopLeftRadius: radius.xl,
      borderTopRightRadius: radius.xl,
      paddingTop: spacing.sm,
      paddingHorizontal: spacing.lg,
      maxHeight: '82%',
    },
    grabber: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: theme.colors.borderStrong, marginBottom: spacing.md },
    header: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
    headerBody: { flex: 1 },
    title: { color: theme.colors.text, fontSize: font.headline, fontWeight: '700' },
    subtitle: { color: theme.colors.textMuted, fontSize: font.small, marginTop: 2, lineHeight: 18 },
    refresh: { paddingVertical: spacing.xs, paddingHorizontal: spacing.xs },
    refreshText: { fontSize: font.small, fontWeight: '600' },
    errorBox: { borderRadius: radius.md, padding: spacing.sm, marginTop: spacing.sm },
    errorText: { fontSize: font.tiny, lineHeight: 17 },
    list: { marginTop: spacing.sm },
    listContent: { paddingVertical: spacing.xs, gap: spacing.sm },
    empty: { color: theme.colors.textMuted, fontSize: font.small, paddingVertical: spacing.lg, lineHeight: 19 },
    truncated: { color: theme.colors.textFaint, fontSize: font.tiny, paddingVertical: spacing.xs },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      borderRadius: radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.md,
    },
    rowBody: { flex: 1 },
    rowTitle: { fontSize: font.body, fontWeight: '600' },
    rowMeta: { fontSize: font.tiny, marginTop: 3 },
    rowBadges: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
    create: { marginTop: spacing.md },
    footnote: { color: theme.colors.textFaint, fontSize: font.tiny, marginTop: spacing.sm, lineHeight: 16 },
    pressed: { opacity: 0.85 },
    disabled: { opacity: 0.5 },
  })
