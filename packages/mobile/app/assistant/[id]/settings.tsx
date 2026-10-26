// 助理详情：连接方式、协作、备注名、远程电源、唤醒引导、诊断信息、解绑。
//
// 这一屏回答“这台电脑怎么连、连得好不好、谁在跟我一起用”：
//  * 连接方式四选一（自动 / 局域网 / Tailscale / 公网隧道），切换后立即重连；
//  * 手动地址兜底：先做 health 预检，确认能通再保存；
//  * 协作模式开关 + 参与者列表 + 我的昵称；
//  * 远程电源的“二次确认 + 倒计时 + 取消”；
//  * “远程开机”只做唤醒入口与引导（关机后手机连不上它，协议里也没有 WOL 帧）。

import { Stack, useLocalSearchParams, useRouter } from 'expo-router'
import { useEffect, useState } from 'react'
import { Alert, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'

import { connectionModeNotice, endpointKindLabel } from '../../../src/core/endpoint.mts'
import { cancelCopy, confirmCopy, formatCountdown, refusalMessage } from '../../../src/core/power.mts'
import { wakeGuidance } from '../../../src/core/wake.mts'
import { DEFAULT_PORT, PROTOCOL_VERSION } from '../../../src/protocol/runtime'
import type { AssistantView } from '../../../src/state/app-store'
import { useAppStore, useAssistantView } from '../../../src/state/store'
import {
  Avatar,
  Chip,
  Divider,
  InlineBanner,
  KeyValue,
  Muted,
  PrimaryButton,
  SecondaryButton,
  SectionCard,
  SectionTitle,
  SegmentedControl,
  StatusPill,
  SwitchRow,
  Toast,
  useToast,
} from '../../../src/ui/components'
import { font, radius, spacing, useTheme, useThemedStyles, type Theme } from '../../../src/ui/theme'

type ConnectionMode = AssistantView['connectionMode']
type ProbeResult = Awaited<ReturnType<ReturnType<typeof useAppStore>['probeAddress']>>

const MODE_OPTIONS: ReadonlyArray<{ value: ConnectionMode; label: string }> = [
  { value: 'auto', label: '自动' },
  { value: 'lan', label: '局域网' },
  { value: 'tailscale', label: 'Tailscale' },
  { value: 'tunnel', label: '隧道' },
]

type Notice = { tone: 'info' | 'warning' | 'error' | 'success'; title?: string; text: string }

export default function AssistantSettingsScreen() {
  const params = useLocalSearchParams<{ id?: string }>()
  const assistantId = typeof params.id === 'string' ? params.id : ''
  const view = useAssistantView(assistantId)
  const store = useAppStore()
  const router = useRouter()
  const theme = useTheme()
  const styles = useThemedStyles(createSettingsStyles)
  const { toast, showToast } = useToast()

  const [name, setName] = useState(view?.assistant.name ?? '')
  const [nickname, setNickname] = useState('')
  const [wakeUrl, setWakeUrl] = useState(view?.assistant.wakeProxyUrl ?? '')
  const [wakeMac, setWakeMac] = useState(view?.assistant.wakeMac ?? '')
  const [notice, setNotice] = useState<Notice | undefined>()
  const [collabBusy, setCollabBusy] = useState(false)

  const [manualAddress, setManualAddress] = useState('')
  const [probing, setProbing] = useState(false)
  const [probe, setProbe] = useState<ProbeResult | undefined>()
  const [connectingManual, setConnectingManual] = useState(false)

  useEffect(() => {
    void store.getMyNickname().then(setNickname)
  }, [store])

  useEffect(() => {
    if (view && !name) setName(view.assistant.name)
  }, [name, view])

  if (!view) {
    return (
      <View style={styles.screen}>
        <Stack.Screen options={{ title: '助理设置' }} />
        <Muted style={styles.missing}>找不到这个助理，它可能已经被解绑。</Muted>
      </View>
    )
  }

  const { assistant, link, power, participants, collaboration } = view
  const allowed = assistant.powerAllowed
  const connectionMode = view.connectionMode ?? assistant.connectionMode ?? 'auto'
  const onlineCount = participants.filter(person => person.online).length

  const saveName = async () => {
    await store.rename(assistantId, name)
    showToast('备注名已保存', 'success')
  }

  const saveNickname = async () => {
    await store.setMyNickname(assistantId, nickname)
    showToast(nickname.trim() ? '昵称已保存' : '昵称已清空', 'success')
  }

  const changeMode = async (mode: ConnectionMode) => {
    await store.setConnectionMode(assistantId, mode)
    setNotice({ tone: 'info', text: connectionModeNotice(mode, assistant.endpoints) })
  }

  const toggleCollaboration = async (value: boolean) => {
    setCollabBusy(true)
    try {
      const result = await store.setCollaboration(assistantId, value)
      if (!result.ok) {
        setNotice({
          tone: 'warning',
          title: '协作模式没有打开',
          text: [result.error ?? '电脑端暂不支持协作模式', result.hint].filter(Boolean).join('\n'),
        })
      }
    } catch (error) {
      setNotice({ tone: 'error', text: `切换协作模式失败：${(error as Error).message}` })
    } finally {
      setCollabBusy(false)
    }
  }

  const runProbe = async () => {
    const address = manualAddress.trim()
    if (!address) return
    setProbing(true)
    setProbe(undefined)
    try {
      setProbe(await store.probeAddress(address))
    } catch (error) {
      setNotice({ tone: 'error', text: `测试连接失败：${(error as Error).message}` })
    } finally {
      setProbing(false)
    }
  }

  const connectManual = async () => {
    const address = manualAddress.trim()
    if (!address) return
    setConnectingManual(true)
    try {
      const result = await store.connectManually(address, assistantId)
      if (result.ok) {
        showToast('已切换到这个地址', 'success')
        setManualAddress('')
      } else {
        setNotice({ tone: 'error', title: '没能连上这个地址', text: result.error ?? '连接失败' })
      }
    } catch (error) {
      setNotice({ tone: 'error', text: `连接失败：${(error as Error).message}` })
    } finally {
      setConnectingManual(false)
    }
  }

  const askPower = (action: 'shutdown' | 'restart') => {
    const copy = confirmCopy(action, 30)
    Alert.alert(copy.title, copy.message, [
      { text: '先不要', style: 'cancel' },
      { text: copy.confirm, style: 'destructive', onPress: () => runPower(action) },
    ])
  }

  const runPower = (action: 'shutdown' | 'restart' | 'cancel') => {
    const result = store.requestPower(assistantId, action)
    if (!result.sent) Alert.alert('没有发出请求', result.error ?? '请先重新连接电脑')
  }

  const doWake = async () => {
    const result = await store.wake(assistantId)
    setNotice({ tone: result.ok ? 'success' : 'warning', title: '唤醒', text: result.message })
    if (result.guidance && result.guidance.length > 0) {
      Alert.alert('还差一步', result.guidance.map((step, index) => `${index + 1}. ${step}`).join('\n'))
    }
  }

  const saveWake = async () => {
    await store.setWakeSetting(assistantId, { url: wakeUrl.trim() || undefined, mac: wakeMac.trim() || undefined })
    showToast('唤醒设置已保存', 'success')
  }

  const confirmUnbind = () => {
    Alert.alert(
      '解绑这台电脑？',
      '解绑后会删除本机保存的这台电脑的记录与聊天缓存，需要重新扫码才能再连。电脑端的绑定也要在电脑上解除。',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '解绑',
          style: 'destructive',
          onPress: () => {
            void store.remove(assistantId, true).then(({ remoteNotified }) => {
              if (remoteNotified) {
                router.replace('/')
                return
              }
              // 电脑端没收到 device/forget（通常是手机此刻没连上电脑），必须在电脑上手动解除。
              Alert.alert(
                '本机已解绑，但电脑端未解除',
                '这台手机没有连上电脑，所以解绑请求没能送达。\n\n请回到电脑的插件配对页面点「解除绑定」，再用本机重新扫码。',
                [{ text: '知道了', onPress: () => router.replace('/') }],
              )
            })
          },
        },
      ],
    )
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: assistant.name }} />

      {notice ? (
        <InlineBanner tone={notice.tone} title={notice.title} actionLabel="知道了" onAction={() => setNotice(undefined)}>
          {notice.text}
        </InlineBanner>
      ) : null}
      {power.phase === 'pending' ? (
        <InlineBanner
          tone="warning"
          title={`${power.action === 'restart' ? '重启' : '关机'}倒计时 ${formatCountdown(power.remainingSeconds)}`}
          actionLabel={cancelCopy(power.action)}
          onAction={() => runPower('cancel')}
        >
          现在取消还来得及。
        </InlineBanner>
      ) : null}
      {power.phase === 'refused' ? (
        <InlineBanner tone="error" title="电脑拒绝了这次操作">
          {power.message ?? refusalMessage(power.reason)}
        </InlineBanner>
      ) : null}
      {power.phase === 'cancelled' ? <InlineBanner tone="info">{power.message ?? '已取消'}</InlineBanner> : null}
      {power.phase === 'executed' ? <InlineBanner tone="warning">{power.message ?? '电脑已执行电源操作'}</InlineBanner> : null}

      {/* 连接 ------------------------------------------------------------- */}
      <SectionCard
        title="连接方式"
        subtitle="自动会按「上次成功 → Tailscale → 局域网 → 公网隧道」的顺序尝试；指定后只用这一类地址。切换后立刻重连。"
      >
        <View style={styles.statusRow}>
          <StatusPill label={describeStatus(link.status)} tone={statusTone(link.status)} />
          {link.endpointKind ? <Chip label={endpointKindLabel(link.endpointKind)} tone="accent" /> : null}
          {link.attempt > 0 && link.status !== 'online' ? <Chip label={`第 ${link.attempt} 次重试`} /> : null}
        </View>
        <SegmentedControl options={MODE_OPTIONS} value={connectionMode} onChange={mode => void changeMode(mode)} style={styles.modeControl} />
        <Muted style={styles.hint}>当前使用：{link.endpoint ? view.endpointLabel : '未连接'}</Muted>
        <View style={styles.buttonRow}>
          <SecondaryButton label="重新连接" onPress={() => store.reconnectNow(assistantId)} />
          <SecondaryButton label="断开" onPress={() => store.disconnect(assistantId)} />
        </View>
      </SectionCard>

      <SectionCard title="手动地址" subtitle="自动连接连不上时兜底：填电脑的 host:port（可带 http://），先测试再连接。">
        <TextInput
          value={manualAddress}
          onChangeText={setManualAddress}
          placeholder={`例如 192.168.1.9:${DEFAULT_PORT} 或 my-pc.tailnet-name.ts.net`}
          placeholderTextColor={theme.colors.textFaint}
          style={styles.input}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          returnKeyType="done"
          onSubmitEditing={() => void runProbe()}
        />
        <View style={styles.buttonRow}>
          <SecondaryButton label={probing ? '测试中…' : '测试连接'} onPress={() => void runProbe()} disabled={probing || manualAddress.trim().length === 0} />
          <PrimaryButton
            label={connectingManual ? '连接中…' : '用这个地址连接'}
            onPress={() => void connectManual()}
            loading={connectingManual}
            disabled={manualAddress.trim().length === 0}
          />
        </View>
        {probe ? (
          <View style={styles.probeBox}>
            <Text style={styles.probeTitle}>{probe.ok ? '✓ 地址可用' : '✕ 地址不可用'}</Text>
            <Text style={styles.probeLine} numberOfLines={2}>
              {probe.ok
                ? `${probe.name ? `${probe.name} · ` : ''}${probe.kind ? endpointKindLabel(probe.kind) : '未知网络'}${probe.version ? ` · 插件 ${probe.version}` : ''}\n${probe.address ?? ''}`
                : `${probe.message ?? '连不上这个地址'}${probe.hint ? `\n${probe.hint}` : ''}`}
            </Text>
          </View>
        ) : null}
        <Muted style={styles.hint}>手动地址只影响本机保存的这台电脑，不会改电脑上的设置。</Muted>
      </SectionCard>

      {/* 协作 ------------------------------------------------------------- */}
      <SectionCard title="协作模式" subtitle="打开后，同一会话里的其他人也能看到并回复；消息会带发送者昵称。">
        <SwitchRow
          label="和他人一起使用这个会话"
          description={link.online ? '切换后电脑端会广播给同一会话的所有设备。' : '连上电脑后才能切换。'}
          value={collaboration}
          onValueChange={value => void toggleCollaboration(value)}
          disabled={!link.online || collabBusy}
        />
        <Divider />
        <Text style={styles.fieldLabel}>我在对话里的昵称</Text>
        <TextInput
          value={nickname}
          onChangeText={setNickname}
          placeholder="例如“小明”，协作时消息会带这个前缀"
          placeholderTextColor={theme.colors.textFaint}
          style={styles.input}
          maxLength={24}
        />
        <SecondaryButton label="保存昵称" onPress={() => void saveNickname()} />
        <Muted style={styles.hint}>昵称保存在电脑端；留空则使用设备默认名。</Muted>

        <Divider />
        <View style={styles.participantsHead}>
          <Text style={styles.fieldLabel}>参与者</Text>
          {participants.length > 0 ? <Chip label={`${onlineCount}/${participants.length} 人在线`} tone={onlineCount > 0 ? 'success' : 'neutral'} /> : null}
        </View>
        {participants.length === 0 ? (
          <Muted style={styles.hint}>还没有参与者信息。开启协作并连上电脑后，同一会话的成员会显示在这里。</Muted>
        ) : (
          <View style={styles.participantsList}>
            {participants.map(person => (
              <View key={person.deviceId} style={styles.participantRow}>
                <Avatar name={person.name} size={34} online={person.online} isMe={person.isMe} />
                <View style={styles.participantBody}>
                  <Text style={styles.participantName} numberOfLines={1}>
                    {person.name}
                    {person.isMe ? '（我）' : ''}
                  </Text>
                  <Text style={styles.participantMeta}>{person.online ? '在线' : '离线'}</Text>
                </View>
                <StatusPill label={person.online ? '在线' : '离线'} tone={person.online ? 'online' : 'offline'} />
              </View>
            ))}
          </View>
        )}
      </SectionCard>

      {/* 备注名 ----------------------------------------------------------- */}
      <SectionCard title="备注名" subtitle="只影响这台手机上的显示，电脑端支持时会一并同步。">
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="给这台电脑起个名字（例如“书房电脑”）"
          placeholderTextColor={theme.colors.textFaint}
          style={styles.input}
          maxLength={60}
        />
        <PrimaryButton label="保存备注名" onPress={() => void saveName()} disabled={name.trim().length === 0 || name.trim() === assistant.name} />
      </SectionCard>

      {/* 远程电源 --------------------------------------------------------- */}
      <SectionTitle>远程电源</SectionTitle>
      <SectionCard subtitle="关机/重启有 30 秒缓冲，期间可以随时取消。执行后电脑会关机，手机也就连不上它了。">
        <View style={styles.buttonRow}>
          <SecondaryButton label="关机" onPress={() => askPower('shutdown')} disabled={!allowed.includes('shutdown')} tone="danger" />
          <SecondaryButton label="重启" onPress={() => askPower('restart')} disabled={!allowed.includes('restart')} tone="danger" />
        </View>
        <View style={styles.buttonRow}>
          <SecondaryButton label="取消关机 / 重启" onPress={() => runPower('cancel')} disabled={!allowed.includes('cancel') && power.phase !== 'pending'} />
        </View>
        {!allowed.includes('shutdown') ? <Muted style={styles.hint}>电脑端已禁止远程关机/重启，只允许取消。</Muted> : null}
      </SectionCard>

      {/* 唤醒 ------------------------------------------------------------- */}
      <SectionTitle>唤醒（远程开机）</SectionTitle>
      <SectionCard subtitle="电脑关机后手机连不上它，所以这里没有“假的开机按钮”。真正能开机的是局域网里的魔术包。">
        <PrimaryButton label="尝试唤醒" onPress={() => void doWake()} />
        <TextInput
          value={wakeUrl}
          onChangeText={setWakeUrl}
          placeholder="唤醒代理地址（可选）"
          placeholderTextColor={theme.colors.textFaint}
          style={styles.input}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <TextInput
          value={wakeMac}
          onChangeText={setWakeMac}
          placeholder="这台电脑的 MAC（可选）"
          placeholderTextColor={theme.colors.textFaint}
          style={styles.input}
          autoCapitalize="characters"
          autoCorrect={false}
        />
        <SecondaryButton label="保存唤醒设置" onPress={() => void saveWake()} />
        <Muted style={styles.hint}>{wakeGuidance({ mac: wakeMac })[0]}</Muted>
      </SectionCard>

      {/* 诊断 ------------------------------------------------------------- */}
      <SectionTitle>连接诊断</SectionTitle>
      <SectionCard title="这台电脑">
        <KeyValue label="状态" value={describeStatus(link.status)} />
        <KeyValue label="网络类型" value={link.endpointKind ? endpointKindLabel(link.endpointKind) : '未连接'} />
        <KeyValue label="当前地址" value={link.endpoint ?? '—'} />
        <KeyValue label="备用地址" value={`${Math.max(0, assistant.endpoints.length - 1)} 个`} />
        <KeyValue label="心跳" value={`${Math.round(link.heartbeatMs / 1000)} 秒`} />
        <KeyValue label="电脑端版本" value={assistant.serverVersion ?? '未知'} />
        <KeyValue label="协议版本" value={PROTOCOL_VERSION} />
        <KeyValue label="公钥指纹" value={assistant.fingerprint.slice(0, 24).toUpperCase()} />
        <KeyValue label="绑定时间" value={formatDate(assistant.pairedAt)} />
        {link.triedEndpoints && link.triedEndpoints.length > 0 ? (
          <KeyValue label="最近尝试" value={link.triedEndpoints.slice(0, 3).join('、')} />
        ) : null}
      </SectionCard>

      <SectionTitle>解绑</SectionTitle>
      <SectionCard subtitle="删除本机保存的这台电脑与聊天缓存。电脑端的绑定需要另行解除。">
        <SecondaryButton label="解绑这台电脑" onPress={confirmUnbind} tone="danger" />
      </SectionCard>

      <Muted style={styles.footer}>Open Whale 2.2.0 · 一台手机可以绑定多台电脑</Muted>
      <Toast message={toast?.message} tone={toast?.tone} />
    </ScrollView>
  )
}

// ---------------------------------------------------------------------------

function describeStatus(status: string): string {
  switch (status) {
    case 'online':
      return '在线'
    case 'connecting':
      return '正在连接'
    case 'handshaking':
      return '正在握手'
    case 'reconnecting':
      return '重连中'
    case 'failed':
      return '连接失败'
    default:
      return '离线'
  }
}

function statusTone(status: string): 'online' | 'offline' | 'connecting' | 'error' | 'warning' {
  switch (status) {
    case 'online':
      return 'online'
    case 'connecting':
    case 'handshaking':
      return 'connecting'
    case 'reconnecting':
      return 'warning'
    case 'failed':
      return 'error'
    default:
      return 'offline'
  }
}

function formatDate(iso: string): string {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return '未知'
  const date = new Date(at)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

const createSettingsStyles = (theme: Theme) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.colors.background },
    content: { padding: spacing.lg, paddingBottom: spacing.xxxl },
    missing: { padding: spacing.lg },
    hint: { lineHeight: 18, marginTop: spacing.sm },
    fieldLabel: { color: theme.colors.text, fontSize: font.small, fontWeight: '600', marginBottom: spacing.xs },
    statusRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap', marginBottom: spacing.sm },
    modeControl: { marginTop: spacing.sm },
    buttonRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
    input: {
      minHeight: 46,
      paddingHorizontal: spacing.md,
      color: theme.colors.text,
      backgroundColor: theme.colors.surfaceAlt,
      borderRadius: radius.sm,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
      fontSize: font.body,
      marginVertical: spacing.sm,
    },
    probeBox: { marginTop: spacing.md, padding: spacing.md, borderRadius: radius.md, backgroundColor: theme.colors.surfaceAlt },
    probeTitle: { color: theme.colors.text, fontWeight: '700', fontSize: font.small },
    probeLine: { color: theme.colors.textMuted, fontSize: font.tiny, lineHeight: 17, marginTop: 4 },
    participantsHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing.sm },
    participantsList: { gap: spacing.sm, marginTop: spacing.sm },
    participantRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.xs },
    participantBody: { flex: 1 },
    participantName: { color: theme.colors.text, fontSize: font.small, fontWeight: '600' },
    participantMeta: { color: theme.colors.textMuted, fontSize: font.tiny, marginTop: 1 },
    footer: { textAlign: 'center', marginTop: spacing.xl },
  })
