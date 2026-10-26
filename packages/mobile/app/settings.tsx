// 全局设置 / 外观 / 关于 / 已知限制。
//
// 结构按 v2.2.0 的分组：连接 → 协作 → 外观 → 文件 → 高级（诊断）→ 关于。
// 把限制写进 App 而不是只写在 README：用户看不到 README，而“为什么开不了机”
// “为什么隧道地址会变”这类问题是必须要提前说清楚的。

import { Stack, useRouter } from 'expo-router'
import { useEffect, useState } from 'react'
import { Alert, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'

import { DEFAULT_CONNECTION_POLICY } from '../src/core/connection-policy.mts'
import { endpointKindLabel } from '../src/core/endpoint.mts'
import { formatBytes } from '../src/core/files.mts'
import { MAX_UPLOAD_BYTES } from '../src/core/frames.mts'
import { DEFAULT_HEARTBEAT_MS, DEFAULT_PORT, PROTOCOL_VERSION } from '../src/protocol/runtime'
import { clearDownloads, downloadsLocationHint } from '../src/services/transfers'
import type { AppStore, AssistantView } from '../src/state/app-store'
import { useAppSnapshot, useAppStore } from '../src/state/store'
import {
  Avatar,
  AvatarBar,
  InlineBanner,
  KeyValue,
  ListRow,
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
} from '../src/ui/components'
import { font, radius, spacing, useTheme, useThemedStyles, type Theme } from '../src/ui/theme'

/** 发版由 Lead 统一管理：这里与 app.json/package.json 的版本号保持一致。 */
const APP_VERSION = '2.2.0'

type AppearancePref = 'system' | 'light' | 'dark'
type ConnectionMode = AssistantView['connectionMode']
type ProbeResult = Awaited<ReturnType<AppStore['probeAddress']>>

const CONNECTION_MODE_OPTIONS: ReadonlyArray<{ value: ConnectionMode; label: string }> = [
  { value: 'auto', label: '自动' },
  { value: 'lan', label: '局域网' },
  { value: 'tailscale', label: 'Tailscale' },
  { value: 'tunnel', label: '隧道' },
]

const APPEARANCE_OPTIONS: ReadonlyArray<{ value: AppearancePref; label: string }> = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
]

type Notice = { tone: 'info' | 'warning' | 'error' | 'success'; title?: string; text: string }

export default function SettingsScreen() {
  const snapshot = useAppSnapshot()
  const store = useAppStore()
  const router = useRouter()
  const theme = useTheme()
  const styles = useThemedStyles(createSettingsStyles)
  const { toast, showToast } = useToast()

  const policy = snapshot.connectionPolicy ?? DEFAULT_CONNECTION_POLICY
  const appearance: AppearancePref = snapshot.appearance ?? 'system'

  const [nickname, setNickname] = useState('')
  const [notice, setNotice] = useState<Notice | undefined>()
  const [collabBusyId, setCollabBusyId] = useState<string | undefined>()

  const [manualAddress, setManualAddress] = useState('')
  const [probing, setProbing] = useState(false)
  const [probe, setProbe] = useState<ProbeResult | undefined>()
  const [connecting, setConnecting] = useState(false)

  useEffect(() => {
    void store.getMyNickname().then(value => setNickname(prev => (prev === '' ? value : prev)))
  }, [store])

  const changeAllModes = async (mode: ConnectionMode) => {
    if (snapshot.assistants.length === 0) return
    for (const view of snapshot.assistants) {
      await store.setConnectionMode(view.assistant.id, mode)
    }
    showToast(`已把 ${snapshot.assistants.length} 台电脑切换为「${CONNECTION_MODE_OPTIONS.find(option => option.value === mode)?.label ?? mode}」`, 'success')
  }

  const saveNickname = async () => {
    await store.setMyNickname(undefined, nickname)
    showToast(nickname.trim() ? '昵称已保存（应用到所有电脑）' : '昵称已清空', 'success')
  }

  const toggleCollaboration = async (assistantId: string, value: boolean) => {
    setCollabBusyId(assistantId)
    try {
      const result = await store.setCollaboration(assistantId, value)
      if (!result.ok) {
        setNotice({ tone: 'warning', title: '协作模式没有切换', text: [result.error ?? '电脑端暂不支持协作模式', result.hint].filter(Boolean).join('\n') })
      }
    } catch (error) {
      setNotice({ tone: 'error', text: `切换协作模式失败：${(error as Error).message}` })
    } finally {
      setCollabBusyId(undefined)
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
    setConnecting(true)
    try {
      const result = await store.connectManually(address)
      if (result.ok) {
        showToast('已连上，可在聊天页里找到它', 'success')
        setManualAddress('')
        setProbe(undefined)
      } else {
        setNotice({ tone: 'error', title: '没能连上这个地址', text: [result.error ?? '连接失败', result.hint].filter(Boolean).join('\n') })
      }
    } catch (error) {
      setNotice({ tone: 'error', text: `连接失败：${(error as Error).message}` })
    } finally {
      setConnecting(false)
    }
  }

  const clearFiles = () => {
    Alert.alert('清理已下载的文件？', '聊天记录会保留，文件卡片需要重新下载。', [
      { text: '取消', style: 'cancel' },
      {
        text: '清理',
        style: 'destructive',
        onPress: () => {
          void clearDownloads().then(() => showToast('已清理下载文件', 'success'))
        },
      },
    ])
  }

  const unbindAll = () => {
    Alert.alert('解除所有绑定？', '会删除本机保存的绑定、设备密钥与聊天记录。电脑端的绑定需要在那台电脑的插件配对页面另行解除。', [
      { text: '取消', style: 'cancel' },
      {
        text: '全部解除',
        style: 'destructive',
        onPress: () => {
          void (async () => {
            let notNotified = 0
            for (const view of snapshot.assistants) {
              const { remoteNotified } = await store.remove(view.assistant.id, true)
              if (!remoteNotified) notNotified += 1
            }
            if (notNotified > 0) {
              // 未连上电脑时解绑请求发不出去，电脑端会继续保持绑定状态。
              Alert.alert(
                '本机已解绑，但有电脑未解除',
                `${notNotified} 台电脑没有收到解绑请求（当时未连接）。\n\n请在那台电脑的插件配对页面点「解除绑定」，再用本机重新扫码。`,
                [{ text: '知道了' }],
              )
            }
          })()
        },
      },
    ])
  }

  const collaborating = snapshot.assistants.filter(view => view.collaboration && view.participants.length > 0)

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: '设置' }} />

      {notice ? (
        <InlineBanner tone={notice.tone} title={notice.title} actionLabel="知道了" onAction={() => setNotice(undefined)}>
          {notice.text}
        </InlineBanner>
      ) : null}

      {/* 本机设备 --------------------------------------------------------- */}
      <SectionTitle>本机设备</SectionTitle>
      <SectionCard>
        <KeyValue label="设备名" value={snapshot.deviceName ?? '（首次绑定时生成）'} />
        <KeyValue label="设备 ID" value={snapshot.deviceId ?? '—'} />
        <Muted style={styles.hint}>
          设备私钥保存在系统密钥库（Android Keystore / iOS Keychain）里，不会上传，也不能导出。电脑端只保存它的公钥。
        </Muted>
      </SectionCard>

      {/* 连接 ------------------------------------------------------------- */}
      <SectionTitle>连接</SectionTitle>
      <SectionCard title="已绑定的电脑" subtitle="点某台电脑可以单独切换连接方式、填手动地址或重连。">
        {snapshot.assistants.length === 0 ? (
          <Muted style={styles.hint}>还没有绑定电脑。用下面的「添加电脑」开始。</Muted>
        ) : (
          snapshot.assistants.map(view => {
            const online = view.link.online
            const label = online ? '在线' : view.link.status === 'failed' ? '连接失败' : view.link.status === 'reconnecting' ? '重连中' : '离线'
            return (
              <ListRow
                key={view.assistant.id}
                title={view.assistant.name}
                subtitle={view.link.endpoint ? `${label} · ${view.endpointLabel}` : `${label}${view.link.lastError ? ` · ${view.link.lastError}` : ''}`}
                leading={<Avatar name={view.assistant.name} size={34} online={online} />}
                trailing={<StatusPill label={label} tone={online ? 'online' : view.link.status === 'failed' ? 'error' : 'offline'} />}
                onPress={() => router.push(`/assistant/${view.assistant.id}/settings`)}
              />
            )
          })
        )}
        <View style={styles.buttonRow}>
          <SecondaryButton label="全部重连" onPress={() => store.reconnectAll()} />
          <PrimaryButton label="添加电脑" onPress={() => router.push('/scan')} />
        </View>
      </SectionCard>

      <SectionCard
        title="连接方式（全部电脑）"
        subtitle="统一设置所有已绑定电脑的连接方式，切换后立即重连；想单独设置某台，点上面那一行进去改。"
      >
        {snapshot.assistants.length === 0 ? (
          <Muted style={styles.hint}>还没有绑定电脑。绑定后可以在这里统一选择自动 / 局域网 / Tailscale / 公网隧道。</Muted>
        ) : (
          <>
            <SegmentedControl options={CONNECTION_MODE_OPTIONS} value={uniformConnectionMode(snapshot.assistants)} onChange={mode => void changeAllModes(mode)} />
            <Muted style={styles.hint}>
              「自动」会按上次成功 → Tailscale → 局域网 → 公网隧道的顺序尝试；指定后只用这一类地址。任一台没有该类地址时，会给出可操作提示。
            </Muted>
          </>
        )}
      </SectionCard>

      <SectionCard title="手动地址" subtitle="自动连接连不上时的兜底：填电脑的 host:port（可带 http://），先测试再连接。">
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
            label={connecting ? '连接中…' : '连接这台电脑'}
            onPress={() => void connectManual()}
            loading={connecting}
            disabled={manualAddress.trim().length === 0}
          />
        </View>
        {probe ? (
          <View style={styles.probeBox}>
            <Text style={styles.probeTitle}>{probe.ok ? '✓ 地址可用' : '✕ 地址不可用'}</Text>
            <Text style={styles.probeLine} numberOfLines={3}>
              {probe.ok
                ? `${probe.name ? `${probe.name} · ` : ''}${probe.kind ? endpointKindLabel(probe.kind) : '未知网络'}${probe.version ? ` · 插件 ${probe.version}` : ''}\n${probe.address ?? ''}`
                : `${probe.message ?? '连不上这个地址'}${probe.hint ? `\n${probe.hint}` : ''}`}
            </Text>
          </View>
        ) : null}
        <Muted style={styles.hint}>地址必须和某台已绑定的电脑对得上（按电脑 ID 匹配），未绑定的电脑仍需先扫码完成绑定。</Muted>
      </SectionCard>

      {/* 协作 ------------------------------------------------------------- */}
      <SectionTitle>协作</SectionTitle>
      <SectionCard
        title="协作模式"
        subtitle="打开后，同一会话里的其他人也能看到并回复。会话级开关，只影响对应的电脑。"
      >
        {snapshot.assistants.length === 0 ? (
          <Muted style={styles.hint}>绑定电脑后可以在这里切换协作模式。</Muted>
        ) : (
          snapshot.assistants.map(view => (
            <SwitchRow
              key={view.assistant.id}
              label={view.assistant.name}
              description={view.link.online ? '切换后电脑端会广播给同一会话的所有设备。' : '连上电脑后才能切换。'}
              value={view.collaboration}
              onValueChange={value => void toggleCollaboration(view.assistant.id, value)}
              disabled={!view.link.online || collabBusyId === view.assistant.id}
            />
          ))
        )}
        {collaborating.length > 0 ? (
          <View style={styles.participantsBlock}>
            <Text style={styles.fieldLabel}>当前参与者</Text>
            {collaborating.map(view => (
              <View key={view.assistant.id} style={styles.participantGroup}>
                <Text style={styles.participantGroupLabel}>{view.assistant.name}</Text>
                <AvatarBar people={view.participants} />
              </View>
            ))}
          </View>
        ) : null}
      </SectionCard>

      <SectionCard title="我的昵称" subtitle="协作时你的每条消息都会带这个昵称，方便区分谁在说话。">
        <TextInput
          value={nickname}
          onChangeText={setNickname}
          placeholder="例如“小明”；留空则用设备默认名"
          placeholderTextColor={theme.colors.textFaint}
          style={styles.input}
          maxLength={24}
        />
        <PrimaryButton label="保存昵称（应用到所有电脑）" onPress={() => void saveNickname()} />
      </SectionCard>

      {/* 外观 ------------------------------------------------------------- */}
      <SectionTitle>外观</SectionTitle>
      <SectionCard title="主题" subtitle="默认跟随系统；白天的浅色和夜里的深色都能看清。">
        <SegmentedControl options={APPEARANCE_OPTIONS} value={appearance} onChange={value => void store.setAppearance(value)} />
      </SectionCard>

      {/* 文件 ------------------------------------------------------------- */}
      <SectionTitle>文件</SectionTitle>
      <SectionCard title="下载与上传">
        <KeyValue label="下载保存位置" value={downloadsLocationHint()} />
        <KeyValue label="单条消息附件上限" value={formatBytes(MAX_UPLOAD_BYTES)} />
        <SecondaryButton label="清理已下载的文件" onPress={clearFiles} />
        <Muted style={styles.hint}>
          手机发给电脑的图片/文件会分块上传，大文件也不会一次吃满内存；电脑发来的文件下载完成后点卡片即可打开。
        </Muted>
      </SectionCard>

      {/* 高级 ------------------------------------------------------------- */}
      <SectionTitle>高级（诊断）</SectionTitle>
      <SectionCard title="连接参数" subtitle="一般不需要改。这里只给排查连接问题时用。">
        <KeyValue label="协议版本" value={PROTOCOL_VERSION} />
        <KeyValue label="默认心跳" value={`${Math.round(DEFAULT_HEARTBEAT_MS / 1000)} 秒`} />
        <KeyValue label="已绑定电脑" value={`${snapshot.assistants.length} 台`} />
        <SwitchRow
          label="允许局域网直连"
          description="手机与电脑在同一局域网时直连，不绕公网隧道。校园网/宿舍网常有客户端隔离，开了也连不上。"
          value={policy.allowLan}
          onValueChange={value => void store.updateConnectionPolicy({ allowLan: value })}
        />
        <SwitchRow
          label="内部测试模式"
          description="仅供内部人员测试。打开后才会出现下面的 USB 调试通道开关。"
          value={policy.internalTestMode}
          onValueChange={value => void store.updateConnectionPolicy({ internalTestMode: value })}
        />
        {policy.internalTestMode ? (
          <SwitchRow
            label="USB 调试通道"
            description="用数据线连接，靠 adb reverse 把手机本机端口转发到电脑。需要电脑端先执行 adb reverse。"
            value={policy.allowUsb}
            onValueChange={value => void store.updateConnectionPolicy({ allowUsb: value })}
          />
        ) : null}
        <Muted style={styles.hint}>关闭「内部测试模式」会同时关闭 USB 通道，避免测试开关被带进正式使用环境。</Muted>
      </SectionCard>

      {/* 已知限制 --------------------------------------------------------- */}
      <SectionTitle>已知限制</SectionTitle>
      <SectionCard title="写在前面">
        <Text style={styles.limitTitle}>1. 远程开机（WoL）</Text>
        <Muted style={styles.hint}>
          手机在 4G/5G 时无法向家里局域网发广播，电脑关机后手机也连不上它。所以“唤醒”需要你在局域网里准备一台常开设备
          （或路由器）代发魔术包，并在助理详情里填写唤醒代理地址。协议里没有 WOL 帧，本应用也不会伪造一个。
        </Muted>
        <Text style={styles.limitTitle}>2. 公网地址会变</Text>
        <Muted style={styles.hint}>
          电脑端如果用的是临时隧道，每次重启都可能换地址，手机保存的地址就失效了。推荐把 Tailscale 作为主通道；
          地址变了也可以用手动地址兜底。
        </Muted>
        <Text style={styles.limitTitle}>3. 重新绑定</Text>
        <Muted style={styles.hint}>
          如果电脑端提示设备密钥校验失败，需要在电脑的插件配对页面解除绑定后重新生成二维码。这是电脑端握手顺序的问题，
          手机端无法绕过。
        </Muted>
      </SectionCard>

      {/* 危险操作 --------------------------------------------------------- */}
      <SectionTitle>危险操作</SectionTitle>
      <SectionCard subtitle="解除所有绑定并清空本机数据（设备密钥、聊天记录、备注名）。电脑端需要另行解除。">
        <SecondaryButton label="解除所有绑定并清空本机数据" onPress={unbindAll} tone="danger" />
      </SectionCard>

      {/* 关于 ------------------------------------------------------------- */}
      <SectionTitle>关于</SectionTitle>
      <SectionCard title="Open Whale 手机端">
        <KeyValue label="版本" value={APP_VERSION} />
        <KeyValue label="协议版本" value={PROTOCOL_VERSION} />
        <KeyValue label="配套插件" value="dsh-openwhale" />
        <KeyValue label="已绑定电脑" value={`${snapshot.assistants.length} 台`} />
        <Muted style={styles.hint}>手机端只负责显示与交互；连接、加密、文件传输都在本机完成，聊天内容不经过第三方服务器。</Muted>
      </SectionCard>

      <View style={styles.footer}>
        <Text style={styles.footerText}>Open Whale 手机端 {APP_VERSION} · 与 dsh-openwhale 插件配套使用</Text>
      </View>
      <Toast message={toast?.message} tone={toast?.tone} />
    </ScrollView>
  )
}

// ---------------------------------------------------------------------------

/** 所有已绑定电脑的连接方式一致时返回它，否则返回 undefined（分段控件显示“无选中”）。 */
function uniformConnectionMode(views: AssistantView[]): ConnectionMode | undefined {
  const first = views[0]
  if (!first) return undefined
  return views.every(view => view.connectionMode === first.connectionMode) ? first.connectionMode : undefined
}

const createSettingsStyles = (theme: Theme) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.colors.background },
    content: { padding: spacing.lg, paddingBottom: spacing.xxxl },
    hint: { lineHeight: 18, marginTop: spacing.sm },
    fieldLabel: { color: theme.colors.text, fontSize: font.small, fontWeight: '600', marginBottom: spacing.xs },
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
    buttonRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
    probeBox: { marginTop: spacing.md, padding: spacing.md, borderRadius: radius.md, backgroundColor: theme.colors.surfaceAlt },
    probeTitle: { color: theme.colors.text, fontWeight: '700', fontSize: font.small },
    probeLine: { color: theme.colors.textMuted, fontSize: font.tiny, lineHeight: 17, marginTop: 4 },
    participantsBlock: { marginTop: spacing.md },
    participantGroup: { marginBottom: spacing.sm },
    participantGroupLabel: { color: theme.colors.textMuted, fontSize: font.tiny, marginBottom: 2 },
    limitTitle: { color: theme.colors.text, fontSize: font.small, fontWeight: '700', marginTop: spacing.md },
    footer: { marginTop: spacing.xl, alignItems: 'center' },
    footerText: { color: theme.colors.textFaint, fontSize: font.tiny, textAlign: 'center', lineHeight: 17 },
  })
