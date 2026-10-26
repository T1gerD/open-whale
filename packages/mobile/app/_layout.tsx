// 根布局：注册路由 + 挂上全局状态容器 + 注入外观主题。
//
// 全局状态放在这里（而不是每个屏幕各自连一次），保证“一台电脑一条长连接”、
// 聊天页和列表页看到的是同一份状态。
//
// 主题：设置里的外观选择（system/light/dark）通过 AppearanceContext 往下传；
// 所有组件用 useTheme()/useThemedStyles() 取色，页面里不出现写死颜色。

import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { useEffect } from 'react'
import { SafeAreaProvider } from 'react-native-safe-area-context'

import { assertProtocolContract } from '../src/protocol/runtime'
import { AppProvider, useAppSnapshot } from '../src/state/store'
import { AppearanceContext, useTheme, type AppearancePref } from '../src/ui/theme'

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <AppProvider>
        <ThemedRoot />
      </AppProvider>
    </SafeAreaProvider>
  )
}

function ThemedRoot() {
  const snapshot = useAppSnapshot()
  // 外观偏好持久化在 store 里；老版本没有该字段时退回跟随系统。
  const appearance: AppearancePref = snapshot.appearance ?? 'system'
  return (
    <AppearanceContext.Provider value={appearance}>
      <ThemedNavigator />
    </AppearanceContext.Provider>
  )
}

function ThemedNavigator() {
  const theme = useTheme()

  useEffect(() => {
    // 开发期立刻暴露“镜像帧名 ≠ 协议帧名”的错误，而不是等它变成连不上。
    assertProtocolContract()
  }, [])

  return (
    <>
      <StatusBar style={theme.scheme === 'dark' ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: theme.colors.surface },
          headerTintColor: theme.colors.text,
          headerTitleStyle: { fontSize: 17, fontWeight: '600' },
          headerShadowVisible: false,
          contentStyle: { backgroundColor: theme.colors.background },
        }}
      >
        <Stack.Screen name="index" options={{ title: '我的助理' }} />
        <Stack.Screen name="scan" options={{ title: '添加电脑', presentation: 'modal' }} />
        <Stack.Screen name="settings" options={{ title: '设置' }} />
        <Stack.Screen name="assistant/[id]/index" options={{ title: '助理' }} />
        <Stack.Screen name="assistant/[id]/settings" options={{ title: '助理设置' }} />
      </Stack>
    </>
  )
}
