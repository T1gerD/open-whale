// React 与状态容器之间的粘合层。
//
// 组件只从这里拿数据，不直接 new AppStore：这样测试和屏幕都能共用同一份连接与聊天状态。
// 用 useSyncExternalStore 而不是 Context + useState，是为了让 store 的变更（包括每秒的
// 电源倒计时、流式 delta）以最小代价传到 UI。

import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react'

import { AppStore, type AppSnapshot, type AssistantView } from './app-store'

const StoreContext = createContext<AppStore | null>(null)

export function AppProvider({ children }: { children: ReactNode }) {
  const store = useMemo(() => new AppStore(), [])
  useEffect(() => {
    // init 内部自己吞异常并写进 snapshot.lastError，不会抛出打断首屏。
    void store.init()
  }, [store])
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>
}

export function useAppStore(): AppStore {
  const store = useContext(StoreContext)
  if (!store) throw new Error('useAppStore 必须在 AppProvider 内使用')
  return store
}

export function useAppSnapshot(): AppSnapshot {
  const store = useAppStore()
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}

export function useAssistantView(assistantId: string | undefined): AssistantView | undefined {
  const snapshot = useAppSnapshot()
  if (!assistantId) return undefined
  return snapshot.assistants.find(view => view.assistant.id === assistantId)
}
