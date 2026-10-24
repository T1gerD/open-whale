// 全局设置 / 关于 / 已知限制。
//
// 把限制写进 App 而不是只写在 README：用户看不到 README，而“为什么开不了机”“为什么
// 隧道地址会变”这类问题是必须要提前说清楚的。

import { Alert, ScrollView, StyleSheet, Switch, Text, View } from 'react-native'

import { DEFAULT_CONNECTION_POLICY } from '../src/core/connection-policy.mts'
import { DEFAULT_HEARTBEAT_MS, PROTOCOL_VERSION } from '../src/protocol/runtime'
import { clearDownloads, downloadsLocationHint } from '../src/services/transfers'
import { useAppSnapshot, useAppStore } from '../src/state/store'
import { Card, KeyValue, Muted, PrimaryButton, SecondaryButton, SectionTitle } from '../src/ui/components'
import { colors, font, spacing } from '../src/ui/theme'

export default function SettingsScreen() {
  const snapshot = useAppSnapshot()
  const store = useAppStore()
  const policy = snapshot.connectionPolicy ?? DEFAULT_CONNECTION_POLICY

  const clearFiles = () => {
    Alert.alert('清理已下载的文件？', '聊天记录会保留，文件卡片需要重新下载。', [
      { text: '取消', style: 'cancel' },
      {
        text: '清理',
        style: 'destructive',
        onPress: () => {
          void clearDownloads().then(() => Alert.alert('已清理', downloadsLocationHint()))
        },
      },
    ])
  }

  const unbindAll = () => {
    Alert.alert('解除所有绑定？', '会删除本机保存的设备密钥、聊天记录和备注名。电脑端的绑定需要另行解除。', [
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
                `${notNotified} 台电脑没有收到解绑请求（当时未连接）。\n\n请在那台电脑的浏览器打开配对页（http://127.0.0.1:19387/openwhale），点「解除绑定」。`,
                [{ text: '知道了' }],
              )
            }
          })()
        },
      },
    ])
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <SectionTitle>本机设备</SectionTitle>
      <Card>
        <KeyValue label="设备名" value={snapshot.deviceName ?? '（首次绑定时生成）'} />
        <KeyValue label="设备 ID" value={snapshot.deviceId ?? '—'} />
        <Muted style={styles.hint}>
          设备私钥保存在系统密钥库（Android Keystore / iOS Keychain）里，不会上传，也不能导出。
          电脑端只保存它的公钥。
        </Muted>
      </Card>

      <SectionTitle>连接</SectionTitle>
      <Card>
        <KeyValue label="协议版本" value={PROTOCOL_VERSION} />
        <KeyValue label="默认心跳" value={`${Math.round(DEFAULT_HEARTBEAT_MS / 1000)} 秒`} />
        <KeyValue label="已绑定电脑" value={`${snapshot.assistants.length} 台`} />
        <PrimaryButton label="全部重连" onPress={() => store.reconnectAll()} />
        <Muted style={styles.hint}>
          断线后等待时间从 1 秒翻倍到 30 秒封顶；回到前台时会立刻重试一次。手机在后台时系统可能冻结连接，
          这是 Android/iOS 的限制，不是可以绕过的 bug。
        </Muted>
      </Card>

      <SectionTitle>高级连接方式</SectionTitle>
      <Card>
        <Muted style={styles.hint}>
          常规连接只走公网隧道（https），一般不需要改这里。
          只有在「局域网能直连」或「需要走数据线调试」这类特殊场景下才打开下面的开关。
        </Muted>
        <SettingSwitch
          label="允许局域网直连"
          description="手机与电脑在同一个局域网内时直连，不绕公网隧道。校园网/宿舍网常有客户端隔离，开了也连不上。"
          value={policy.allowLan}
          onValueChange={value => void store.updateConnectionPolicy({ allowLan: value })}
        />
        <SettingSwitch
          label="内部测试模式"
          description="仅供内部人员测试。打开后才会出现下面的 USB 调试通道开关。"
          value={policy.internalTestMode}
          onValueChange={value => void store.updateConnectionPolicy({ internalTestMode: value })}
        />
        {policy.internalTestMode ? (
          <SettingSwitch
            label="USB 调试通道"
            description="用数据线连接，靠 adb reverse 把手机本机端口转发到电脑。需要电脑端先执行 adb reverse tcp:19387 tcp:19387。"
            value={policy.allowUsb}
            onValueChange={value => void store.updateConnectionPolicy({ allowUsb: value })}
          />
        ) : null}
        <Muted style={styles.hint}>
          关闭「内部测试模式」会同时关闭 USB 通道，避免测试开关被带进正式使用环境。
        </Muted>
      </Card>

      <SectionTitle>文件</SectionTitle>
      <Card>
        <KeyValue label="保存位置" value={downloadsLocationHint()} />
        <SecondaryButton label="清理已下载的文件" onPress={clearFiles} />
        <Muted style={styles.hint}>
          单次下载在 {Math.round(48)} MB 以内（手机端在内存里按序拼装；真正流式落盘待真机验证）。
          发送附件上限 8 MB，更大的文件请在电脑上处理。
        </Muted>
      </Card>

      <SectionTitle>已知限制</SectionTitle>
      <Card>
        <Text style={styles.limitTitle}>1. 远程开机（WoL）</Text>
        <Muted style={styles.hint}>
          手机在 4G/5G 时无法向家里局域网发广播，电脑关机后手机也连不上它。所以“唤醒”需要你在局域网里
          准备一台常开设备（或路由器）代发魔术包，并在助理详情里填写唤醒代理地址。协议里没有 WOL 帧，
          本应用也不会伪造一个。
        </Muted>
        <Text style={styles.limitTitle}>2. 公网地址会变</Text>
        <Muted style={styles.hint}>
          电脑端如果用的是 cloudflared 快速隧道，每次重启都会换域名，手机保存的地址就失效了。
          官方明确说它“只适合测试”，建议改用固定的隧道或自建中继。
        </Muted>
        <Text style={styles.limitTitle}>3. 重新绑定</Text>
        <Muted style={styles.hint}>
          如果电脑端提示设备密钥校验失败，需要在电脑上解除绑定后重新生成二维码。这是当前电脑端握手
          顺序的问题，不是手机端可以绕过的。
        </Muted>
        <Text style={styles.limitTitle}>4. 大文件</Text>
        <Muted style={styles.hint}>
          传输走的是同一根 WebSocket，base64 分块。超过 {Math.round(48)} MB 的文件会先被拦下来，
          避免手机内存被吃光。
        </Muted>
      </Card>

      <SectionTitle>危险操作</SectionTitle>
      <Card>
        <SecondaryButton label="解除所有绑定并清空本机数据" onPress={unbindAll} tone="danger" />
      </Card>

      <View style={styles.footer}>
        <Text style={styles.footerText}>Open Whale 手机端 · 与 dsh-openwhale 插件配套使用</Text>
      </View>
    </ScrollView>
  )
}

/**
 * 一行带说明的开关。设置页里这类"有副作用的开关"必须写清它能干什么、有什么前提，
 * 否则用户只会看到一个不知道要不要打开的滑块。
 */
function SettingSwitch(props: {
  label: string
  description: string
  value: boolean
  onValueChange: (value: boolean) => void
}) {
  return (
    <View style={styles.switchRow}>
      <View style={styles.switchText}>
        <Text style={styles.switchLabel}>{props.label}</Text>
        <Muted style={styles.switchHint}>{props.description}</Muted>
      </View>
      <Switch value={props.value} onValueChange={props.onValueChange} />
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl },
  hint: { marginTop: spacing.sm, lineHeight: 19 },
  limitTitle: { color: colors.text, fontSize: font.body, fontWeight: '600', marginTop: spacing.md },
  footer: { marginTop: spacing.xl, alignItems: 'center' },
  footerText: { color: colors.textMuted, fontSize: font.tiny },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing.md,
    marginTop: spacing.md,
  },
  switchText: { flex: 1 },
  switchLabel: { color: colors.text, fontSize: font.body, fontWeight: '600' },
  switchHint: { marginTop: 2, lineHeight: 17 },
})
