// 助理列表：一台电脑一张卡片。
//
// 这一屏回答三个问题：我有哪些电脑、它们现在连得怎么样、最近聊到哪了。
// 卡片上的状态胶囊可以直接点着重连；长按直达这台电脑的设置（重命名/电源/解绑）。

import { Link, Stack, useRouter } from 'expo-router'
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native'

import { endpointKindLabel } from '../src/core/endpoint.mts'
import type { AssistantView } from '../src/state/app-store'
import { useAppSnapshot, useAppStore } from '../src/state/store'
import { Avatar, Chip, EmptyState, InlineBanner, PrimaryButton, StatusPill, type StatusTone } from '../src/ui/components'
import { font, radius, spacing, useTheme, useThemedStyles, type Theme } from '../src/ui/theme'

export default function AssistantListScreen() {
  const snapshot = useAppSnapshot()
  const store = useAppStore()
  const router = useRouter()
  const theme = useTheme()
  const styles = useThemedStyles(createListStyles)

  const summary = describeSummary(snapshot.assistants)

  return (
    <View style={styles.screen}>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Link href="/settings" style={[styles.headerLink, { color: theme.colors.accent }]}>
              设置
            </Link>
          ),
        }}
      />
      {snapshot.lastError ? (
        <View style={styles.bannerWrap}>
          <InlineBanner tone="error" title="启动时出了点问题">
            {snapshot.lastError}
          </InlineBanner>
        </View>
      ) : null}
      <FlatList
        data={snapshot.assistants}
        keyExtractor={view => view.assistant.id}
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={false}
            onRefresh={() => store.reconnectAll()}
            tintColor={theme.colors.textMuted}
            colors={[theme.colors.accent]}
            title="正在重新连接…"
            titleColor={theme.colors.textMuted}
          />
        }
        ListHeaderComponent={
          snapshot.assistants.length > 0 ? (
            <View style={styles.summary}>
              <View style={styles.summaryLeft}>
                <StatusPill
                  label={summary.label}
                  tone={summary.tone}
                  onPress={summary.tone === 'online' ? undefined : () => store.reconnectAll()}
                />
                <Text style={styles.summaryHint}>{summary.hint}</Text>
              </View>
              <Pressable accessibilityRole="button" onPress={() => store.reconnectAll()} hitSlop={8}>
                <Text style={[styles.summaryAction, { color: theme.colors.accent }]}>全部重连</Text>
              </Pressable>
            </View>
          ) : null
        }
        renderItem={({ item }) => (
          <AssistantCard
            view={item}
            onOpen={() => router.push(`/assistant/${item.assistant.id}`)}
            onOpenSettings={() => router.push(`/assistant/${item.assistant.id}/settings`)}
            onReconnect={() => store.reconnectNow(item.assistant.id)}
          />
        )}
        ListEmptyComponent={
          snapshot.ready ? (
            <EmptyState
              glyph="◍"
              title="先连上一台电脑"
              hint="连上后，这台电脑就是你的个人助理：查文件、跑命令、写代码，都可以用聊天完成。"
              steps={[
                '在电脑上打开 Open Whale 插件，点「手机配对」生成二维码',
                '手机点下面「添加电脑」，扫码，或从相册选二维码截图',
                '连上后，随时回到这里找它聊天',
              ]}
              actionLabel="添加电脑"
              onAction={() => router.push('/scan')}
            />
          ) : (
            <EmptyState glyph="◌" title="正在准备…" hint="首次启动需要读取本机保存的绑定信息。" />
          )
        }
        ListFooterComponent={
          snapshot.assistants.length > 0 ? (
            <View style={styles.footer}>
              <PrimaryButton label="添加电脑" onPress={() => router.push('/scan')} />
              <Text style={styles.footHint}>
                一台手机可以绑定多台电脑，每台电脑都是一个独立的助理。长按卡片可以重命名、解绑或远程关机。
              </Text>
            </View>
          ) : null
        }
      />
    </View>
  )
}

function AssistantCard({
  view,
  onOpen,
  onOpenSettings,
  onReconnect,
}: {
  view: AssistantView
  onOpen: () => void
  onOpenSettings: () => void
  onReconnect: () => void
}) {
  const theme = useTheme()
  const styles = useThemedStyles(createListStyles)
  const { assistant, link, pendingMessages, activeTransfers, unread } = view
  const status = describeStatus(view)
  const preview = lastMessagePreview(view)
  const endpointKind = link.endpointKind ? endpointKindLabel(link.endpointKind) : undefined
  const lastAt = view.chat.messages[view.chat.messages.length - 1]?.at

  return (
    <Pressable
      onPress={onOpen}
      onLongPress={onOpenSettings}
      delayLongPress={380}
      accessibilityRole="button"
      accessibilityLabel={`${assistant.name}，${status.label}`}
      style={({ pressed }) => [styles.cardWrap, pressed && styles.pressed]}
    >
      <View style={styles.card}>
        <View style={styles.cardTop}>
          <Avatar name={assistant.name} size={46} online={link.online} />
          <View style={styles.cardTitleWrap}>
            <View style={styles.nameRow}>
              <Text style={styles.name} numberOfLines={1}>
                {assistant.name}
              </Text>
              {unread > 0 ? (
                <View style={[styles.unread, { backgroundColor: theme.colors.accent }]}>
                  <Text style={styles.unreadText}>{unread > 99 ? '99+' : unread}</Text>
                </View>
              ) : null}
            </View>
            <View style={styles.metaRow}>
              <StatusPill label={status.label} tone={status.tone} onPress={link.online ? undefined : onReconnect} />
              {endpointKind ? <Chip label={endpointKind} /> : null}
            </View>
          </View>
          {lastAt ? <Text style={styles.time}>{formatRelative(lastAt)}</Text> : null}
        </View>

        {preview ? (
          <Text style={styles.preview} numberOfLines={2}>
            {preview}
          </Text>
        ) : (
          <Text style={styles.previewEmpty}>还没有聊过。点开打个招呼吧。</Text>
        )}

        {link.status === 'failed' && link.lastError ? (
          <Text style={styles.error} numberOfLines={2}>
            {link.lastError}
          </Text>
        ) : null}

        {pendingMessages > 0 || activeTransfers > 0 ? (
          <View style={styles.badges}>
            {pendingMessages > 0 ? <Chip label={`${pendingMessages} 条待发送`} tone="warning" /> : null}
            {activeTransfers > 0 ? <Chip label={`${activeTransfers} 个文件传输中`} tone="accent" /> : null}
          </View>
        ) : null}
      </View>
    </Pressable>
  )
}

/** 顶部一句话：几台在线、有没有在重连。 */
function describeSummary(views: AssistantView[]): { label: string; tone: StatusTone; hint: string } {
  if (views.length === 0) return { label: '未绑定', tone: 'neutral', hint: '' }
  const online = views.filter(view => view.link.online).length
  const failed = views.filter(view => view.link.status === 'failed').length
  const connecting = views.length - online - failed
  if (online === views.length) {
    return { label: '全部在线', tone: 'online', hint: `${online} 台电脑都能立刻响应` }
  }
  if (failed === views.length) {
    return { label: '全部离线', tone: 'error', hint: '点胶囊或「全部重连」重新连接' }
  }
  return {
    label: `${online}/${views.length} 台在线`,
    tone: connecting > 0 ? 'connecting' : 'warning',
    hint: connecting > 0 ? '正在恢复连接…' : '离线时消息会排队，连上后自动发出',
  }
}

function describeStatus(view: AssistantView): { label: string; tone: StatusTone } {
  const { link } = view
  switch (link.status) {
    case 'online':
      return { label: '在线', tone: 'online' }
    case 'connecting':
      return { label: '连接中', tone: 'connecting' }
    case 'handshaking':
      return { label: '握手中', tone: 'connecting' }
    case 'reconnecting':
      return { label: link.attempt > 0 ? `重连中 · ${link.attempt}` : '重连中', tone: 'warning' }
    case 'failed':
      return { label: '连接失败', tone: 'error' }
    default:
      return { label: '离线', tone: 'offline' }
  }
}

/** 最近一条消息的一句话预览（用户消息带“我/昵称”前缀）。 */
function lastMessagePreview(view: AssistantView): string | undefined {
  const messages = view.chat.messages
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message) continue
    const text = message.text.replace(/\s+/g, ' ').trim()
    const file = message.files?.[0]
    if (message.kind === 'assistant') {
      if (text) return text.slice(0, 90)
      if (file) return `发来文件：${file.name}`
      continue
    }
    if (message.kind === 'user') {
      const who = message.mine === false && message.sender ? message.sender.name : '我'
      if (text) return `${who}：${text.slice(0, 80)}`
      if (file) return `${who}发来附件：${file.name}`
      continue
    }
    if (text) return text
  }
  return undefined
}

function formatRelative(at: number): string {
  const diff = Date.now() - at
  if (!Number.isFinite(diff) || diff < 0) return '刚刚'
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  const date = new Date(at)
  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  if (sameDay) return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  const yesterday = new Date(now.getTime() - 86_400_000)
  if (date.toDateString() === yesterday.toDateString()) return '昨天'
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`
}

const createListStyles = (theme: Theme) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.colors.background },
    headerLink: { fontSize: font.body, paddingHorizontal: spacing.sm, fontWeight: '500' },
    bannerWrap: { paddingHorizontal: spacing.lg, paddingTop: spacing.md },
    list: { paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.xxxl },
    summary: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: spacing.md,
      paddingHorizontal: spacing.xs,
      gap: spacing.md,
    },
    summaryLeft: { flex: 1, gap: spacing.xs },
    summaryHint: { color: theme.colors.textMuted, fontSize: font.tiny },
    summaryAction: { fontSize: font.small, fontWeight: '600' },
    cardWrap: { marginBottom: spacing.md },
    pressed: { opacity: 0.86, transform: [{ scale: 0.995 }] },
    card: {
      backgroundColor: theme.colors.surface,
      borderRadius: radius.lg,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
      padding: spacing.lg,
      ...theme.shadow.card,
    },
    cardTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    cardTitleWrap: { flex: 1, gap: 6 },
    nameRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    name: { color: theme.colors.text, fontSize: font.headline, fontWeight: '700', flexShrink: 1 },
    unread: { minWidth: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5 },
    unreadText: { color: '#FFFFFF', fontSize: font.tiny, fontWeight: '700' },
    metaRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
    time: { color: theme.colors.textFaint, fontSize: font.tiny, alignSelf: 'flex-start', marginTop: 2 },
    preview: { color: theme.colors.textSecondary, fontSize: font.small, lineHeight: 19, marginTop: spacing.md },
    previewEmpty: { color: theme.colors.textFaint, fontSize: font.small, marginTop: spacing.md },
    error: { color: theme.colors.danger, fontSize: font.tiny, marginTop: spacing.sm, lineHeight: 17 },
    badges: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.md },
    footer: { marginTop: spacing.lg, gap: spacing.md },
    footHint: { color: theme.colors.textFaint, fontSize: font.tiny, textAlign: 'center', lineHeight: 17, paddingHorizontal: spacing.xl },
  })
