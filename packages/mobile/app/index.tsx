// 助理列表：一台电脑一张卡片。
//
// 这里就是“一台手机绑定多台电脑”的入口：每张卡片显示在线状态、备注名、最后连接时间，
// 点进去是那台电脑的聊天。断开重连、添加新电脑都在这一屏。

import { Link, Stack, useRouter } from 'expo-router'
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native'

import { endpointLabel } from '../src/core/endpoint.mts'
import type { AssistantView } from '../src/state/app-store'
import { useAppSnapshot, useAppStore } from '../src/state/store'
import { Banner, Card, EmptyState, PrimaryButton, StatusDot } from '../src/ui/components'
import { colors, font, spacing } from '../src/ui/theme'

export default function AssistantListScreen() {
  const snapshot = useAppSnapshot()
  const store = useAppStore()
  const router = useRouter()

  const renderCard = ({ item }: { item: AssistantView }) => (
    <AssistantCard
      view={item}
      onOpen={() => router.push(`/assistant/${item.assistant.id}`)}
      // 长按直达详情：重命名备注、远程电源、解绑都在那里。
      onLongPress={() => router.push(`/assistant/${item.assistant.id}/settings`)}
    />
  )

  return (
    <View style={styles.screen}>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Link href="/settings" style={styles.headerLink}>
              设置
            </Link>
          ),
        }}
      />
      {snapshot.lastError ? <Banner tone="error">{snapshot.lastError}</Banner> : null}
      <FlatList
        data={snapshot.assistants}
        keyExtractor={view => view.assistant.id}
        renderItem={renderCard}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl
            refreshing={false}
            onRefresh={() => store.reconnectAll()}
            tintColor={colors.textMuted}
            title="重新连接…"
          />
        }
        ListEmptyComponent={
          snapshot.ready ? (
            <EmptyState
              title="有什么我可以帮你的？"
              hint={'先在电脑上打开 Open Whale 插件、显示出二维码，\n然后扫描它把电脑变成你的助理。'}
            />
          ) : (
            <EmptyState title="正在准备…" />
          )
        }
        ListFooterComponent={
          <View style={styles.footer}>
            <PrimaryButton label="扫码添加电脑" onPress={() => router.push('/scan')} />
            <Text style={styles.footHint}>一台手机可以绑定多台电脑，每台电脑就是一个独立的助理。</Text>
          </View>
        }
      />
    </View>
  )
}

function AssistantCard({ view, onOpen, onLongPress }: { view: AssistantView; onOpen: () => void; onLongPress: () => void }) {
  const { assistant, link, chat } = view
  const badge = describeBadge(view)
  return (
    <Pressable onPress={onOpen} onLongPress={onLongPress} accessibilityRole="button">
      <Card>
        <View style={styles.cardHeader}>
          <StatusDot online={link.online} connecting={link.status === 'connecting' || link.status === 'handshaking' || link.status === 'reconnecting'} />
          <Text style={styles.name} numberOfLines={1}>
            {assistant.name}
          </Text>
        </View>
        <Text style={styles.meta}>{badge}</Text>
        {link.endpoint ? <Text style={styles.meta}>线路：{endpointLabel(link.endpoint)}</Text> : null}
        {lastAssistantText(chat) ? (
          <Text style={styles.preview} numberOfLines={1}>
            {lastAssistantText(chat)}
          </Text>
        ) : null}
        {link.status === 'failed' && link.lastError ? (
          <Text style={styles.error} numberOfLines={2}>
            {link.lastError}
          </Text>
        ) : null}
      </Card>
    </Pressable>
  )
}

function describeBadge(view: AssistantView): string {
  const { link, assistant, pendingMessages, activeTransfers } = view
  const parts: string[] = []
  switch (link.status) {
    case 'online':
      parts.push('在线')
      break
    case 'connecting':
      parts.push('正在连接…')
      break
    case 'handshaking':
      parts.push('正在握手…')
      break
    case 'reconnecting':
      parts.push(`已断开，正在重连（第 ${link.attempt} 次）`)
      break
    case 'failed':
      parts.push('连接失败')
      break
    default:
      parts.push('离线')
  }
  if (activeTransfers > 0) parts.push(`${activeTransfers} 个文件传输中`)
  if (pendingMessages > 0) parts.push(`${pendingMessages} 条待发送`)
  if (assistant.lastConnectedAt) parts.push(`上次连接 ${formatTime(assistant.lastConnectedAt)}`)
  return parts.join(' · ')
}

function lastAssistantText(chat: AssistantView['chat']): string | undefined {
  for (let i = chat.messages.length - 1; i >= 0; i--) {
    const message = chat.messages[i]
    if (!message) continue
    if (message.kind === 'assistant' && message.text.trim()) return message.text.replace(/\s+/g, ' ').slice(0, 80)
    if (message.kind === 'user' && message.text.trim()) return `我：${message.text.slice(0, 60)}`
  }
  return undefined
}

function formatTime(iso: string): string {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return '未知'
  const diff = Date.now() - at
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return new Date(at).toLocaleDateString()
}

/** 列表项的样式。 */
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background, paddingHorizontal: spacing.lg },
  list: { paddingVertical: spacing.lg },
  headerLink: { color: colors.accent, fontSize: font.body, paddingHorizontal: spacing.sm },
  cardHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.xs },
  name: { color: colors.text, fontSize: font.title, fontWeight: '600', flexShrink: 1 },
  meta: { color: colors.textMuted, fontSize: font.small, marginTop: 2 },
  preview: { color: colors.text, fontSize: font.small, marginTop: spacing.sm, opacity: 0.85 },
  error: { color: colors.danger, fontSize: font.small, marginTop: spacing.sm },
  footer: { marginTop: spacing.lg, gap: spacing.sm },
  footHint: { color: colors.textMuted, fontSize: font.tiny, textAlign: 'center', lineHeight: 17 },
})
