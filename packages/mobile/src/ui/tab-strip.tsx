// 会话标签条（v2.4.0）：聊天页标题栏下方一条常驻、可横向滚动的标签条。
//
// 只负责画：标签数据来自 store 的 `tabViews`（core/tabs.mts 的 `tabStripModel`），
// 未读/运行/审批数量都在纯逻辑里算好了。点整行 = 切换，点 × = 关闭，
// 末尾的 ＋ = 新建会话并打开成标签，「全部会话」= 打开完整会话列表。
//
// 电脑端没有 `session-tabs-v1` 时（旧插件）不显示 ＋：新建的会话不会自动出现在
// 标签条里，那会让用户以为"点一下多一个标签"，实际什么都没有。

import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'

import type { TabView } from '../core/tabs.mts'
import { font, radius, spacing, useTheme, useThemedStyles, type Theme } from './theme'

export function TabStrip({
  tabs,
  activeId,
  supported,
  online,
  onSelect,
  onClose,
  onCreate,
  onOpenAll,
}: {
  /** 标签条模型（顺序 = 打开顺序）。 */
  tabs: TabView[]
  activeId: string
  /** 电脑端是否声明 `session-tabs-v1`。 */
  supported: boolean
  online: boolean
  onSelect: (sessionId: string) => void
  onClose: (sessionId: string) => void
  onCreate: () => void
  onOpenAll: () => void
}) {
  const theme = useTheme()
  const styles = useThemedStyles(createTabStyles)
  return (
    <View style={[styles.strip, { backgroundColor: theme.colors.surface, borderBottomColor: theme.colors.border }]}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        {tabs.length === 0 ? (
          <Text style={[styles.empty, { color: theme.colors.textFaint }]}>还没有打开会话</Text>
        ) : (
          tabs.map(tab => (
            <TabChip
              key={tab.id}
              tab={tab}
              active={tab.id === activeId}
              onSelect={() => onSelect(tab.id)}
              onClose={() => onClose(tab.id)}
            />
          ))
        )}
        {supported ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="新建会话"
            onPress={onCreate}
            disabled={!online}
            hitSlop={6}
            style={({ pressed }) => [
              styles.addButton,
              { borderColor: theme.colors.border, backgroundColor: theme.colors.surfaceAlt },
              !online && styles.disabled,
              pressed && styles.pressed,
            ]}
          >
            <Text style={[styles.addGlyph, { color: theme.colors.accent }]}>＋</Text>
          </Pressable>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="全部会话"
          onPress={onOpenAll}
          hitSlop={6}
          style={({ pressed }) => [styles.allButton, pressed && styles.pressed]}
        >
          <Text style={[styles.allLabel, { color: theme.colors.accent }]}>全部会话</Text>
        </Pressable>
      </ScrollView>
    </View>
  )
}

function TabChip({ tab, active, onSelect, onClose }: { tab: TabView; active: boolean; onSelect: () => void; onClose: () => void }) {
  const theme = useTheme()
  const styles = useThemedStyles(createTabStyles)
  const running = tab.typing
  const unread = tab.unread > 99 ? '99+' : String(tab.unread)
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`会话 ${tab.title}${unread !== '0' ? `，${unread} 条未读` : ''}${tab.approvals > 0 ? '，有待处理请求' : ''}`}
      accessibilityState={{ selected: active }}
      onPress={onSelect}
      style={({ pressed }) => [
        styles.chip,
        {
          borderColor: active ? theme.colors.accent : theme.colors.border,
          backgroundColor: active ? theme.colors.accentSoft : theme.colors.surfaceAlt,
        },
        pressed && styles.pressed,
      ]}
    >
      {running ? <View style={[styles.dot, { backgroundColor: theme.colors.accent }]} /> : null}
      {!running && tab.live ? <View style={[styles.dot, { backgroundColor: theme.colors.success }]} /> : null}
      <Text
        style={[styles.title, { color: active ? theme.colors.accent : theme.colors.textSecondary }]}
        numberOfLines={1}
      >
        {tab.title}
      </Text>
      {tab.approvals > 0 ? (
        <View style={[styles.approvalBadge, { backgroundColor: theme.colors.warning }]}>
          <Text style={styles.approvalGlyph}>!</Text>
        </View>
      ) : null}
      {tab.unread > 0 ? (
        <View style={[styles.unreadBadge, { backgroundColor: theme.colors.accent }]}>
          <Text style={styles.unreadText}>{unread}</Text>
        </View>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`关闭 ${tab.title}`}
        onPress={onClose}
        hitSlop={8}
        style={({ pressed }) => [styles.close, pressed && styles.pressed]}
      >
        <Text style={[styles.closeGlyph, { color: active ? theme.colors.accent : theme.colors.textMuted }]}>×</Text>
      </Pressable>
    </Pressable>
  )
}

const createTabStyles = (theme: Theme) =>
  StyleSheet.create({
    strip: { borderBottomWidth: StyleSheet.hairlineWidth },
    content: { alignItems: 'center', gap: spacing.xs, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
    empty: { fontSize: font.tiny, paddingHorizontal: spacing.xs },
    chip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      maxWidth: 190,
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth,
      paddingLeft: spacing.sm + 2,
      paddingRight: spacing.xs,
      paddingVertical: 5,
    },
    dot: { width: 7, height: 7, borderRadius: 4 },
    title: { fontSize: font.tiny, fontWeight: '600', flexShrink: 1, maxWidth: 108 },
    approvalBadge: { minWidth: 15, height: 15, borderRadius: 8, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 3 },
    approvalGlyph: { color: '#FFFFFF', fontSize: font.tiny - 2, fontWeight: '700' },
    unreadBadge: { minWidth: 16, height: 16, borderRadius: 8, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
    unreadText: { color: theme.colors.accentText, fontSize: font.tiny - 2, fontWeight: '700' },
    close: { width: 18, height: 18, alignItems: 'center', justifyContent: 'center' },
    closeGlyph: { fontSize: 15, lineHeight: 17, fontWeight: '600' },
    addButton: {
      width: 26,
      height: 26,
      borderRadius: 13,
      borderWidth: StyleSheet.hairlineWidth,
      alignItems: 'center',
      justifyContent: 'center',
    },
    addGlyph: { fontSize: 15, fontWeight: '700', lineHeight: 18 },
    allButton: { paddingHorizontal: spacing.sm, paddingVertical: 4 },
    allLabel: { fontSize: font.tiny, fontWeight: '600' },
    pressed: { opacity: 0.8 },
    disabled: { opacity: 0.4 },
  })
