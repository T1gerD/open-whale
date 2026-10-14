// 助理详情：备注名、远程电源、唤醒引导、连接信息、解绑。
//
// 远程电源的“二次确认 + 倒计时 + 取消入口”都在这里；“远程开机”只做唤醒入口与引导
// （原因写在 core/wake.mts 的注释里：关机后手机连不上它，协议里也没有 WOL 帧）。

import { Stack, useLocalSearchParams, useRouter } from 'expo-router'
import { useState } from 'react'
import { Alert, ScrollView, StyleSheet, TextInput, View } from 'react-native'

import { endpointLabel } from '../../../src/core/endpoint.mts'
import { cancelCopy, confirmCopy, formatCountdown, refusalMessage } from '../../../src/core/power.mts'
import { wakeGuidance } from '../../../src/core/wake.mts'
import { useAppStore, useAssistantView } from '../../../src/state/store'
import { Banner, Card, KeyValue, Muted, PrimaryButton, SecondaryButton, SectionTitle } from '../../../src/ui/components'
import { colors, font, radius, spacing } from '../../../src/ui/theme'

export default function AssistantSettingsScreen() {
  const params = useLocalSearchParams<{ id?: string }>()
  const assistantId = typeof params.id === 'string' ? params.id : ''
  const view = useAssistantView(assistantId)
  const store = useAppStore()
  const router = useRouter()

  const [name, setName] = useState(view?.assistant.name ?? '')
  const [wakeUrl, setWakeUrl] = useState(view?.assistant.wakeProxyUrl ?? '')
  const [wakeMac, setWakeMac] = useState(view?.assistant.wakeMac ?? '')
  const [wakeNotice, setWakeNotice] = useState<{ tone: 'info' | 'warning' | 'error' | 'success'; text: string; steps?: string[] } | undefined>()

  if (!view) {
    return (
      <View style={styles.screen}>
        <Stack.Screen options={{ title: '助理设置' }} />
        <Muted style={styles.pad}>找不到这个助理，它可能已经被解绑。</Muted>
      </View>
    )
  }

  const { assistant, link, power } = view
  const allowed = assistant.powerAllowed

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
    if (result.ok) {
      setWakeNotice({ tone: 'success', text: result.message })
      return
    }
    setWakeNotice({ tone: 'warning', text: result.message, steps: result.guidance })
  }

  const saveName = async () => {
    await store.rename(assistantId, name)
    Alert.alert('已保存', '备注名只影响这台手机上的显示；电脑端不支持时会自动跳过同步。')
  }

  const saveWake = async () => {
    await store.setWakeSetting(assistantId, { url: wakeUrl.trim() || undefined, mac: wakeMac.trim() || undefined })
    Alert.alert('已保存', '唤醒代理只影响这台手机，不会发给电脑端。')
  }

  const confirmUnbind = () => {
    Alert.alert(
      '解绑这台电脑？',
      '解绑后会删除本机上的聊天记录与设备密钥，需要重新扫码才能再连。电脑端的绑定也需要在电脑上解除。',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '解绑',
          style: 'destructive',
          onPress: () => {
            void store.remove(assistantId, true).then(() => router.replace('/'))
          },
        },
      ],
    )
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: assistant.name }} />

      {link.status !== 'online' ? (
        <Banner tone={link.status === 'failed' ? 'error' : 'warning'} title="连接状态" actionLabel="重连" onAction={() => store.reconnectNow(assistantId)}>
          {link.lastError ?? '未连接'}
          {link.hint ? `\n${link.hint}` : ''}
        </Banner>
      ) : null}

      {power.phase === 'pending' ? (
        <Banner
          tone="warning"
          title={`${power.action === 'restart' ? '重启' : '关机'}倒计时 ${formatCountdown(power.remainingSeconds)}`}
          actionLabel={cancelCopy(power.action)}
          onAction={() => runPower('cancel')}
        >
          现在取消还来得及。
        </Banner>
      ) : null}
      {power.phase === 'refused' ? <Banner tone="error" title="电脑拒绝了这次操作">{power.message ?? refusalMessage(power.reason)}</Banner> : null}
      {power.phase === 'cancelled' ? <Banner tone="info">{power.message ?? '已取消'}</Banner> : null}
      {power.phase === 'executed' ? <Banner tone="warning">{power.message ?? '电脑已执行电源操作'}</Banner> : null}

      <SectionTitle>备注名</SectionTitle>
      <Card>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="给这台电脑起个名字（例如“书房电脑”）"
          placeholderTextColor={colors.textMuted}
          style={styles.input}
          maxLength={60}
        />
        <PrimaryButton label="保存备注名" onPress={() => void saveName()} disabled={name.trim().length === 0 || name.trim() === assistant.name} />
        <Muted style={styles.hint}>备注只保存在本机。电脑端支持 `assistant/rename` 时会一并同步，不支持时静默跳过。</Muted>
      </Card>

      <SectionTitle>远程电源</SectionTitle>
      <Card>
        <Muted style={styles.hint}>
          关机/重启会有 30 秒缓冲，期间可以随时取消。电脑端会先执行系统命令，之后它会关机，手机也就无法再连上它。
        </Muted>
        <View style={styles.buttonRow}>
          <SecondaryButton label="关机" onPress={() => askPower('shutdown')} disabled={!allowed.includes('shutdown')} tone="danger" />
          <SecondaryButton label="重启" onPress={() => askPower('restart')} disabled={!allowed.includes('restart')} tone="danger" />
        </View>
        <View style={styles.buttonRow}>
          <SecondaryButton label="取消关机 / 重启" onPress={() => runPower('cancel')} disabled={!allowed.includes('cancel') && power.phase !== 'pending'} />
        </View>
        {!allowed.includes('shutdown') ? <Muted style={styles.hint}>电脑端已禁止远程关机/重启，只允许取消。</Muted> : null}
      </Card>

      <SectionTitle>唤醒（远程开机）</SectionTitle>
      <Card>
        <Muted style={styles.hint}>
          电脑关机后手机无法连接它，所以这里不会出现“假的开机按钮”。真正能开机的是局域网里的魔术包：
          要么让家里一台常开的设备代发，要么用路由器自带的 WoL 功能。
        </Muted>
        <PrimaryButton label="尝试唤醒" onPress={() => void doWake()} />
        <TextInput
          value={wakeUrl}
          onChangeText={setWakeUrl}
          placeholder="唤醒代理地址，例如 http://192.168.1.9:8787/wake?id={computerId}"
          placeholderTextColor={colors.textMuted}
          style={styles.input}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <TextInput
          value={wakeMac}
          onChangeText={setWakeMac}
          placeholder="这台电脑的 MAC（可选，填了才能用于 {mac} 占位符）"
          placeholderTextColor={colors.textMuted}
          style={styles.input}
          autoCapitalize="characters"
          autoCorrect={false}
        />
        <SecondaryButton label="保存唤醒设置" onPress={() => void saveWake()} />
        {wakeNotice ? (
          <Banner tone={wakeNotice.tone} title="唤醒">
            {wakeNotice.text}
            {wakeNotice.steps ? `\n\n${wakeNotice.steps.map((step, index) => `${index + 1}. ${step}`).join('\n')}` : ''}
          </Banner>
        ) : null}
        <Muted style={styles.hint}>{wakeGuidance({ mac: wakeMac })[0]}</Muted>
      </Card>

      <SectionTitle>连接信息</SectionTitle>
      <Card>
        <KeyValue label="状态" value={describeStatus(link.status)} />
        <KeyValue label="线路" value={link.endpoint ? endpointLabel(link.endpoint) : '未连接'} />
        <KeyValue label="当前地址" value={link.endpoint ?? '—'} />
        <KeyValue label="心跳" value={`${Math.round(link.heartbeatMs / 1000)} 秒`} />
        <KeyValue label="电脑版本" value={assistant.serverVersion ?? '未知'} />
        <KeyValue label="公钥指纹" value={assistant.fingerprint.slice(0, 24).toUpperCase()} />
        <KeyValue label="可用地址" value={`${assistant.endpoints.length} 个`} />
        <View style={styles.buttonRow}>
          <SecondaryButton label="重连" onPress={() => store.reconnectNow(assistantId)} />
          <SecondaryButton label="断开" onPress={() => store.disconnect(assistantId)} />
        </View>
        <Muted style={styles.hint}>
          重连会按“上次成功的地址 → 公网隧道 → 其余地址”的顺序依次尝试，等待时间从 1 秒指数增长到 30 秒封顶。
        </Muted>
      </Card>

      <SectionTitle>解绑</SectionTitle>
      <Card>
        <SecondaryButton label="解绑这台电脑" onPress={confirmUnbind} tone="danger" />
      </Card>
    </ScrollView>
  )
}

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

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl },
  pad: { padding: spacing.lg },
  input: {
    minHeight: 44,
    paddingHorizontal: spacing.md,
    color: colors.text,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    fontSize: font.body,
    marginVertical: spacing.sm,
  },
  buttonRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  hint: { marginTop: spacing.sm, lineHeight: 19 },
})
