// 扫码绑定。
//
// 用 expo-camera 的 `CameraView` + `onBarcodeScanned`（不用已废弃的 expo-barcode-scanner）。
// 另外提供“粘贴二维码内容”的入口：模拟器、相机权限被拒、或二维码太密扫不出来时都能用。

import { CameraView, useCameraPermissions } from 'expo-camera'
import { useRouter } from 'expo-router'
import { useCallback, useRef, useState } from 'react'
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'

import { extractJsonObject } from '../src/core/pairing.mts'
import { useAppStore } from '../src/state/store'
import { Banner, Card, Muted, PrimaryButton, SecondaryButton } from '../src/ui/components'
import { colors, font, radius, spacing } from '../src/ui/theme'

export default function ScanScreen() {
  const store = useAppStore()
  const router = useRouter()
  const [permission, requestPermission] = useCameraPermissions()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ message: string; hint?: string } | undefined>()
  const [manual, setManual] = useState('')
  // 相机的回调会连续触发几十次，用锁保证一次绑定流程只跑一次。
  const lock = useRef(false)

  const bind = useCallback(
    async (raw: string) => {
      if (lock.current) return
      lock.current = true
      setBusy(true)
      setError(undefined)
      try {
        const parsed = extractJsonObject(raw) ?? raw
        const result = await store.pair(parsed)
        if (result.ok && result.assistantId) {
          // 绑定成功：替换路由，避免用户按返回键回到扫码页。
          router.replace(`/assistant/${result.assistantId}`)
          return
        }
        setError({ message: result.error ?? '绑定失败', hint: result.hint })
      } catch (caught) {
        setError({ message: `绑定失败：${(caught as Error).message}` })
      } finally {
        setBusy(false)
        // 失败后允许重新扫描；成功时页面已经被替换掉了。
        lock.current = false
      }
    },
    [router, store],
  )

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      {error ? (
        <Banner tone="error" title="没能绑定这台电脑" actionLabel="重试" onAction={() => setError(undefined)}>
          {error.message}
          {error.hint ? `\n${error.hint}` : ''}
        </Banner>
      ) : null}

      <Card style={styles.cameraCard}>
        {permission?.granted ? (
          <CameraView
            style={styles.camera}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={busy ? undefined : event => void bind(String(event.data ?? ''))}
          />
        ) : (
          <View style={styles.cameraPlaceholder}>
            <Text style={styles.placeholderTitle}>需要相机权限才能扫码</Text>
            <Muted style={styles.placeholderHint}>
              也可以在下方粘贴电脑上“配对信息”里的内容，效果完全一样。
            </Muted>
            <SecondaryButton label="授予相机权限" onPress={() => void requestPermission()} />
          </View>
        )}
      </Card>

      <Muted style={styles.tip}>
        在电脑上打开 Open Whale 插件页面，把二维码对准取景框即可。二维码里的绑定密钥只有 10 分钟有效期，过期请重新生成。
      </Muted>

      <Card>
        <Text style={styles.sectionTitle}>手动粘贴</Text>
        <Muted>如果相机不可用，可以把电脑上 `/openwhale/pairing.json` 的内容整段粘进来。</Muted>
        <TextInput
          value={manual}
          onChangeText={setManual}
          multiline
          placeholder={'{"v":1,"p":"openwhale", …}'}
          placeholderTextColor={colors.textMuted}
          style={styles.input}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <PrimaryButton
          label={busy ? '正在绑定…' : '用粘贴的内容绑定'}
          loading={busy}
          disabled={manual.trim().length === 0}
          onPress={() => void bind(manual)}
        />
      </Card>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, gap: spacing.md },
  cameraCard: { padding: 0, overflow: 'hidden', height: 320 },
  camera: { flex: 1 },
  cameraPlaceholder: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md, padding: spacing.lg },
  placeholderTitle: { color: colors.text, fontSize: font.body, fontWeight: '600' },
  placeholderHint: { textAlign: 'center' },
  tip: { lineHeight: 19 },
  sectionTitle: { color: colors.text, fontSize: font.body, fontWeight: '600', marginBottom: spacing.xs },
  input: {
    minHeight: 96,
    marginVertical: spacing.md,
    padding: spacing.md,
    color: colors.text,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    fontFamily: font.mono,
    fontSize: font.small,
    textAlignVertical: 'top',
  },
})
