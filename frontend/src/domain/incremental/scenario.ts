/**
 * 演示场景引导：把「设备分析 device」与「群组对比 cohortcmp」两个现有模块的数据
 * 接入增量重算引擎。纯前端环境下用设备画像快照作为输入，输出落库到独立 localStorage 键，
 * 不影响既有 local-service 的清单数据。
 */
import {
  arbitrateConflict,
  applyProfileUpdates,
  buildReviewChecklist,
  getGroup,
  initGroup,
  recalculateIncrement,
  shrinkGroupSample,
  submitThresholdJob,
} from './engine'
import { MIN_SAMPLE_SIZE } from './statistics'
import type { ArbitrationOutcome, GroupDiffReport, GroupState, ProfileSnapshot, ReviewItem, ThresholdJob } from './types'

export const DEMO_GROUP_ID = 'cohort-small-sample'

/** 首版设备画像：两个画像样本充足，一个画像本身就是小样本。 */
export function baselineProfiles(): ProfileSnapshot[] {
  return [
    {
      profileId: 'DEVI-0001',
      deviceType: '移动端',
      os: 'Android',
      sampleSize: 120,
      behaviorHits: 72,
      contentVersion: 1,
      status: '已生成',
    },
    {
      profileId: 'DEVI-0002',
      deviceType: '桌面端',
      os: 'Windows',
      sampleSize: 96,
      behaviorHits: 40,
      contentVersion: 1,
      status: '已生成',
    },
    {
      profileId: 'DEVI-0003',
      deviceType: '平板',
      os: 'iPadOS',
      sampleSize: 12,
      behaviorHits: 5,
      contentVersion: 1,
      status: '分析中',
    },
  ]
}

/** 第二轮画像：仅 DEVI-0001 与 DEVI-0003 内容变更，DEVI-0002 保持稳定用于验证跨模块跳过。 */
export function updatedProfiles(): ProfileSnapshot[] {
  return [
    {
      profileId: 'DEVI-0001',
      deviceType: '移动端',
      os: 'Android',
      sampleSize: 130,
      behaviorHits: 91,
      contentVersion: 2,
      status: '已生成',
    },
    {
      profileId: 'DEVI-0002',
      deviceType: '桌面端',
      os: 'Windows',
      sampleSize: 96,
      behaviorHits: 40,
      contentVersion: 1,
      status: '已生成',
    },
    {
      profileId: 'DEVI-0003',
      deviceType: '平板',
      os: 'iPadOS',
      sampleSize: 14,
      behaviorHits: 6,
      contentVersion: 2,
      status: '分析中',
    },
  ]
}

export type ScenarioSummary = {
  state: GroupState
  report: GroupDiffReport
  review: ReviewItem[]
}

/** 初始化演示群组并跑一轮基线增量，返回首个可核对的场景状态。 */
export function bootstrapScenario(): ScenarioSummary {
  const existing = getGroup(DEMO_GROUP_ID)
  if (!existing) {
    initGroup(DEMO_GROUP_ID, baselineProfiles(), baselineProfiles(), MIN_SAMPLE_SIZE)
    applyProfileUpdates(DEMO_GROUP_ID, updatedProfiles())
    recalculateIncrement(DEMO_GROUP_ID, '场景初始化')
  }
  const state = getGroup(DEMO_GROUP_ID) as GroupState
  return {
    state,
    report: state.reports[state.reports.length - 1],
    review: buildReviewChecklist(DEMO_GROUP_ID),
  }
}

/** 触发一次阈值更新任务，返回任务与最新差异（重复提交由引擎去重）。 */
export function runThresholdJob(threshold: number): { job: ThresholdJob; report: GroupDiffReport; deduped: boolean } {
  return submitThresholdJob(DEMO_GROUP_ID, threshold)
}

/** 缩小一个设备群组的样本，随后重算，核对样本不足标注与旧效应值处置。 */
export function shrinkAndRecalculate(
  profileId: string,
  sampleSize: number,
  behaviorHits: number,
): ScenarioSummary {
  shrinkGroupSample(DEMO_GROUP_ID, profileId, sampleSize, behaviorHits)
  const report = recalculateIncrement(DEMO_GROUP_ID, '样本缩小复核')
  return {
    state: getGroup(DEMO_GROUP_ID) as GroupState,
    report,
    review: buildReviewChecklist(DEMO_GROUP_ID),
  }
}

/** 版本冲突仲裁入口：两条策略都返回带置信边界的受限报告与暂缓清单。 */
export function runArbitration(
  strategy: 'sample-limit' | 'historical-threshold',
  newThreshold = MIN_SAMPLE_SIZE,
  historicalThreshold = 50,
): ArbitrationOutcome {
  return arbitrateConflict({
    requestId: `ARB-${Date.now()}`,
    groupId: DEMO_GROUP_ID,
    strategy,
    newThreshold,
    historicalThreshold,
    requestedAt: Date.now(),
  })
}
