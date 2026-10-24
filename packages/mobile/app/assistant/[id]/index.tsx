// 聊天页：个人助理风格。
//
// 组件只负责画：
//  * 用户消息 / 助理消息 / 系统提示；
//  * `chat/tool` 折成的**小活动行**（永远不是助理的正文）；
//  * 文件卡片（点击落盘并交给系统打开）；
//  * 发送中 / 失败 / 需要重发的状态。
// 所有状态变化都来自 core/reducer.mts，组件里没有业务判断。

import { Link, Stack, useLocalSearchParams } from 'expo-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'

import { describeTransfer, formatBytes, transferProgress } from '../../../src/core/files.mts'
import type { ActivityItem, ChatMessage, Transfer } from '../../../src/core/reducer.mts'
import { formatCountdown } from '../../../src/core/power.mts'
import type { PickedAttachment } from '../../../src/services/attachments'
import { describeAttachment, pickAttachment } from '../../../src/services/attachments'
import { useAppStore, useAssistantView } from '../../../src/state/store'
import { Banner, Card, EmptyState, Muted, ProgressBar, SecondaryButton } from '../../../src/ui/components'
import { colors, font, radius, spacing } from '../../../src/ui/theme'

export default function ChatScreen() {
  const params = useLocalSearchParams<{ id?: string }>()
  const assistantId = typeof params.id === 'string' ? params.id : ''
  const view = useAssistantView(assistantId)
  const store = useAppStore()
  const controller = useMemo(() => (assistantId ? store.controller(assistantId) : undefined), [assistantId, store])

  const [draft, setDraft] = useState('')
  const [attachment, setAttachment] = useState<PickedAttachment | undefined>()
  const [notice, setNotice] = useState<string | undefined>()
  const listRef = useRef<FlatList<ChatMessage>>(null)
  // 首屏消息异步从数据库读出，FlatList 又虚拟化：第一次 onContentSizeChange 只反映
  // 「已布局的那部分」，滚到的是当时的底部；长消息/图片继续撑高后就再没人滚，
  // 于是打开会话停在中途。现在改成「高度还在变就继续贴底」，直到用户自己拖动。
  const lastContentHeight = useRef(0)
  const userTookOver = useRef(false)
  // 用户往上翻历史时不该被新消息拽回底部。
  const nearBottom = useRef(true)

  const messages = view?.chat.messages ?? []
  const transfers = view?.chat.transfers ?? {}

  useEffect(() => {
    // 新消息到达就滚到底部（聊天窗口最常见的期待），但用户正在翻历史时不打断。
    if (!nearBottom.current) return
    const timer = setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 60)
    return () => clearTimeout(timer)
  }, [messages.length])

  // 进入会话时的“落到最底部”。
  //
  // 只靠 onContentSizeChange 不够：FlatList 是虚拟化的，长消息在测量完高度后
  // 内容高度就不再变化，补偿滚动也就停了，最后一条会卡在输入框后面。
  // 这里按几个时间点连跑几次（布局/字体/图片都在这段时间内陆续完成），
  // 用户在任何一个时刻拖动列表（onScrollBeginDrag 置位）就立刻停止。
  useEffect(() => {
    if (messages.length === 0) return
    const timers = [0, 60, 200, 500, 900, 1400].map(delay =>
      setTimeout(() => {
        if (userTookOver.current) return
        listRef.current?.scrollToEnd({ animated: false })
      }, delay),
    )
    return () => timers.forEach(clearTimeout)
    // 只在进入会话（消息首次可用）时跑一次；后续新消息由上面的 effect 处理。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length === 0])

  const onSend = useCallback(async () => {
    if (!controller) return
    const text = draft.trim()
    if (!text && !attachment) return
    setDraft('')
    const files = attachment ? [{ name: attachment.name, mime: attachment.mime, dataBase64: attachment.dataBase64, size: attachment.size }] : undefined
    setAttachment(undefined)
    if (view && !view.link.online) {
      setNotice('当前离线：消息已加入待发送队列，连上电脑后会自动发出。')
    } else {
      setNotice(undefined)
    }
    await controller.send({ text, files })
  }, [attachment, controller, draft, view])

  const onAttach = useCallback(async () => {
    const result = await pickAttachment()
    if (result.ok) {
      setAttachment(result.attachment)
      setNotice(undefined)
      return
    }
    if (!('cancelled' in result)) setNotice(result.message)
  }, [])

  if (!view || !controller) {
    return (
      <View style={styles.screen}>
        <Stack.Screen options={{ title: '助理' }} />
        <EmptyState title="找不到这个助理" hint="它可能已经被解绑，返回列表页重新添加。" />
      </View>
    )
  }

  const { assistant, link, power } = view
  const header = (
    <View>
      {link.status !== 'online' ? (
        <Banner
          tone={link.status === 'failed' ? 'error' : 'warning'}
          title={connectionTitle(link.status)}
          actionLabel={link.status === 'failed' ? '重连' : undefined}
          onAction={link.status === 'failed' ? () => store.reconnectNow(assistantId) : undefined}
        >
          {link.lastError ?? '正在恢复连接…'}
          {link.hint ? `\n${link.hint}` : ''}
        </Banner>
      ) : null}
      {power.phase === 'pending' ? (
        <Banner tone="warning" title={`${power.action === 'restart' ? '重启' : '关机'}倒计时 ${formatCountdown(power.remainingSeconds)}`} actionLabel="取消" onAction={() => store.requestPower(assistantId, 'cancel')}>
          电脑会在倒计时结束时{power.action === 'restart' ? '重启' : '关机'}。点“取消”可以立刻中止。
        </Banner>
      ) : null}
      {notice ? <Banner tone="info" actionLabel="知道了" onAction={() => setNotice(undefined)}>{notice}</Banner> : null}
    </View>
  )

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 96 : 0}
    >
      <Stack.Screen
        options={{
          title: assistant.name,
          headerRight: () => (
            <Link href={`/assistant/${assistantId}/settings`} style={styles.headerLink}>
              详情
            </Link>
          ),
        }}
      />
      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={message => message.id}
        onContentSizeChange={(_w, height) => {
          if (messages.length === 0) return
          if (userTookOver.current) return
          // 高度没变说明只是重复测量，不必再滚（避免和用户手势打架）。
          if (Math.abs(height - lastContentHeight.current) < 1) return
          lastContentHeight.current = height
          listRef.current?.scrollToEnd({ animated: false })
        }}
        onScrollBeginDrag={() => {
          // 用户一旦开始拖动，就交还控制权，别再把人家拽回底部。
          userTookOver.current = true
        }}
        onScroll={event => {
          const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent
          nearBottom.current = contentSize.height - contentOffset.y - layoutMeasurement.height < 80
        }}
        scrollEventThrottle={16}
        ListHeaderComponent={header}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <EmptyState
            title="有什么我可以帮你的？"
            hint="直接说话就行。需要文件的话，可以让它帮你读取电脑上的文件，或者把手机里的文件发过去。"
          />
        }
        renderItem={({ item }) => (
          <MessageRow
            message={item}
            transfers={transfers}
            onRetry={rid => void controller.retry(rid)}
            onOpenFile={fileId => void controller.openFile(fileId)}
            onCancelFile={fileId => controller.cancelFile(fileId)}
          />
        )}
        ListFooterComponent={
          view.chat.typing ? (
            <View style={styles.typingRow}>
              <ActivityIndicator size="small" color={colors.textMuted} />
              <Muted style={styles.typingText}>正在输入…</Muted>
            </View>
          ) : null
        }
      />
      <View style={styles.composer}>
        {attachment ? (
          <View style={styles.attachmentRow}>
            <Text style={styles.attachmentText} numberOfLines={1}>
              附件：{describeAttachment(attachment)}
            </Text>
            <Pressable onPress={() => setAttachment(undefined)} accessibilityRole="button">
              <Text style={styles.attachmentRemove}>移除</Text>
            </Pressable>
          </View>
        ) : null}
        <View style={styles.composerRow}>
          <SecondaryButton label="附件" onPress={() => void onAttach()} />
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder={link.online ? '和助理说点什么…' : '离线：消息会排队等连接'}
            placeholderTextColor={colors.textMuted}
            style={styles.input}
            multiline
            onSubmitEditing={() => void onSend()}
          />
          <Pressable
            onPress={() => void onSend()}
            accessibilityRole="button"
            style={({ pressed }) => [styles.sendButton, pressed && styles.sendButtonPressed]}
          >
            <Text style={styles.sendText}>发送</Text>
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
  )
}

function MessageRow({
  message,
  transfers,
  onRetry,
  onOpenFile,
  onCancelFile,
}: {
  message: ChatMessage
  transfers: Record<string, Transfer>
  onRetry: (rid: string) => void
  onOpenFile: (fileId: string) => void
  onCancelFile: (fileId: string) => void
}) {
  if (message.kind === 'system') {
    return (
      <View style={styles.systemRow}>
        <Text style={[styles.systemText, message.level === 'error' && styles.systemError]}>{message.text}</Text>
      </View>
    )
  }

  if (message.kind === 'user') {
    const failed = message.state === 'failed'
    const pending = message.state === 'pending'
    return (
      <View style={styles.userRow}>
        <View style={[styles.bubble, styles.userBubble]}>
          {message.text ? <Text style={styles.userText}>{message.text}</Text> : null}
          {(message.files ?? []).map(file => (
            <Text key={file.fileId} style={styles.attachmentText}>
              附件：{describeAttachment({ name: file.name, size: file.size })}
            </Text>
          ))}
          {failed ? (
            <Pressable onPress={() => message.rid && onRetry(message.rid)} accessibilityRole="button">
              <Text style={styles.retryText}>发送失败，点这里重试</Text>
            </Pressable>
          ) : pending ? (
            <Text style={styles.pendingText}>{message.attempts && message.attempts > 0 ? `正在重发（第 ${message.attempts} 次）…` : '发送中…'}</Text>
          ) : null}
        </View>
      </View>
    )
  }

  return (
    <View style={styles.assistantRow}>
      <View style={[styles.bubble, styles.assistantBubble]}>
        {message.text ? <Text style={styles.assistantText}>{message.text}</Text> : null}
        {!message.text && message.streaming ? <ActivityIndicator size="small" color={colors.textMuted} /> : null}
        {message.activity && message.activity.length > 0 ? (
          <View style={styles.activityBlock}>
            {message.activity.map(item => (
              <ActivityLine key={item.id} item={item} />
            ))}
          </View>
        ) : null}
        {(message.files ?? []).map(file => (
          <FileCard
            key={file.fileId}
            name={file.name}
            size={file.size}
            transfer={transfers[file.fileId]}
            onOpen={() => onOpenFile(file.fileId)}
            onCancel={() => onCancelFile(file.fileId)}
          />
        ))}
        {message.interrupted && message.streaming ? <Text style={styles.interruptedText}>连接中断，这段回答可能不完整</Text> : null}
        {message.truncated ? <Text style={styles.interruptedText}>回答过长，电脑端已截断</Text> : null}
        {message.error ? <Text style={styles.errorText}>{message.error}</Text> : null}
      </View>
    </View>
  )
}

/** 活动行：工具调用**只**出现在这里，不会混进助理的正文。 */
function ActivityLine({ item }: { item: ActivityItem }) {
  const label =
    item.phase === 'tool-start'
      ? item.summary || `正在使用 ${item.tool}…`
      : item.ok === false
        ? `${item.tool} 没有成功`
        : `${item.tool} 完成`
  return (
    <View style={styles.activityRow}>
      <Text style={styles.activityDot}>{item.phase === 'tool-start' ? '·' : '✓'}</Text>
      <Text style={styles.activityText} numberOfLines={2}>
        {label}
      </Text>
    </View>
  )
}

function FileCard({
  name,
  size,
  transfer,
  onOpen,
  onCancel,
}: {
  name: string
  size: number
  transfer?: Transfer
  onOpen: () => void
  onCancel: () => void
}) {
  const status = transfer?.status ?? 'offered'
  const progress = transfer ? transferProgress(transfer) : undefined
  const busy = status === 'downloading' || status === 'queued'
  return (
    <Pressable onPress={onOpen} accessibilityRole="button">
      <Card style={styles.fileCard}>
        <Text style={styles.fileName} numberOfLines={1}>
          {name}
        </Text>
        <Text style={styles.fileMeta}>{transfer ? describeTransfer(transfer) : `${formatBytes(size)} · 点按下载`}</Text>
        {busy ? <ProgressBar progress={progress} /> : null}
        {busy ? (
          <Pressable onPress={onCancel} accessibilityRole="button">
            <Text style={styles.fileCancel}>取消下载</Text>
          </Pressable>
        ) : null}
      </Card>
    </Pressable>
  )
}

function connectionTitle(status: string): string {
  switch (status) {
    case 'reconnecting':
      return '连接已断开，正在重连'
    case 'connecting':
      return '正在连接电脑…'
    case 'handshaking':
      return '正在和电脑握手…'
    case 'failed':
      return '连接失败'
    default:
      return '当前离线'
  }
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  list: { padding: spacing.lg, paddingBottom: spacing.sm },
  headerLink: { color: colors.accent, fontSize: font.body, paddingHorizontal: spacing.sm },
  userRow: { alignItems: 'flex-end', marginBottom: spacing.md },
  assistantRow: { alignItems: 'flex-start', marginBottom: spacing.md },
  systemRow: { alignItems: 'center', marginVertical: spacing.sm },
  systemText: { color: colors.textMuted, fontSize: font.small },
  systemError: { color: colors.danger },
  bubble: { maxWidth: '88%', borderRadius: radius.lg, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  userBubble: { backgroundColor: colors.bubbleUser, borderBottomRightRadius: radius.sm },
  assistantBubble: { backgroundColor: colors.bubbleAssistant, borderBottomLeftRadius: radius.sm, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  userText: { color: colors.text, fontSize: font.body, lineHeight: 22 },
  assistantText: { color: colors.text, fontSize: font.body, lineHeight: 23 },
  pendingText: { color: '#c9d6ff', fontSize: font.tiny, marginTop: spacing.xs },
  retryText: { color: colors.danger, fontSize: font.small, marginTop: spacing.xs, textDecorationLine: 'underline' },
  interruptedText: { color: colors.warning, fontSize: font.tiny, marginTop: spacing.xs },
  errorText: { color: colors.danger, fontSize: font.small, marginTop: spacing.xs },
  activityBlock: { marginTop: spacing.sm, gap: 2 },
  activityRow: { flexDirection: 'row', alignItems: 'flex-start' },
  activityDot: { color: colors.textMuted, fontSize: font.small, marginRight: spacing.sm, width: 12 },
  activityText: { color: colors.textMuted, fontSize: font.small, flexShrink: 1 },
  fileCard: { marginTop: spacing.sm, marginBottom: 0, padding: spacing.md, backgroundColor: colors.surfaceAlt },
  fileName: { color: colors.text, fontSize: font.small, fontWeight: '600' },
  fileMeta: { color: colors.textMuted, fontSize: font.tiny, marginTop: 2 },
  fileCancel: { color: colors.danger, fontSize: font.tiny, marginTop: spacing.sm },
  typingRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.md },
  typingText: { marginLeft: spacing.sm },
  composer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
    padding: spacing.md,
    gap: spacing.sm,
  },
  composerRow: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 140,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    color: colors.text,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    fontSize: font.body,
  },
  sendButton: { backgroundColor: colors.accent, borderRadius: radius.md, paddingHorizontal: spacing.lg, height: 44, alignItems: 'center', justifyContent: 'center' },
  sendButtonPressed: { opacity: 0.8 },
  sendText: { color: colors.accentText, fontWeight: '600' },
  attachmentRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  attachmentText: { color: colors.textMuted, fontSize: font.small, flexShrink: 1 },
  attachmentRemove: { color: colors.danger, fontSize: font.small },
})
