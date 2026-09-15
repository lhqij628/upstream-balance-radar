export type AlertLevels = { level1: number; level2: number; level3: number }
type ChannelAlerts = { lowBalanceThreshold: number; alertLevels?: AlertLevels | null }

export function normalizedThresholds(account: ChannelAlerts, levels: AlertLevels): AlertLevels {
  if (account.alertLevels) return { ...account.alertLevels }
  const level1 = account.lowBalanceThreshold > 0 ? account.lowBalanceThreshold : levels.level1
  const level2 = Math.min(levels.level2, level1)
  return { level1, level2, level3: Math.min(levels.level3, level2) }
}

export function validAlertLevels(levels: AlertLevels) {
  return Object.values(levels).every((value) => Number.isFinite(value) && value >= 0)
    && levels.level1 > levels.level2 && levels.level2 > levels.level3
}

export function alertLevelForBalance(balance: number | null, ok: boolean, levels: AlertLevels) {
  if (!ok || balance === null || !Number.isFinite(balance)) return 0
  if (balance <= levels.level3) return 3
  if (balance <= levels.level2) return 2
  if (balance <= levels.level1) return 1
  return 0
}
