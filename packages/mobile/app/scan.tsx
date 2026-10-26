// 扫码绑定（三个入口）。
//
// 1) 相机扫码：expo-camera 的 CameraView + onBarcodeScanned（不用已废弃的 barcode-scanner）；
// 2) 相册识图：截图/拍照的二维码也能用（相机被拒、二维码在屏幕上、或在别人手机上时最有用）；
// 3) 手动输入：host:port，先做 /openwhale/health 预检，再决定连哪台电脑。
//
// 三个入口最后都走同一条 store.pair()/connectManually() 业务链路，这里只负责调用与提示。

import { CameraView, useCameraPermissions } from 'expo-camera'
import { Stack, useRouter } from 'expo-router'
import { useCallback, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'

import { endpointKindLabel } from '../src/core/endpoint.mts'
import { extractJsonObject } from '../src/core/pairing.mts'
import { DEFAULT_PORT } from '../src/protocol/runtime'
import type { AppStore } from '../src/state/app-store'
import { useAppSnapshot, useAppStore } from '../src/state/store'
import {
  InlineBanner,
  Muted,
  PrimaryButton,
  SecondaryButton,
  SectionCard,
  SegmentedControl,
} from '../src/ui/components'
import { absoluteFill, font, radius, spacing, useTheme, useThemedStyles, type Theme } from '../src/ui/theme'

type ScanTab = 'camera' | 'album' | 'manual'
type AddressProbe = Awaited<ReturnType<AppStore['probeAddress']>>

const TABS = [
  { value: 'camera' as const, label: '相机扫码' },
  { value: 'album' as const, label: '相册识图' },
  { value: 'manual' as const, label: '手动输入' },
]

export default function ScanScreen() {
  const store = useAppStore()
  const snapshot = useAppSnapshot()
  const router = useRouter()
  const theme = useTheme()
  const styles = useThemedStyles(createScanStyles)

  const [permission, requestPermission] = useCameraPermissions()
  const [tab, setTab] = useState<ScanTab>('camera')

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ message: string; hint?: string } | undefined>()

  const [manualAddress, setManualAddress] = useState('')
  const [probing, setProbing] = useState(false)
  const [probe, setProbe] = useState<AddressProbe | undefined>()
  const [probeError, setProbeError] = useState<{ message: string; hint?: string } | undefined>()
  const [connectingManual, setConnectingManual] = useState(false)

  const [showPaste, setShowPaste] = useState(false)
  const [pasteText, setPasteText] = useState('')

  // 相机的回调会连续触发几十次，用锁保证一次绑定流程只跑一次。
  const lock = useRef(false)

  const bind = useCallback(
    async (raw: unknown, source: '相机' | '相册' | '粘贴') => {
      if (lock.current) return
      lock.current = true
      setBusy(true)
      setError(undefined)
      try {
        const parsed = typeof raw === 'string' ? extractJsonObject(raw) ?? raw : raw
        const result = await store.pair(parsed)
        if (result.ok && result.assistantId) {
          // 绑定成功：替换路由，避免用户按返回键回到扫码页。
          router.replace(`/assistant/${result.assistantId}`)
          return
        }
        setError({
          message: result.error ?? `${source}绑定失败`,
          hint: result.hint,
        })
      } catch (caught) {
        setError({ message: `${source}绑定失败：${(caught as Error).message}` })
      } finally {
        setBusy(false)
        // 失败后允许重新扫描；成功时页面已经被替换掉了。
        lock.current = false
      }
    },
    [router, store],
  )

  const pairFromAlbum = useCallback(async () => {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    setError(undefined)
    try {
      const result = await store.pairFromAlbum()
      if (result.ok && result.assistantId) {
        router.replace(`/assistant/${result.assistantId}`)
        return
      }
      if (!result.cancelled) {
        setError({ message: result.error ?? '这张图里没找到二维码', hint: result.hint ?? '换一张更清晰、二维码在画面里占比更大的截图再试。' })
      }
    } catch (caught) {
      setError({ message: `读取图片失败：${(caught as Error).message}`, hint: '也可以回到相机扫码，或用手动输入。' })
    } finally {
      setBusy(false)
      lock.current = false
    }
  }, [router, store])

  const runProbe = useCallback(async () => {
    const address = manualAddress.trim()
    if (!address) return
    setProbing(true)
    setProbe(undefined)
    setProbeError(undefined)
    try {
      const result = await store.probeAddress(address)
      setProbe(result)
      if (!result.ok) setProbeError({ message: result.message ?? '连不上这个地址', hint: result.hint })
    } catch (caught) {
      setProbeError({ message: `测试连接失败：${(caught as Error).message}` })
    } finally {
      setProbing(false)
    }
  }, [manualAddress, store])

  const matchedAssistant = probe?.computerId
    ? snapshot.assistants.find(view => view.assistant.computerId === probe.computerId)
    : undefined

  const connectManual = useCallback(async () => {
    const address = manualAddress.trim()
    if (!address) return
    setConnectingManual(true)
    setProbeError(undefined)
    try {
      const result = await store.connectManually(address)
      if (result.ok && result.assistantId) {
        router.replace(`/assistant/${result.assistantId}`)
        return
      }
      setProbeError({ message: result.error ?? '连接失败', hint: result.hint })
    } catch (caught) {
      setProbeError({ message: `连接失败：${(caught as Error).message}` })
    } finally {
      setConnectingManual(false)
    }
  }, [manualAddress, router, store])

  const bindPasted = useCallback(async () => {
    const text = pasteText.trim()
    if (!text) return
    await bind(text, '粘贴')
  }, [bind, pasteText])

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Stack.Screen options={{ title: '添加电脑' }} />

      <SegmentedControl options={TABS} value={tab} onChange={setTab} style={styles.tabs} />

      {error ? (
        <InlineBanner tone="error" title="没能绑定这台电脑" actionLabel="重试" onAction={() => setError(undefined)}>
          {error.message}
          {error.hint ? `\n${error.hint}` : ''}
        </InlineBanner>
      ) : null}

      {tab === 'camera' ? (
        <View style={styles.cameraCard}>
          {permission?.granted ? (
            <>
              <CameraView
                style={styles.camera}
                facing="back"
                barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                onBarcodeScanned={busy ? undefined : event => void bind(String(event.data ?? ''), '相机')}
              />
              <View pointerEvents="none" style={styles.cameraOverlay}>
                <View style={[styles.corner, styles.cornerTopLeft]} />
                <View style={[styles.corner, styles.cornerTopRight]} />
                <View style={[styles.corner, styles.cornerBottomLeft]} />
                <View style={[styles.corner, styles.cornerBottomRight]} />
                <Text style={styles.cameraHint}>把电脑上的二维码放进框里</Text>
              </View>
              {busy ? (
                <View style={styles.cameraBusy}>
                  <ActivityIndicator color="#FFFFFF" />
                  <Text style={styles.cameraBusyText}>正在绑定…</Text>
                </View>
              ) : null}
            </>
          ) : (
            <View style={styles.cameraPlaceholder}>
              <Text style={styles.placeholderEmoji}>📷</Text>
              <Text style={styles.placeholderTitle}>需要相机权限才能扫码</Text>
              <Muted style={styles.placeholderHint}>
                {permission?.canAskAgain === false
                  ? '相机权限已被永久拒绝。可以到系统设置里打开，或者直接用「相册识图」「手动输入」。'
                  : '也可以直接跳过相机：用相册里的二维码截图，或者手动填电脑地址。'}
              </Muted>
              <View style={styles.placeholderActions}>
                {permission?.canAskAgain !== false ? (
                  <PrimaryButton label="授予相机权限" onPress={() => void requestPermission()} />
                ) : null}
                <SecondaryButton label="改用相册识图" onPress={() => setTab('album')} />
              </View>
            </View>
          )}
        </View>
      ) : null}

      {tab === 'album' ? (
        <SectionCard title="从相册选一张二维码截图" subtitle="适合二维码在电脑屏幕上、或在另一台手机里；相机被拒绝也能用这条路。">
          <View style={styles.albumBody}>
            <Text style={styles.albumEmoji}>🖼</Text>
            <Muted style={styles.albumHint}>
              选图后会在本机直接识别二维码内容，不会上传到任何服务器。识别失败时会尽量告诉你原因。
            </Muted>
            <PrimaryButton label={busy ? '正在识别…' : '选择相册图片'} loading={busy} onPress={() => void pairFromAlbum()} />
            <Muted style={styles.tinyHint}>
              小技巧：让二维码在截图里占得大一点、别裁掉边角，识别成功率最高。二维码 10 分钟内有效，过期请让电脑重新生成。
            </Muted>
          </View>
        </SectionCard>
      ) : null}

      {tab === 'manual' ? (
        <>
          <SectionCard title="手动输入地址" subtitle="输入电脑地址（host:port，可带 http://），先测一下通不通，再连接。">
            <TextInput
              value={manualAddress}
              onChangeText={setManualAddress}
              placeholder={`例如 192.168.1.9:${DEFAULT_PORT} 或 my-pc.tailnet-name.ts.net`}
              placeholderTextColor={theme.colors.textFaint}
              style={[styles.input, { color: theme.colors.text, backgroundColor: theme.colors.surfaceAlt, borderColor: theme.colors.border }]}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              returnKeyType="done"
              onSubmitEditing={() => void runProbe()}
            />
            <View style={styles.buttonRow}>
              <SecondaryButton label={probing ? '测试中…' : '测试连接'} onPress={() => void runProbe()} disabled={probing || manualAddress.trim().length === 0} />
              <PrimaryButton
                label={connectingManual ? '连接中…' : '连接这台电脑'}
                onPress={() => void connectManual()}
                loading={connectingManual}
                disabled={manualAddress.trim().length === 0}
              />
            </View>
            {probeError ? (
              <InlineBanner tone="error" title="没能连上">
                {probeError.message}
                {probeError.hint ? `\n${probeError.hint}` : ''}
              </InlineBanner>
            ) : null}
            {probe?.ok ? (
              <View style={[styles.probeCard, { backgroundColor: theme.colors.successSoft }]}>
                <Text style={[styles.probeTitle, { color: theme.colors.success }]}>✓ 地址可用</Text>
                <Text style={styles.probeLine} numberOfLines={1}>
                  {probe.name ? `${probe.name} · ` : ''}
                  {probe.kind ? endpointKindLabel(probe.kind) : '未知网络'}
                  {probe.version ? ` · 插件 ${probe.version}` : ''}
                </Text>
                <Text style={styles.probeAddress} numberOfLines={1}>
                  {probe.address}
                </Text>
                {matchedAssistant ? (
                  <>
                    <Muted style={styles.probeHint}>
                      这台电脑已经绑定过（{matchedAssistant.assistant.name}）。点下面按钮会把它切换到当前地址并立刻重连。
                    </Muted>
                    <PrimaryButton label="用这个地址连接" onPress={() => void connectManual()} loading={connectingManual} />
                  </>
                ) : (
                  <Muted style={styles.probeHint}>
                    这台电脑还没有和本机绑定。请先在电脑上生成二维码，用「相机扫码」或「相册识图」完成一次绑定；绑定之后就能随时在这里换地址。
                  </Muted>
                )}
              </View>
            ) : null}
            <Muted style={styles.tinyHint}>
              手动地址是给「自动连接连不上」时兜底的：换网络、换端口、或电脑换了 Tailscale 地址都可以用它。填写后只影响本机保存的这台电脑。
            </Muted>
          </SectionCard>

          <SectionCard title="高级：粘贴配对信息" subtitle="最后一道保险。相机/相册都不可用时，可以把电脑插件页面的配对内容整段贴进来。">
            <Pressable accessibilityRole="button" onPress={() => setShowPaste(value => !value)} hitSlop={6} style={styles.pasteToggle}>
              <Text style={[styles.pasteToggleText, { color: theme.colors.accent }]}>{showPaste ? '收起' : '展开粘贴框'} ›</Text>
            </Pressable>
            {showPaste ? (
              <>
                <TextInput
                  value={pasteText}
                  onChangeText={setPasteText}
                  multiline
                  placeholder={'{"v":1,"p":"openwhale", …}'}
                  placeholderTextColor={theme.colors.textFaint}
                  style={[
                    styles.input,
                    styles.pasteInput,
                    { color: theme.colors.text, backgroundColor: theme.colors.surfaceAlt, borderColor: theme.colors.border },
                  ]}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <PrimaryButton
                  label={busy ? '正在绑定…' : '用粘贴的内容绑定'}
                  loading={busy}
                  disabled={pasteText.trim().length === 0}
                  onPress={() => void bindPasted()}
                />
              </>
            ) : null}
          </SectionCard>
        </>
      ) : null}

      <View style={[styles.methodsCard, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}>
        <Text style={styles.methodsTitle}>手机怎么连上电脑？</Text>
        <MethodRow glyph="🏠" title="局域网" description="手机和电脑在同一个 Wi-Fi 下，速度最快；换了网络就连不上。" />
        <MethodRow glyph="🔗" title="Tailscale" description="手机和电脑登录同一个 tailnet，就像在同一个内网里，人在外面也能连。" />
        <MethodRow glyph="🌐" title="公网隧道" description="插件自动开的隧道，任何网络都能连，但地址可能会变（推荐配合 Tailscale 用）。" />
        <Muted style={styles.methodsHint}>
          绑定好之后，可以在「设置 → 连接」里指定优先用哪一种，或填一个手动地址兜底。同时支持在电脑端切换生成二维码时的连接方式。
        </Muted>
      </View>

    </ScrollView>
  )
}

function MethodRow({ glyph, title, description }: { glyph: string; title: string; description: string }) {
  const styles = useThemedStyles(createScanStyles)
  return (
    <View style={styles.methodRow}>
      <Text style={styles.methodGlyph}>{glyph}</Text>
      <View style={styles.methodBody}>
        <Text style={styles.methodTitle}>{title}</Text>
        <Text style={styles.methodDescription}>{description}</Text>
      </View>
    </View>
  )
}

const createScanStyles = (theme: Theme) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.colors.background },
    content: { padding: spacing.lg, paddingBottom: spacing.xxxl, gap: spacing.md },
    tabs: { marginBottom: spacing.xs },

    cameraCard: {
      height: 340,
      borderRadius: radius.lg,
      overflow: 'hidden',
      backgroundColor: '#0B1020',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
    },
    camera: { flex: 1 },
    cameraOverlay: { ...absoluteFill, alignItems: 'center', justifyContent: 'center' },
    corner: { position: 'absolute', width: 30, height: 30, borderColor: 'rgba(255,255,255,0.85)' },
    cornerTopLeft: { top: '18%', left: '14%', borderTopWidth: 3, borderLeftWidth: 3, borderTopLeftRadius: 8 },
    cornerTopRight: { top: '18%', right: '14%', borderTopWidth: 3, borderRightWidth: 3, borderTopRightRadius: 8 },
    cornerBottomLeft: { bottom: '18%', left: '14%', borderBottomWidth: 3, borderLeftWidth: 3, borderBottomLeftRadius: 8 },
    cornerBottomRight: { bottom: '18%', right: '14%', borderBottomWidth: 3, borderRightWidth: 3, borderBottomRightRadius: 8 },
    cameraHint: { position: 'absolute', bottom: '10%', color: 'rgba(255,255,255,0.9)', fontSize: font.small },
    cameraBusy: {
      ...absoluteFill,
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
      backgroundColor: 'rgba(11, 16, 32, 0.55)',
    },
    cameraBusyText: { color: '#FFFFFF', fontSize: font.small, fontWeight: '600' },
    cameraPlaceholder: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md, padding: spacing.lg },
    placeholderEmoji: { fontSize: 40 },
    placeholderTitle: { color: '#FFFFFF', fontSize: font.headline, fontWeight: '700', textAlign: 'center' },
    placeholderHint: { color: 'rgba(255,255,255,0.72)', textAlign: 'center', lineHeight: 20 },
    placeholderActions: { alignSelf: 'stretch', gap: spacing.sm, marginTop: spacing.sm },

    albumBody: { gap: spacing.md, paddingVertical: spacing.sm },
    albumEmoji: { fontSize: 44, textAlign: 'center' },
    albumHint: { textAlign: 'center', lineHeight: 20 },
    tinyHint: { lineHeight: 18, marginTop: spacing.xs },

    input: {
      minHeight: 48,
      paddingHorizontal: spacing.md,
      borderRadius: radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      fontSize: font.body,
      marginVertical: spacing.md,
    },
    pasteInput: { minHeight: 110, textAlignVertical: 'top', fontFamily: font.mono, fontSize: font.small, paddingTop: spacing.md },
    buttonRow: { flexDirection: 'row', gap: spacing.sm },
    probeCard: { borderRadius: radius.md, padding: spacing.md, marginTop: spacing.md, gap: spacing.sm },
    probeTitle: { fontSize: font.body, fontWeight: '700' },
    probeLine: { color: theme.colors.text, fontSize: font.small },
    probeAddress: { color: theme.colors.textMuted, fontSize: font.tiny, fontFamily: font.mono },
    probeHint: { lineHeight: 18 },
    pasteToggle: { alignSelf: 'flex-start', paddingVertical: spacing.xs },
    pasteToggleText: { fontSize: font.small, fontWeight: '600' },

    methodsCard: {
      borderRadius: radius.lg,
      borderWidth: StyleSheet.hairlineWidth,
      padding: spacing.lg,
      marginTop: spacing.sm,
      gap: spacing.md,
    },
    methodsTitle: { color: theme.colors.text, fontSize: font.body, fontWeight: '700' },
    methodRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
    methodGlyph: { fontSize: 20, marginTop: 1 },
    methodBody: { flex: 1 },
    methodTitle: { color: theme.colors.text, fontSize: font.small, fontWeight: '600' },
    methodDescription: { color: theme.colors.textMuted, fontSize: font.tiny, lineHeight: 17, marginTop: 1 },
    methodsHint: { lineHeight: 18 },
  })
