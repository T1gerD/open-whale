// 聊天页：个人助理风格。
//
// 组件只负责画 + 把用户操作转给 store/controller：
//  * 用户消息 / 助理消息 / 系统提示，按“同一发送者 + 时间接近”分组；
//  * `chat/tool` 折成的**小活动行**（永远不是助理的正文）；
//  * 文件卡片（点击落盘并交给系统打开）；附件上传进度；
//  * 发送中 / 失败 / 需要重发的状态；
//  * 长按气泡弹 ActionSheet：复制、重新发送、删除；代码块长按只复制代码。
//
// 所有状态变化都来自 core/reducer.mts，组件里没有业务判断。

import * as Clipboard from 'expo-clipboard'
import { Link, Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { endpointKindLabel } from '../../../src/core/endpoint.mts'
import { describeTransfer, formatBytes, transferProgress } from '../../../src/core/files.mts'
import { formatCountdown } from '../../../src/core/power.mts'
import type { ChatMessage, Transfer } from '../../../src/core/reducer.mts'
import { pickAttachment, type PickedAttachment } from '../../../src/services/attachments'
import type { AssistantView } from '../../../src/state/app-store'
import { useAppStore, useAssistantView } from '../../../src/state/store'
import {
  ActionSheet,
  Avatar,
  AvatarBar,
  Chip,
  EmptyState,
  InlineBanner,
  MessageText,
  ProgressBar,
  StreamingCursor,
  Toast,
  TypingIndicator,
  useToast,
  type ActionSheetOption,
} from '../../../src/ui/components'
import { font, radius, spacing, useTheme, useThemedStyles, type Theme } from '../../../src/ui/theme'

export default function ChatScreen() {
  const params = useLocalSearchParams<{ id?: string }>()
  const assistantId = typeof params.id === 'string' ? params.id : ''
  const view = useAssistantView(assistantId)
  const store = useAppStore()
  const router = useRouter()
  const theme = useTheme()
  const styles = useThemedStyles(createChatStyles)
  const controller = useMemo(() => (assistantId ? store.controller(assistantId) : undefined), [assistantId, store])
  const insets = useSafeAreaInsets()
  const { toast, showToast } = useToast()

  const [draft, setDraft] = useState('')
  const [attachment, setAttachment] = useState<PickedAttachment | undefined>()
  const [notice, setNotice] = useState<string | undefined>()
  const [sheetMessage, setSheetMessage] = useState<ChatMessage | undefined>()
  const [sending, setSending] = useState(false)
  const [showJump, setShowJump] = useState(false)

  const listRef = useRef<FlatList<ChatRow> | null>(null)
  // 首屏消息异步从数据库读出、FlatList 又虚拟化：只靠 onContentSizeChange 会停在半途。
  // 这里改成“高度还在变就继续贴底”，直到用户自己拖动。
  const lastContentHeight = useRef(0)
  const userTookOver = useRef(false)
  const nearBottom = useRef(true)
  // 页面是不是在前台：只有在前台聊天时才清未读，避免在别的页面/后台把未读吞掉。
  const focused = useRef(false)

  const messages = view?.chat.messages ?? []
  const transfers = view?.chat.transfers ?? {}
  const rows = useMemo(() => buildRows(messages), [messages])
  const streaming = Boolean(view?.chat.typing?.active) || messages.some(message => message.streaming === true)

  // 进入会话就先清零；离开时只记状态（未读由收到的消息重新累计）。
  useFocusEffect(
    useCallback(() => {
      focused.current = true
      if (assistantId) store.markRead(assistantId)
      return () => {
        focused.current = false
      }
    }, [assistantId, store]),
  )
  // 前台收到新消息（助手回复 / 他人 echo）后清一次未读。
  // 用 400ms debounce：流式回复期间消息变化很密集，没必要每条都写库/重渲染；
  // 自己发的消息电脑端本来就不计未读，这里调用是幂等的（markRead 在未读为 0 时直接返回）。
  useEffect(() => {
    if (!assistantId || !focused.current) return
    const timer = setTimeout(() => {
      if (focused.current) store.markRead(assistantId)
    }, 400)
    return () => clearTimeout(timer)
  }, [assistantId, messages.length, store])

  useEffect(() => {
    if (!nearBottom.current) return
    const timer = setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 60)
    return () => clearTimeout(timer)
  }, [messages.length])

  // 进入会话时按几个时间点连跑几次贴底（布局/字体/图片陆续完成）；
  // 用户在任何时刻拖动列表就立刻停止。
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

  const copy = useCallback(
    async (value: string, label = '已复制') => {
      if (!value.trim()) {
        showToast('没有可复制的内容', 'error')
        return
      }
      try {
        await Clipboard.setStringAsync(value)
        showToast(label, 'success')
      } catch {
        showToast('复制失败，可以长按文字手动选择', 'error')
      }
    },
    [showToast],
  )

  const onSend = useCallback(async () => {
    if (!controller || sending) return
    const text = draft.trim()
    if (!text && !attachment) return
    const pending = attachment
    setSending(true)
    setDraft('')
    setAttachment(undefined)
    setNotice(view && !view.link.online ? '当前离线：消息已排队，连上电脑后会自动发出。' : undefined)
    try {
      const files = pending ? [{ name: pending.name, mime: pending.mime, size: pending.size, uri: pending.uri }] : undefined
      await controller.send({ text, files })
      nearBottom.current = true
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 50)
    } catch (error) {
      setDraft(text)
      if (pending) setAttachment(pending)
      setNotice(`发送失败：${(error as Error).message}`)
    } finally {
      setSending(false)
    }
  }, [attachment, controller, draft, sending, view])

  const onPick = useCallback(async (kind: 'file' | 'image') => {
    const result = await pickAttachment(kind)
    if (result.ok) {
      setAttachment(result.attachment)
      setNotice(undefined)
      return
    }
    if ('message' in result) setNotice(result.message)
  }, [])

  /** 失败消息里的「重新选择文件」：把原文放回输入框，重选附件，由用户确认后再发。 */
  const repickAttachment = useCallback(async (message: ChatMessage) => {
    setDraft(message.text)
    const result = await pickAttachment('file')
    if (result.ok) {
      setAttachment(result.attachment)
      setNotice('已重新选择文件：确认文字后点发送。')
      return
    }
    if ('message' in result) setNotice(result.message)
  }, [])

  const closeSheet = useCallback(() => setSheetMessage(undefined), [])

  const sheetOptions = useMemo<ActionSheetOption[]>(() => {
    if (!sheetMessage || !controller) return []
    const options: ActionSheetOption[] = []
    const text = sheetMessage.text.trim()
    if (text) {
      options.push({ key: 'copy', label: '复制', icon: '⧉', description: text.slice(0, 28), onPress: () => void copy(sheetMessage.text) })
    }
    if (sheetMessage.kind === 'user') {
      // retryable === false 表示电脑端拒绝/文件过大/本地读取失败：重发同一条没有意义，
      // 有附件时给“重新选择文件”，没有就只保留复制/删除。
      const rejected = sheetMessage.state === 'failed' && sheetMessage.retryable === false
      if (!rejected) {
        options.push({
          key: 'resend',
          label: sheetMessage.state === 'failed' ? '重新发送' : '再次发送',
          icon: '↻',
          description: sheetMessage.error ?? '用同一条消息再发一次',
          onPress: () => void controller.resend(sheetMessage.id),
        })
      } else if ((sheetMessage.files?.length ?? 0) > 0) {
        options.push({
          key: 'repick',
          label: '重新选择文件',
          icon: '📎',
          description: sheetMessage.error ?? '换一个附件再发',
          onPress: () => void repickAttachment(sheetMessage),
        })
      }
      options.push({
        key: 'delete',
        label: '删除这条消息',
        icon: '⌫',
        tone: 'danger',
        onPress: () => {
          Alert.alert('删除这条消息？', '只在本机删除，不影电脑端的会话记录。', [
            { text: '取消', style: 'cancel' },
            { text: '删除', style: 'destructive', onPress: () => void controller.remove(sheetMessage.id) },
          ])
        },
      })
    } else if (sheetMessage.kind === 'assistant' && sheetMessage.callId) {
      if (sheetMessage.error) {
        options.push({
          key: 'retry-assistant',
          label: '重新回答',
          icon: '↻',
          description: '会用同样的提问再问一次',
          onPress: () => void controller.retryAssistant(sheetMessage.callId!),
        })
      }
    }
    return options
  }, [controller, copy, repickAttachment, sheetMessage])

  const onScroll = useCallback((event: { nativeEvent: { contentOffset: { y: number }; contentSize: { height: number }; layoutMeasurement: { height: number } } }) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent
    const distance = contentSize.height - contentOffset.y - layoutMeasurement.height
    nearBottom.current = distance < 80
    setShowJump(distance > 240)
  }, [])

  if (!view || !controller) {
    return (
      <View style={styles.screen}>
        <Stack.Screen options={{ title: '助理' }} />
        <EmptyState glyph="?" title="找不到这个助理" hint="它可能已经被解绑。返回列表页重新添加。" />
      </View>
    )
  }

  const { assistant, link, power, participants, collaboration } = view
  const onlineCount = participants.filter(person => person.online).length
  const settingsHref = `/assistant/${assistantId}/settings`

  const listHeader = (
    <View style={styles.listHeader}>
      {collaboration ? (
        <View style={styles.participantsCard}>
          <View style={styles.participantsHead}>
            <Text style={styles.participantsLabel}>协作中</Text>
            <Chip label={`${onlineCount}/${participants.length} 人在线`} tone={onlineCount > 0 ? 'success' : 'neutral'} />
          </View>
          <AvatarBar people={participants} />
        </View>
      ) : null}

      {link.status !== 'online' ? (
        <>
          <InlineBanner
            tone={link.status === 'failed' ? 'error' : 'warning'}
            title={connectionTitle(link.status)}
            actionLabel={link.status === 'failed' ? '重连' : undefined}
            onAction={link.status === 'failed' ? () => store.reconnectNow(assistantId) : undefined}
          >
            {connectionDetail(view)}
          </InlineBanner>
          {link.status === 'failed' ? (
            <Pressable accessibilityRole="button" onPress={() => router.push(settingsHref)} style={styles.quickLink} hitSlop={8}>
              <Text style={[styles.quickLinkText, { color: theme.colors.accent }]}>换连接方式（局域网 / Tailscale / 隧道）或填手动地址 ›</Text>
            </Pressable>
          ) : null}
        </>
      ) : null}

      {power.phase === 'pending' ? (
        <InlineBanner
          tone="warning"
          title={`${power.action === 'restart' ? '重启' : '关机'}倒计时 ${formatCountdown(power.remainingSeconds)}`}
          actionLabel="取消"
          onAction={() => store.requestPower(assistantId, 'cancel')}
        >
          电脑会在倒计时结束时{power.action === 'restart' ? '重启' : '关机'}。点“取消”可以立刻中止。
        </InlineBanner>
      ) : null}

      {notice ? (
        <InlineBanner tone="info" actionLabel="知道了" onAction={() => setNotice(undefined)}>
          {notice}
        </InlineBanner>
      ) : null}
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
          headerTitle: () => (
            <View style={styles.headerTitleWrap}>
              <Text style={styles.headerTitle} numberOfLines={1}>
                {assistant.name}
              </Text>
              <Text style={styles.headerSubtitle} numberOfLines={1}>
                {headerSubtitle(view)}
              </Text>
            </View>
          ),
          headerRight: () => (
            <Link href={settingsHref} style={[styles.headerLink, { color: theme.colors.accent }]}>
              详情
            </Link>
          ),
        }}
      />

      <FlatList
        ref={listRef}
        style={styles.listFlex}
        data={rows}
        keyExtractor={row => row.key}
        renderItem={({ item }) =>
          item.kind === 'time' ? (
            <View style={styles.timeRow}>
              <View style={styles.timePill}>
                <Text style={styles.timeText}>{item.label}</Text>
              </View>
            </View>
          ) : (
            <MessageRow
              row={item}
              transfers={transfers}
              onLongPress={message => setSheetMessage(message)}
              onCopyText={value => void copy(value)}
              onOpenFile={fileId => void controller.openFile(fileId)}
              onCancelFile={fileId => controller.cancelFile(fileId)}
              onRetryAssistant={callId => void controller.retryAssistant(callId)}
              onRetryMessage={message => void controller.resend(message.id)}
              onRepickAttachment={message => void repickAttachment(message)}
              onRetryUpload={messageId => {
                // 上传失败时给一个明确出口：重新发送这条消息（同一条消息、同 rid）。
                const message = messages.find(candidate => candidate.id === messageId)
                if (message) void controller.resend(message.id)
              }}
            />
          )
        }
        ListHeaderComponent={listHeader}
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
        onScroll={onScroll}
        scrollEventThrottle={16}
        keyboardShouldPersistTaps="handled"
        onScrollBeginDrag={() => {
          // 用户一旦开始拖动，就交还控制权，别把人家拽回底部。
          userTookOver.current = true
        }}
        onContentSizeChange={(_width, height) => {
          if (messages.length === 0) return
          if (userTookOver.current) return
          if (Math.abs(height - lastContentHeight.current) < 1) return
          lastContentHeight.current = height
          listRef.current?.scrollToEnd({ animated: false })
        }}
        ListEmptyComponent={
          <EmptyState
            glyph="✦"
            title="有什么我可以帮你的？"
            hint="直接说话就行。需要电脑上的文件，让它帮你读；手机里的图片或文件，点输入栏左边的按钮发过去。"
          />
        }
        ListFooterComponent={
          view.chat.typing?.active ? <TypingIndicator label={`${assistant.name}正在回复…`} /> : null
        }
      />

      {showJump ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="回到最新消息"
          onPress={() => {
            nearBottom.current = true
            setShowJump(false)
            listRef.current?.scrollToEnd({ animated: true })
          }}
          style={({ pressed }) => [styles.jumpButton, { backgroundColor: theme.colors.surface, ...theme.shadow.floating }, pressed && styles.pressed]}
        >
          <Text style={[styles.jumpGlyph, { color: theme.colors.accent }]}>↓</Text>
          <Text style={styles.jumpLabel}>回到底部</Text>
        </Pressable>
      ) : null}

      <View style={[styles.composerWrap, { backgroundColor: theme.colors.composer }, { paddingBottom: Math.max(insets.bottom, spacing.sm) }]}>
        {attachment ? (
          <View style={styles.attachmentPreview}>
            <View style={[styles.attachmentGlyph, { backgroundColor: theme.colors.accentSoft }]}>
              <Text style={styles.attachmentGlyphText}>{attachment.kind === 'image' ? '🖼' : '📄'}</Text>
            </View>
            <View style={styles.attachmentMeta}>
              <Text style={styles.attachmentName} numberOfLines={1}>
                {attachment.name}
              </Text>
              <Text style={styles.attachmentSize}>{formatBytes(attachment.size)} · 将作为附件随消息发送</Text>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel="移除附件" onPress={() => setAttachment(undefined)} hitSlop={10}>
              <Text style={styles.attachmentRemove}>移除</Text>
            </Pressable>
          </View>
        ) : null}

        <View style={styles.composerRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="添加文件"
            onPress={() => void onPick('file')}
            style={({ pressed }) => [styles.composerIcon, { backgroundColor: theme.colors.surfaceAlt }, pressed && styles.pressed]}
          >
            <Text style={styles.composerIconGlyph}>📎</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="发送图片"
            onPress={() => void onPick('image')}
            style={({ pressed }) => [styles.composerIcon, { backgroundColor: theme.colors.surfaceAlt }, pressed && styles.pressed]}
          >
            <Text style={styles.composerIconGlyph}>🖼</Text>
          </Pressable>
          <View style={[styles.inputPill, { backgroundColor: theme.colors.surfaceAlt, borderColor: theme.colors.border }]}>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              placeholder={link.online ? `和${assistant.name}说句话…` : '离线：消息会排队，连上后自动发出'}
              placeholderTextColor={theme.colors.textFaint}
              style={[styles.input, { color: theme.colors.text }]}
              multiline
              maxLength={4000}
              textAlignVertical="center"
            />
          </View>
          {streaming ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="停止生成"
              onPress={() => controller.stop()}
              style={({ pressed }) => [styles.sendButton, { backgroundColor: theme.colors.dangerSoft }, pressed && styles.pressed]}
            >
              <Text style={[styles.stopGlyph, { color: theme.colors.danger }]}>■</Text>
            </Pressable>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="发送"
              onPress={() => void onSend()}
              disabled={sending || (draft.trim().length === 0 && !attachment)}
              style={({ pressed }) => [
                styles.sendButton,
                { backgroundColor: theme.colors.accent },
                (sending || (draft.trim().length === 0 && !attachment)) && styles.sendDisabled,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.sendGlyph}>↑</Text>
            </Pressable>
          )}
        </View>
      </View>

      <ActionSheet
        visible={sheetMessage !== undefined}
        title="消息操作"
        subtitle={
          sheetMessage?.state === 'failed' && sheetMessage.error
            ? sheetMessage.error
            : sheetMessage?.text
              ? sheetMessage.text.replace(/\s+/g, ' ').slice(0, 48)
              : undefined
        }
        options={sheetOptions}
        onClose={closeSheet}
      />
      <Toast message={toast?.message} tone={toast?.tone} />
    </KeyboardAvoidingView>
  )
}

// ---------------------------------------------------------------------------
// 消息行
// ---------------------------------------------------------------------------

type ChatRow =
  | { kind: 'time'; key: string; label: string }
  | {
      kind: 'message'
      key: string
      message: ChatMessage
      mine: boolean
      groupStart: boolean
      groupEnd: boolean
      showAvatar: boolean
      senderName?: string
    }

const GROUP_GAP_MS = 3 * 60_000
const SEPARATOR_GAP_MS = 10 * 60_000

function sameSender(previous: ChatMessage, current: ChatMessage): boolean {
  if (previous.kind !== current.kind) return false
  if (current.kind === 'system') return false
  const previousMine = previous.mine !== false
  const currentMine = current.mine !== false
  if (previousMine !== currentMine) return false
  const previousSender = previous.sender?.deviceId ?? ''
  const currentSender = current.sender?.deviceId ?? ''
  return previousSender === currentSender
}

function buildRows(messages: ChatMessage[]): ChatRow[] {
  const rows: ChatRow[] = []
  messages.forEach((message, index) => {
    const previous = index > 0 ? messages[index - 1] : undefined
    const next = index < messages.length - 1 ? messages[index + 1] : undefined
    const gap = previous ? message.at - previous.at : Number.POSITIVE_INFINITY
    const dateChanged = previous ? new Date(previous.at).toDateString() !== new Date(message.at).toDateString() : true
    const groupStart = !previous || !sameSender(previous, message) || gap > GROUP_GAP_MS || dateChanged
    const nextGap = next ? next.at - message.at : Number.POSITIVE_INFINITY
    const groupEnd = !next || !sameSender(message, next) || nextGap > GROUP_GAP_MS || new Date(next.at).toDateString() !== new Date(message.at).toDateString()
    if (!previous || gap > SEPARATOR_GAP_MS || dateChanged) {
      rows.push({ kind: 'time', key: `time-${message.id}`, label: formatSeparator(message.at) })
    }
    const mine = message.kind === 'user' ? message.mine !== false : false
    rows.push({
      kind: 'message',
      key: message.id,
      message,
      mine,
      groupStart,
      groupEnd,
      showAvatar: groupStart,
      senderName: message.kind === 'user' && !mine && groupStart ? message.sender?.name ?? message.speaker ?? '伙伴' : undefined,
    })
  })
  return rows
}

function formatSeparator(at: number): string {
  const date = new Date(at)
  const now = new Date()
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  if (date.toDateString() === now.toDateString()) return time
  const yesterday = new Date(now.getTime() - 86_400_000)
  if (date.toDateString() === yesterday.toDateString()) return `昨天 ${time}`
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日 ${time}`
}

function MessageRow({
  row,
  transfers,
  onLongPress,
  onCopyText,
  onOpenFile,
  onCancelFile,
  onRetryAssistant,
  onRetryUpload,
  onRetryMessage,
  onRepickAttachment,
}: {
  row: Extract<ChatRow, { kind: 'message' }>
  transfers: Record<string, Transfer>
  onLongPress: (message: ChatMessage) => void
  onCopyText: (value: string) => void
  onOpenFile: (fileId: string) => void
  onCancelFile: (fileId: string) => void
  onRetryAssistant: (callId: string) => void
  onRetryUpload: (messageId: string) => void
  onRetryMessage: (message: ChatMessage) => void
  onRepickAttachment: (message: ChatMessage) => void
}) {
  const theme = useTheme()
  const styles = useThemedStyles(createChatStyles)
  const { message, mine, groupStart, showAvatar, senderName } = row

  if (message.kind === 'system') {
    return (
      <View style={styles.systemRow}>
        <View style={[styles.timePill, styles.systemPill, message.level === 'error' && { backgroundColor: theme.colors.dangerSoft }]}>
          <Text style={[styles.timeText, message.level === 'error' && { color: theme.colors.danger }]}>{message.text}</Text>
        </View>
      </View>
    )
  }

  const failed = message.kind === 'user' && message.state === 'failed'
  const pending = message.kind === 'user' && message.state === 'pending'
  // 只有文件、没有文字/工具行的助理消息：文件卡片自己就是卡片，不再套一层气泡。
  const bare =
    message.kind === 'assistant' &&
    !message.text.trim() &&
    !(message.activity && message.activity.length > 0) &&
    (message.files?.length ?? 0) > 0 &&
    !message.streaming &&
    !failed &&
    !pending

  return (
    <View style={[styles.messageRow, mine ? styles.messageRowMine : styles.messageRowOther, !groupStart && styles.messageRowTight]}>
      {!mine ? (
        showAvatar ? (
          message.kind === 'assistant' ? (
            <View style={[styles.aiAvatar, { backgroundColor: theme.colors.accentSoft }]}>
              <Text style={[styles.aiAvatarText, { color: theme.colors.accent }]}>✦</Text>
            </View>
          ) : (
            <Avatar name={senderName ?? '伙伴'} size={30} />
          )
        ) : (
          <View style={styles.avatarSpacer} />
        )
      ) : null}

      <View style={[styles.bubbleColumn, mine ? styles.bubbleColumnMine : null]}>
        {senderName ? <Text style={styles.senderName}>{senderName}</Text> : null}
        <Pressable
          onLongPress={() => onLongPress(message)}
          delayLongPress={320}
          accessibilityRole="text"
          accessibilityHint="长按可复制或更多操作"
          style={({ pressed }) => [
            bare ? styles.bubbleBare : styles.bubble,
            !bare && (mine ? styles.bubbleMine : styles.bubbleOther),
            !bare && (mine ? styles.bubbleMineCorner : styles.bubbleOtherCorner),
            pressed && !bare && styles.pressed,
          ]}
        >
          {message.text ? (
            <MessageText
              text={message.text}
              style={mine ? styles.textMine : styles.textOther}
              onCopyText={onCopyText}
              cursor={message.streaming === true}
            />
          ) : message.kind === 'assistant' && message.streaming ? (
            <StreamingCursor />
          ) : null}

          {message.activity && message.activity.length > 0 ? <ActivityBlock items={message.activity} /> : null}

          {message.kind === 'assistant' && message.fileOffer ? <Text style={styles.fileOfferLabel}>电脑发来的文件</Text> : null}

          {(message.files ?? []).map(file =>
            message.kind === 'user' ? (
              <AttachmentChip
                key={file.fileId}
                name={file.name}
                size={file.size}
                uploadStatus={file.uploadStatus}
                uploadedBytes={file.uploadedBytes}
                onRetryUpload={() => onRetryUpload(message.id)}
              />
            ) : (
              <FileCard
                key={file.fileId}
                name={file.name}
                size={file.size}
                transfer={transfers[file.fileId]}
                onOpen={() => onOpenFile(file.fileId)}
                onCancel={() => onCancelFile(file.fileId)}
              />
            ),
          )}

          {message.interrupted && message.streaming ? <Text style={styles.warningText}>连接中断，这段回答可能不完整</Text> : null}
          {message.truncated ? <Text style={styles.warningText}>回答过长，电脑端已截断</Text> : null}
          {failed ? (
            <View style={styles.failedBox}>
              <Text style={[styles.statusText, { color: theme.colors.danger }]} numberOfLines={3}>
                {message.error ?? '发送失败'}
              </Text>
              {message.retryable === false ? (
                (message.files?.length ?? 0) > 0 ? (
                  <Pressable onPress={() => onRepickAttachment(message)} accessibilityRole="button" hitSlop={8}>
                    <Text style={[styles.inlineAction, { color: theme.colors.accent }]}>重新选择文件</Text>
                  </Pressable>
                ) : (
                  <Text style={styles.failedHint}>这条重发也不会成功：可以复制后稍后再发，或去电脑端检查设置。</Text>
                )
              ) : (
                <Pressable onPress={() => onRetryMessage(message)} accessibilityRole="button" hitSlop={8}>
                  <Text style={[styles.inlineAction, { color: theme.colors.accent }]}>重试</Text>
                </Pressable>
              )}
            </View>
          ) : pending ? (
            <Text style={styles.statusText}>
              {message.attempts && message.attempts > 0 ? `正在重发（第 ${message.attempts} 次）…` : '发送中…'}
            </Text>
          ) : null}
        </Pressable>

        {message.kind === 'assistant' && message.error ? (
          <View style={styles.errorRow}>
            <Text style={styles.errorText} numberOfLines={3}>
              {message.error}
            </Text>
            {message.callId ? (
              <Pressable accessibilityRole="button" onPress={() => onRetryAssistant(message.callId!)} hitSlop={8}>
                <Text style={[styles.inlineAction, { color: theme.colors.accent }]}>重新回答</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
        {message.kind === 'assistant' && message.durationMs && !message.streaming ? (
          <Text style={styles.duration}>用时 {(message.durationMs / 1000).toFixed(1)} 秒</Text>
        ) : null}
      </View>
    </View>
  )
}

/** 工具调用只以“小活动行”出现，不混进助理正文。最多展示最近 4 条，避免刷屏。 */
function ActivityBlock({ items }: { items: NonNullable<ChatMessage['activity']> }) {
  const theme = useTheme()
  const styles = useThemedStyles(createChatStyles)
  const shown = items.slice(-4)
  const hidden = items.length - shown.length
  return (
    <View style={[styles.activityBlock, { borderLeftColor: theme.colors.border }]}>
      {hidden > 0 ? <Text style={styles.activityMore}>…还有 {hidden} 条工具调用</Text> : null}
      {shown.map(item => {
        const running = item.phase === 'tool-start'
        const label = running ? item.summary || `正在使用 ${item.tool}…` : item.ok === false ? `${item.tool} 没有成功` : `${item.tool} 完成`
        return (
          <View key={item.id} style={styles.activityRow}>
            <Text style={[styles.activityGlyph, { color: running ? theme.colors.warning : theme.colors.success }]}>{running ? '◌' : '✓'}</Text>
            <Text style={styles.activityText} numberOfLines={1}>
              {label}
            </Text>
          </View>
        )
      })}
    </View>
  )
}

/** 用户消息里的附件回显：上传中显示进度条，失败可重发。 */
function AttachmentChip({
  name,
  size,
  uploadStatus,
  uploadedBytes,
  onRetryUpload,
}: {
  name: string
  size: number
  uploadStatus?: 'uploading' | 'done' | 'failed'
  uploadedBytes?: number
  onRetryUpload: () => void
}) {
  const theme = useTheme()
  const styles = useThemedStyles(createChatStyles)
  const progress = uploadedBytes !== undefined && size > 0 ? Math.min(1, uploadedBytes / size) : undefined
  return (
    <View style={[styles.attachmentChip, { backgroundColor: theme.colors.surfaceAlt }]}>
      <Text style={styles.attachmentChipGlyph}>📄</Text>
      <View style={styles.attachmentChipBody}>
        <Text style={styles.attachmentChipName} numberOfLines={1}>
          {name}
        </Text>
        <Text style={styles.attachmentChipMeta}>
          {formatBytes(size)}
          {uploadStatus === 'uploading' ? ` · 上传中${uploadedBytes !== undefined ? ` ${Math.round((progress ?? 0) * 100)}%` : ''}` : uploadStatus === 'failed' ? ' · 上传失败' : ''}
        </Text>
        {uploadStatus === 'uploading' ? <ProgressBar progress={progress} /> : null}
      </View>
      {uploadStatus === 'failed' ? (
        <Pressable accessibilityRole="button" onPress={onRetryUpload} hitSlop={8}>
          <Text style={[styles.inlineAction, { color: theme.colors.accent }]}>重发</Text>
        </Pressable>
      ) : null}
    </View>
  )
}

/** 助理发来的文件卡片：点按下载/打开，下载中显示进度和取消。 */
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
  const theme = useTheme()
  const styles = useThemedStyles(createChatStyles)
  const status = transfer?.status ?? 'offered'
  const progress = transfer ? transferProgress(transfer) : undefined
  const busy = status === 'downloading' || status === 'queued'
  return (
    <Pressable onPress={onOpen} accessibilityRole="button" accessibilityLabel={`文件 ${name}`}>
      <View style={[styles.fileCard, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}>
        <View style={styles.fileCardTop}>
          <View style={[styles.fileGlyph, { backgroundColor: theme.colors.accentSoft }]}>
            <Text style={styles.fileGlyphText}>📎</Text>
          </View>
          <View style={styles.fileBody}>
            <Text style={styles.fileName} numberOfLines={1}>
              {name}
            </Text>
            <Text style={styles.fileMeta}>{transfer ? describeTransfer(transfer) : `${formatBytes(size)} · 点按下载`}</Text>
          </View>
          <Text style={[styles.fileAction, { color: theme.colors.accent }]}>{busy ? '下载中' : status === 'done' ? '打开' : '下载'}</Text>
        </View>
        {busy ? <ProgressBar progress={progress} /> : null}
        {busy ? (
          <Pressable onPress={onCancel} accessibilityRole="button" hitSlop={8} style={styles.fileCancelWrap}>
            <Text style={styles.fileCancel}>取消下载</Text>
          </Pressable>
        ) : null}
      </View>
    </Pressable>
  )
}

// ---------------------------------------------------------------------------
// 文案
// ---------------------------------------------------------------------------

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

function connectionDetail(view: AssistantView): string {
  const { link } = view
  const parts: string[] = [link.lastError ?? '正在恢复连接…']
  if (link.hint) parts.push(link.hint)
  if (link.triedEndpoints && link.triedEndpoints.length > 0) {
    parts.push(`已尝试：${link.triedEndpoints.slice(0, 3).join('、')}${link.triedEndpoints.length > 3 ? ' 等' : ''}`)
  }
  parts.push('离线期间发送的消息会排队，连上后自动发出。')
  return parts.join('\n')
}

function headerSubtitle(view: AssistantView): string {
  const { link } = view
  const status = link.status === 'online' ? '在线' : link.status === 'failed' ? '连接失败' : link.status === 'reconnecting' ? `重连中 · ${link.attempt}` : '离线'
  const kind = link.endpointKind ? endpointKindLabel(link.endpointKind) : undefined
  const parts = [status]
  if (link.online && kind) parts.push(kind)
  if (view.unread > 0) parts.push(`${view.unread} 条未读`)
  return parts.join(' · ')
}

// ---------------------------------------------------------------------------
// 样式
// ---------------------------------------------------------------------------

const createChatStyles = (theme: Theme) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.colors.background },
    listFlex: { flex: 1 },
    headerTitleWrap: { alignItems: 'center', maxWidth: 210 },
    headerTitle: { color: theme.colors.text, fontSize: font.callout + 1, fontWeight: '700' },
    headerSubtitle: { color: theme.colors.textMuted, fontSize: font.tiny, marginTop: 1 },
    headerLink: { fontSize: font.body, paddingHorizontal: spacing.sm, fontWeight: '500' },
    list: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.md },
    listHeader: { paddingTop: spacing.sm },
    participantsCard: {
      backgroundColor: theme.colors.surface,
      borderRadius: radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      marginBottom: spacing.md,
    },
    participantsHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    participantsLabel: { color: theme.colors.textMuted, fontSize: font.tiny, fontWeight: '600', letterSpacing: 0.8 },
    quickLink: { alignSelf: 'flex-start', marginTop: -spacing.xs, marginBottom: spacing.md, paddingVertical: spacing.xs },
    quickLinkText: { fontSize: font.tiny, fontWeight: '600' },

    timeRow: { alignItems: 'center', marginVertical: spacing.md },
    systemPill: { maxWidth: '92%' },
    timePill: { backgroundColor: theme.colors.surfaceAlt, borderRadius: radius.pill, paddingHorizontal: spacing.md, paddingVertical: 4 },
    timeText: { color: theme.colors.textMuted, fontSize: font.tiny },

    messageRow: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm, marginBottom: spacing.md },
    messageRowMine: { justifyContent: 'flex-end' },
    messageRowOther: { justifyContent: 'flex-start' },
    messageRowTight: { marginTop: -spacing.sm },
    aiAvatar: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', marginBottom: 2 },
    aiAvatarText: { fontSize: 15 },
    avatarSpacer: { width: 30 },
    bubbleColumn: { maxWidth: '82%' },
    bubbleColumnMine: { alignItems: 'flex-end' },
    senderName: { color: theme.colors.textMuted, fontSize: font.tiny, marginBottom: 3, marginLeft: spacing.xs },
    bubble: { borderRadius: radius.lg, paddingHorizontal: spacing.md + 2, paddingVertical: spacing.sm + 1 },
    bubbleBare: { gap: spacing.xs },
    bubbleMine: { backgroundColor: theme.colors.bubbleUser },
    bubbleOther: {
      backgroundColor: theme.colors.bubbleAssistant,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.bubbleAssistantBorder,
    },
    bubbleMineCorner: { borderBottomRightRadius: radius.xs },
    bubbleOtherCorner: { borderBottomLeftRadius: radius.xs },
    textMine: { color: theme.colors.bubbleUserText, fontSize: font.body, lineHeight: 23 },
    textOther: { color: theme.colors.bubbleAssistantText, fontSize: font.body, lineHeight: 23 },
    statusText: { color: theme.colors.textMuted, fontSize: font.tiny, marginTop: spacing.xs },
    failedBox: { marginTop: spacing.xs, gap: 4 },
    failedHint: { color: theme.colors.textMuted, fontSize: font.tiny, lineHeight: 16 },
    warningText: { color: theme.colors.warning, fontSize: font.tiny, marginTop: spacing.xs },
    errorRow: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm, marginTop: spacing.xs, maxWidth: '100%' },
    errorText: { color: theme.colors.danger, fontSize: font.tiny, lineHeight: 17, flexShrink: 1 },
    inlineAction: { fontSize: font.tiny, fontWeight: '600' },
    duration: { color: theme.colors.textFaint, fontSize: font.tiny, marginTop: 3, marginLeft: spacing.xs },

    systemRow: { alignItems: 'center', marginVertical: spacing.sm },
    activityBlock: { marginTop: spacing.sm, paddingLeft: spacing.sm, borderLeftWidth: 2, gap: 3 },
    activityMore: { color: theme.colors.textFaint, fontSize: font.tiny },
    activityRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    activityGlyph: { fontSize: font.tiny, width: 12 },
    activityText: { color: theme.colors.textMuted, fontSize: font.tiny, flexShrink: 1 },

    fileOfferLabel: { color: theme.colors.textMuted, fontSize: font.tiny, fontWeight: '600', marginTop: spacing.sm },
    attachmentChip: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, borderRadius: radius.md, padding: spacing.sm, marginTop: spacing.sm },
    attachmentChipGlyph: { fontSize: 18 },
    attachmentChipBody: { flex: 1 },
    attachmentChipName: { color: theme.colors.text, fontSize: font.small, fontWeight: '600' },
    attachmentChipMeta: { color: theme.colors.textMuted, fontSize: font.tiny, marginTop: 1 },

    fileCard: { borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, padding: spacing.md, marginTop: spacing.sm, gap: spacing.xs },
    fileCardTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    fileGlyph: { width: 34, height: 34, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center' },
    fileGlyphText: { fontSize: 16 },
    fileBody: { flex: 1 },
    fileName: { color: theme.colors.text, fontSize: font.small, fontWeight: '600' },
    fileMeta: { color: theme.colors.textMuted, fontSize: font.tiny, marginTop: 1 },
    fileAction: { fontSize: font.tiny, fontWeight: '700' },
    fileCancelWrap: { alignSelf: 'flex-start' },
    fileCancel: { color: theme.colors.danger, fontSize: font.tiny },

    jumpButton: {
      position: 'absolute',
      right: spacing.lg,
      bottom: 140,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      borderRadius: radius.pill,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
    },
    jumpGlyph: { fontSize: 15, fontWeight: '700' },
    jumpLabel: { color: theme.colors.textSecondary, fontSize: font.tiny, fontWeight: '500' },

    composerWrap: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.colors.border,
      paddingHorizontal: spacing.md,
      paddingTop: spacing.sm,
      gap: spacing.sm,
      ...theme.shadow.composer,
    },
    composerRow: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm },
    composerIcon: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
    composerIconGlyph: { fontSize: 17 },
    inputPill: {
      flex: 1,
      borderRadius: radius.lg,
      borderWidth: StyleSheet.hairlineWidth,
      paddingHorizontal: spacing.md,
      justifyContent: 'center',
      minHeight: 40,
    },
    input: { fontSize: font.body, lineHeight: 21, minHeight: 40, maxHeight: 120, paddingVertical: spacing.sm - 2 },
    sendButton: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
    sendDisabled: { opacity: 0.4 },
    sendGlyph: { color: '#FFFFFF', fontSize: 20, fontWeight: '700', marginTop: -1 },
    stopGlyph: { fontSize: 14 },
    pressed: { opacity: 0.82 },

    attachmentPreview: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.xs,
      paddingBottom: spacing.xs,
    },
    attachmentGlyph: { width: 34, height: 34, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center' },
    attachmentGlyphText: { fontSize: 16 },
    attachmentMeta: { flex: 1 },
    attachmentName: { color: theme.colors.text, fontSize: font.small, fontWeight: '600' },
    attachmentSize: { color: theme.colors.textMuted, fontSize: font.tiny, marginTop: 1 },
    attachmentRemove: { color: theme.colors.danger, fontSize: font.small, fontWeight: '500' },
  })
