// 全局设置 / 关于 / 已知限制。
//
// 把限制写进 App 而不是只写在 README：用户看不到 README，而“为什么开不了机”“为什么
// 隧道地址会变”这类问题是必须要提前说清楚的。

import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native'

import { DEFAULT_HEARTBEAT_MS, PROTOCOL_VERSION } from '../src/protocol/runtime'
import { clearDownloads, downloadsLocationHint } from '../src/services/transfers'
import { useAppSnapshot, useAppStore } from '../src/state/store'
import { Card, KeyValue, Muted, PrimaryButton, SecondaryButton, SectionTitle } from '../src/ui/components'
import { colors, font, spacing } from '../src/ui/theme'

export default function SettingsScreen() {
  const snapshot = useAppSnapshot()
  const store = useAppStore()

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
            for (const view of snapshot.assistants) await store.remove(view.assistant.id, true)
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

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl },
  hint: { marginTop: spacing.sm, lineHeight: 19 },
  limitTitle: { color: colors.text, fontSize: font.body, fontWeight: '600', marginTop: spacing.md },
  footer: { marginTop: spacing.xl, alignItems: 'center' },
  footerText: { color: colors.textMuted, fontSize: font.tiny },
})
