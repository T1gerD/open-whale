// 结构化提问卡片（v3.0.0）：把电脑端转发来的 `question/ask` 渲染成可作答的表单。
//
// 与审批卡的区别：一批里可能有多道题、每道题有选项（单选/多选）和「其他」输入，
// 答案要**一次性整批提交**（DSH 要求每个问题恰好一条）。组件只负责草稿和渲染，
// 拼包/校验在 `core/questions.mts`，发送在 store.answerQuestion。
//
// 过期语义：前台等待结束后电脑端会交回桌面，但 `canAnswerLate` 的提问仍然可以补答，
// 所以过期只影响倒计时颜色和是否还能提交，不直接销毁卡片（销毁由 resolved 帧负责）。

import { useEffect, useMemo, useState } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'

import {
  formatQuestionCountdown,
  questionRemainingMs,
  setQuestionCustom,
  toggleQuestionOption,
  type QuestionDraft,
  type QuestionPrompt,
} from '../core/questions.mts'
import { font, radius, spacing, useTheme, useThemedStyles, type Theme } from './theme'

export function QuestionCard({
  prompt,
  disabled,
  onSubmit,
  onDismiss,
}: {
  prompt: QuestionPrompt
  /** 离线时不能提交（电脑端也已经把问题交回桌面）。 */
  disabled: boolean
  onSubmit: (draft: QuestionDraft) => void
  /** 过期且不能补答时，允许用户主动收起（电脑端不会再推 resolved 的极端情况）。 */
  onDismiss?: () => void
}) {
  const theme = useTheme()
  const styles = useThemedStyles(createQuestionStyles)
  const [draft, setDraft] = useState<QuestionDraft>({})
  const [now, setNow] = useState(() => Date.now())

  // 换了一条提问就重置草稿（questionId 是稳定的批次身份）。
  useEffect(() => {
    setDraft({})
  }, [prompt.questionId])

  const remaining = questionRemainingMs(prompt, now)
  const expired = remaining !== undefined && remaining === 0
  const late = expired && prompt.canAnswerLate
  const closed = expired && !prompt.canAnswerLate
  const countdown = formatQuestionCountdown(remaining)

  // 每秒刷新倒计时；卡片收起后自动停。
  useEffect(() => {
    if (remaining === undefined || closed) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [remaining === undefined, closed])

  const multi = useMemo(() => prompt.items.some(item => item.multiSelect === true), [prompt.items])
  const planReview = useMemo(() => prompt.items.some(item => item.intent?.kind === 'plan-review'), [prompt.items])

  return (
    <View style={[styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}>
      <View style={styles.head}>
        <View style={styles.headLeft}>
          <Text style={styles.title}>{planReview ? '计划需要你确认' : '需要你的回答'}</Text>
          {multi ? <Text style={styles.hint}>可多选</Text> : null}
        </View>
        {countdown ? (
          <Text style={[styles.countdown, { color: expired ? theme.colors.danger : theme.colors.textMuted }]}>
            {closed ? '已交回电脑' : late ? `可补答 · ${countdown}` : countdown}
          </Text>
        ) : null}
      </View>

      {prompt.items.map((item, index) => (
        <View key={item.id} style={styles.item}>
          <Text style={styles.question}>
            {prompt.items.length > 1 ? `${index + 1}. ` : ''}
            {item.question}
          </Text>
          {item.detail ? <Text style={styles.detail}>{item.detail}</Text> : null}

          {item.options?.length ? (
            <View style={styles.options}>
              {item.options.map(option => {
                const selected = (draft[item.id]?.selected ?? []).includes(option.label)
                const approve = item.intent?.kind === 'plan-review' && item.intent.approve === option.label
                return (
                  <Pressable
                    key={option.label}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    disabled={closed}
                    onPress={() => setDraft(current => toggleQuestionOption(current, item, option.label))}
                    style={({ pressed }) => [
                      styles.option,
                      {
                        borderColor: selected ? theme.colors.accent : theme.colors.border,
                        backgroundColor: selected ? theme.colors.accentSoft : 'transparent',
                        opacity: closed ? 0.5 : 1,
                      },
                      approve && styles.approveOption,
                      pressed && styles.pressed,
                    ]}
                  >
                    <Text style={[styles.optionLabel, { color: selected ? theme.colors.accent : theme.colors.text }]}>
                      {selected ? '✓ ' : ''}
                      {option.label}
                    </Text>
                    {approve ? <Text style={styles.approveBadge}>同意</Text> : null}
                    {option.description ? <Text style={styles.optionDesc}>{option.description}</Text> : null}
                  </Pressable>
                )
              })}
            </View>
          ) : null}

          <TextInput
            value={draft[item.id]?.custom ?? ''}
            onChangeText={value => setDraft(current => setQuestionCustom(current, item, value))}
            placeholder={item.options?.length ? '其他（可选，填写后覆盖上面的选择）' : '输入你的回答'}
            placeholderTextColor={theme.colors.textFaint}
            editable={!closed}
            multiline
            style={[
              styles.customInput,
              { color: theme.colors.text, borderColor: theme.colors.border, backgroundColor: theme.colors.surfaceAlt },
            ]}
          />
        </View>
      ))}

      <View style={styles.footer}>
        {closed ? (
          <View style={styles.footerRow}>
            <Text style={styles.closedHint}>这一问已经交回电脑处理。</Text>
            {onDismiss ? (
              <Pressable accessibilityRole="button" onPress={onDismiss} hitSlop={8}>
                <Text style={[styles.dismiss, { color: theme.colors.textMuted }]}>知道了</Text>
              </Pressable>
            ) : null}
          </View>
        ) : (
          <Pressable
            accessibilityRole="button"
            disabled={disabled}
            onPress={() => onSubmit(draft)}
            style={({ pressed }) => [
              styles.submit,
              { backgroundColor: theme.colors.accent, opacity: disabled ? 0.4 : 1 },
              pressed && styles.pressed,
            ]}
          >
            <Text style={[styles.submitLabel, { color: '#FFFFFF' }]}>{disabled ? '离线，连上后再提交' : '提交回答'}</Text>
          </Pressable>
        )}
        <Text style={styles.footHint}>没答的问题会按「跳过」提交；提交后电脑端继续执行。</Text>
      </View>
    </View>
  )
}

const createQuestionStyles = (theme: Theme) =>
  StyleSheet.create({
    card: {
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: radius.lg,
      padding: spacing.md,
      gap: spacing.md,
      ...theme.shadow.card,
    },
    head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
    headLeft: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexShrink: 1 },
    title: { color: theme.colors.text, fontSize: font.callout, fontWeight: '700' },
    hint: { color: theme.colors.textMuted, fontSize: font.tiny },
    countdown: { fontSize: font.tiny, fontWeight: '600', fontVariant: ['tabular-nums'] },
    item: { gap: spacing.sm },
    question: { color: theme.colors.text, fontSize: font.body, lineHeight: 22, fontWeight: '600' },
    detail: { color: theme.colors.textSecondary, fontSize: font.small, lineHeight: 20 },
    options: { gap: spacing.sm },
    option: {
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: radius.md,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      gap: 2,
    },
    approveOption: { borderStyle: 'dashed' },
    optionLabel: { fontSize: font.small, fontWeight: '600' },
    approveBadge: { color: theme.colors.accent, fontSize: font.tiny, fontWeight: '700' },
    optionDesc: { color: theme.colors.textMuted, fontSize: font.tiny, lineHeight: 17 },
    customInput: {
      minHeight: 44,
      maxHeight: 120,
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: radius.md,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      fontSize: font.small,
      textAlignVertical: 'top',
    },
    footer: { gap: spacing.xs, marginTop: spacing.xs },
    footerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
    closedHint: { color: theme.colors.textMuted, fontSize: font.small, flexShrink: 1 },
    dismiss: { fontSize: font.small, fontWeight: '600' },
    submit: {
      minHeight: 44,
      borderRadius: radius.md,
      alignItems: 'center',
      justifyContent: 'center',
    },
    submitLabel: { fontSize: font.body, fontWeight: '700' },
    footHint: { color: theme.colors.textFaint, fontSize: font.tiny },
    pressed: { opacity: 0.82 },
  })
