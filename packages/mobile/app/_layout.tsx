// 根布局：注册路由 + 挂上全局状态容器。
//
// 全局状态放在这里（而不是每个屏幕各自连一次），保证“一台电脑一条长连接”、
// 聊天页和列表页看到的是同一份状态。

import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { useEffect } from 'react'

import { assertProtocolContract } from '../src/protocol/runtime'
import { AppProvider } from '../src/state/store'
import { colors } from '../src/ui/theme'

export default function RootLayout() {
  useEffect(() => {
    // 开发期立刻暴露“镜像帧名 ≠ 协议帧名”的错误，而不是等它变成连不上。
    assertProtocolContract()
  }, [])

  return (
    <AppProvider>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.surface },
          headerTintColor: colors.text,
          headerTitleStyle: { fontSize: 17 },
          contentStyle: { backgroundColor: colors.background },
          headerShadowVisible: false,
        }}
      >
        <Stack.Screen name="index" options={{ title: '我的助理' }} />
        <Stack.Screen name="scan" options={{ title: '添加电脑', presentation: 'modal' }} />
        <Stack.Screen name="settings" options={{ title: '设置' }} />
        <Stack.Screen name="assistant/[id]/index" options={{ title: '助理' }} />
        <Stack.Screen name="assistant/[id]/settings" options={{ title: '助理设置' }} />
      </Stack>
    </AppProvider>
  )
}
