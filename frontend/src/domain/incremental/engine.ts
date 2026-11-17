/**
 * 增量重算引擎。
 *
 * 数据流（按现有调用链梳理的设备画像处理点）：
 *   设备分析 device 画像快照（previous/current）
 *     → recalculateIncrement：只挑内容变更的画像，稳定画像跨模块跳过
 *     → 增量设备行为差异报告 ProfileDiffEntry（带 Wilson 置信边界）
 *     → 增量更新的设备群组差异数据报告 GroupDiffReport（sourceVersion 沿用上一版）
 *     → 群组对比 cohortcmp 复核清单 buildReviewChecklist
 *
 * 并发与落库保证：
 *   - 两个阈值任务同时刷新同一小样本群组：同指纹任务合并，只提交一个最新差异，
 *     后到请求复用已完成置信判断（status=deduped）；
 *   - 同时提交的请求在同一同步执行单元内只写入一次报告，重复结果不再次落库。
 */
import { deltaMetric, MIN_SAMPLE_SIZE, wilsonInterval } from './statistics'
import type {
  ArbitrationOutcome,
  ArbitrationRequest,
  GroupDiffReport,
  GroupState,
  ProfileDiffEntry,
  ProfileSnapshot,
  ReviewItem,
  ThresholdJob,
} from './types'

const STORAGE_KEY = 'behavior-event-trace-hub:incremental'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function nowIso(): string {
  return new Date().toISOString()
}

function indexByProfile(snapshots: ProfileSnapshot[]): Map<string, ProfileSnapshot> {
  return new Map(snapshots.map((snapshot) => [snapshot.profileId, snapshot]))
}

function groupSampleSize(snapshots: ProfileSnapshot[]): number {
  return snapshots.reduce((sum, snapshot) => sum + snapshot.sampleSize, 0)
}

/** 画像是否稳定：内容版本未变即视为稳定画像，跨模块跳过，不进入增量对比。 */
export function isStableProfile(before: ProfileSnapshot | undefined, after: ProfileSnapshot): boolean {
  return Boolean(before && before.contentVersion === after.contentVersion)
}

/** 阈值任务指纹：同群组 + 同阈值 + 同画像内容版本，视为重复刷新。 */
function jobFingerprint(groupId: string, threshold: number, current: ProfileSnapshot[]): string {
  const versionSignature = current
    .map((snapshot) => `${snapshot.profileId}@${snapshot.contentVersion}`)
    .sort()
    .join('|')
  return `${groupId}#${threshold}#${versionSignature}`
}

function loadStates(): Record<string, GroupState> {
  if (typeof window === 'undefined' || !window.localStorage) {
    return {}
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    return {}
  }
  try {
    return JSON.parse(raw) as Record<string, GroupState>
  } catch {
    return {}
  }
}

let stateCache: Record<string, GroupState> | null = null

function allStates(): Record<string, GroupState> {
  if (stateCache === null) {
    stateCache = loadStates()
  }
  return stateCache
}

/** 落库动作集中在这一处：每次报告生成只调用一次，重复结果不会再次落库。 */
function persist(states: Record<string, GroupState>): void {
  stateCache = states
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(states))
  }
}

export function initGroup(
  groupId: string,
  previous: ProfileSnapshot[],
  current: ProfileSnapshot[],
  threshold = MIN_SAMPLE_SIZE,
): GroupState {
  const states = allStates()
  if (states[groupId]) {
    return states[groupId]
  }
  const seeded: GroupState = {
    groupId,
    previous: clone(previous),
    current: clone(current),
    threshold,
    reports: [],
    jobs: [],
    arbitrations: [],
    inflight: {},
    seq: 0,
  }
  persist({ ...states, [groupId]: seeded })
  return seeded
}

export function getGroup(groupId: string): GroupState | undefined {
  return allStates()[groupId]
}

export function listGroups(): GroupState[] {
  return Object.values(allStates())
}

export function resetGroup(groupId: string): void {
  const states = allStates()
  delete states[groupId]
  persist({ ...states })
}

export function resetAll(): void {
  persist({})
}

/**
 * 计算单个画像的增量差异条目。
 * 稳定画像直接 skipped；样本不足时 delta=null 且保留双侧置信边界。
 */
function diffOneProfile(
  before: ProfileSnapshot | undefined,
  after: ProfileSnapshot,
  sourceVersion: number,
): ProfileDiffEntry {
  const beforeMetric = before
    ? wilsonInterval(before.behaviorHits, before.sampleSize)
    : wilsonInterval(0, 0)
  const afterMetric = wilsonInterval(after.behaviorHits, after.sampleSize)

  if (isStableProfile(before, after)) {
    return {
      profileId: after.profileId,
      before: beforeMetric,
      after: afterMetric,
      delta: null,
      insufficient: afterMetric.insufficient,
      skipped: true,
      sourceVersion,
    }
  }

  return {
    profileId: after.profileId,
    before: beforeMetric,
    after: afterMetric,
    delta: deltaMetric(beforeMetric, afterMetric),
    insufficient: beforeMetric.insufficient || afterMetric.insufficient,
    skipped: false,
    sourceVersion,
  }
}

/**
 * 增量重算：只读取并对比发生变更的设备画像，输出一份群组差异报告。
 * 稳定画像不进入 entries；群组样本不足时报告标记 restricted。
 * 差异来源版本沿用上一版报告，首版以自身版本为基线。
 */
export function recalculateIncrement(
  groupId: string,
  trigger: string,
  thresholdOverride?: number,
): GroupDiffReport {
  const states = allStates()
  const state = states[groupId]
  if (!state) {
    throw new Error(`群组 ${groupId} 尚未初始化，无法增量重算`)
  }

  const threshold = thresholdOverride ?? state.threshold
  const beforeIndex = indexByProfile(state.previous)
  const previousReport = state.reports[state.reports.length - 1]

  // 只处理变更画像：稳定画像跨模块跳过，避免小样本群组上重复读取、过度精确对比。
  const changed = state.current.filter(
    (after) => !isStableProfile(beforeIndex.get(after.profileId), after),
  )

  const nextVersion = state.seq + 1
  // 来源保持上一版本：首版以自身版本为基线，之后始终沿用历史来源，不被本次刷新覆盖。
  const sourceVersion = previousReport ? previousReport.sourceVersion : nextVersion

  const entries = changed.map((after) =>
    diffOneProfile(beforeIndex.get(after.profileId), after, sourceVersion),
  )

  const totalSample = groupSampleSize(state.current)
  const report: GroupDiffReport = {
    id: `GDIF-${groupId}-${String(nextVersion).padStart(4, '0')}`,
    groupId,
    version: nextVersion,
    createdAt: nowIso(),
    entries,
    sampleSize: totalSample,
    insufficient: totalSample < threshold,
    threshold,
    sourceVersion,
    restricted: totalSample < threshold || entries.some((entry) => entry.insufficient),
    trigger,
  }

  const nextState: GroupState = {
    ...state,
    threshold,
    seq: nextVersion,
    // 本次重算后，当前画像成为下一轮的基线。
    previous: clone(state.current),
    reports: [...state.reports, report],
  }
  // 单次落库：一份增量报告只写一次。
  persist({ ...states, [groupId]: nextState })
  return report
}

/**
 * 提交阈值更新任务。
 *
 * 去重合并规则：
 * 1. 同指纹任务已在进行中 → 同时提交的请求合并，只写入一次报告，后到任务标记 deduped；
 * 2. 同指纹任务已完成 → 后到请求复用已完成的置信判断，不再重算、不再落库；
 * 3. 否则启动新任务，两个不同阈值刷新同一群组时各自产出一份最新差异。
 */
export function submitThresholdJob(
  groupId: string,
  threshold: number,
  requestedAt = Date.now(),
): { job: ThresholdJob; report: GroupDiffReport; deduped: boolean } {
  const states = allStates()
  const state = states[groupId]
  if (!state) {
    throw new Error(`群组 ${groupId} 尚未初始化，无法提交阈值任务`)
  }

  const fingerprint = jobFingerprint(groupId, threshold, state.current)
  const inflightJobId = state.inflight[fingerprint]

  if (inflightJobId) {
    const inflightJob = state.jobs.find((job) => job.jobId === inflightJobId)
    if (inflightJob?.status === 'done' && inflightJob.reportId) {
      // 后到请求复用已完成置信判断：直接回传既有报告，不触发第二次落库。
      const reusedReport = state.reports.find((report) => report.id === inflightJob.reportId)
      if (reusedReport) {
        const dedupedJob: ThresholdJob = {
          jobId: `JOB-${groupId}-${state.jobs.length + 1}`,
          groupId,
          threshold,
          requestedAt,
          status: 'deduped',
          reusedJobId: inflightJob.jobId,
          reportId: reusedReport.id,
        }
        const nextState: GroupState = { ...state, jobs: [...state.jobs, dedupedJob] }
        // 只登记任务轨迹，不新增差异报告（重复结果不再次落库）。
        persist({ ...states, [groupId]: nextState })
        return { job: dedupedJob, report: reusedReport, deduped: true }
      }
    }
  }

  // 新指纹：启动任务并同步完成置信判断，生成唯一一份最新差异。
  const jobId = inflightJobId ?? `JOB-${groupId}-${state.jobs.length + 1}`
  const report = recalculateIncrement(groupId, '阈值更新任务', threshold)

  const finishedJob: ThresholdJob = {
    jobId,
    groupId,
    threshold,
    requestedAt,
    status: 'done',
    reportId: report.id,
  }

  const latestState = getGroup(groupId) as GroupState
  const nextState: GroupState = {
    ...latestState,
    jobs: [...latestState.jobs.filter((job) => job.jobId !== jobId), finishedJob],
    inflight: { ...latestState.inflight, [fingerprint]: jobId },
  }
  persist({ ...allStates(), [groupId]: nextState })
  return { job: finishedJob, report, deduped: false }
}

/**
 * 应用新的画像版本（模拟设备分析侧画像变更后推送）。
 * 只替换 current，previous 保留为增量基线；调用方随后可触发增量重算。
 */
export function applyProfileUpdates(groupId: string, current: ProfileSnapshot[]): GroupState {
  const states = allStates()
  const state = states[groupId]
  if (!state) {
    throw new Error(`群组 ${groupId} 尚未初始化`)
  }
  const nextState: GroupState = { ...state, current: clone(current) }
  persist({ ...states, [groupId]: nextState })
  return nextState
}

/**
 * 缩小群组样本：调小指定画像的样本量与命中数，用于核对样本不足标注。
 */
export function shrinkGroupSample(
  groupId: string,
  profileId: string,
  sampleSize: number,
  behaviorHits: number,
): GroupState {
  const states = allStates()
  const state = states[groupId]
  if (!state) {
    throw new Error(`群组 ${groupId} 尚未初始化`)
  }
  const current = state.current.map((snapshot) =>
    snapshot.profileId === profileId
      ? {
          ...snapshot,
          sampleSize,
          behaviorHits,
          contentVersion: snapshot.contentVersion + 1,
        }
      : snapshot,
  )
  return applyProfileUpdates(groupId, current)
}

function buildRestrictedReport(
  state: GroupState,
  strategy: ArbitrationRequest['strategy'],
  threshold: number,
  version: number,
  sourceVersion: number,
): GroupDiffReport {
  const beforeIndex = indexByProfile(state.previous)
  const entries = state.current.map((after) =>
    diffOneProfile(beforeIndex.get(after.profileId), after, sourceVersion),
  )
  const totalSample = groupSampleSize(state.current)
  return {
    id: `GDIF-${state.groupId}-${String(version).padStart(4, '0')}`,
    groupId: state.groupId,
    version,
    createdAt: nowIso(),
    entries,
    sampleSize: totalSample,
    insufficient: totalSample < threshold,
    threshold,
    sourceVersion,
    // 仲裁路径一律产出受限差异报告：不足样本不会被包装成精确差异。
    restricted: true,
    trigger: `版本冲突仲裁:${strategy}`,
  }
}

/**
 * 版本冲突仲裁：小样本阈值调整与旧报告重新计算同时影响同一群组。
 *
 * 两条仲裁路径：
 * - sample-limit（沿样本不足限制展开）：以新阈值判定受限范围，历史阈值仅作对照；
 * - historical-threshold（沿历史阈值回看展开）：回看旧阈值口径，结论暂缓等待口径确认。
 * 两条路径都产出：带置信边界的受限差异报告 + 历史阈值对照 + 当前结论暂缓清单，
 * 并且都保留当前报告（preservedReportId 指向仲裁前最新报告，不覆盖、不包装）。
 */
export function arbitrateConflict(request: ArbitrationRequest): ArbitrationOutcome {
  const states = allStates()
  const state = states[request.groupId]
  if (!state) {
    throw new Error(`群组 ${request.groupId} 尚未初始化，无法仲裁`)
  }

  const previousReport = state.reports[state.reports.length - 1]
  const nextVersion = state.seq + 1
  const sourceVersion = previousReport ? previousReport.sourceVersion : nextVersion
  const preservedReportId = previousReport ? previousReport.id : 'none'

  const activeThreshold =
    request.strategy === 'sample-limit' ? request.newThreshold : request.historicalThreshold
  const restrictedReport = buildRestrictedReport(
    state,
    request.strategy,
    activeThreshold,
    nextVersion,
    sourceVersion,
  )

  // 历史阈值对照：用历史阈值回看群组总量是否充足，整体 Wilson 边界按真实总量计算。
  const totalHits = state.current.reduce((sum, snapshot) => sum + snapshot.behaviorHits, 0)
  const totalSample = groupSampleSize(state.current)
  const historicalMetric = wilsonInterval(totalHits, totalSample)
  const historicalComparison = {
    threshold: request.historicalThreshold,
    lower: historicalMetric.lower,
    upper: historicalMetric.upper,
    insufficient: totalSample < request.historicalThreshold,
  }

  // 当前结论暂缓清单：样本不足的画像，以及两条阈值口径判定不一致的画像。
  const suspendedConclusions = restrictedReport.entries
    .filter((entry) => {
      if (entry.insufficient) {
        return true
      }
      const underNew = entry.after.sampleSize < request.newThreshold
      const underHistorical = entry.after.sampleSize < request.historicalThreshold
      return underNew !== underHistorical
    })
    .map((entry) => entry.profileId)

  const outcome: ArbitrationOutcome = {
    requestId: request.requestId,
    groupId: request.groupId,
    strategy: request.strategy,
    restrictedReport,
    historicalComparison,
    suspendedConclusions,
    preservedReportId,
    decidedAt: Date.now(),
  }

  const nextState: GroupState = {
    ...state,
    seq: nextVersion,
    // 仲裁报告落库但标记 restricted；当前报告通过 preservedReportId 原样保留。
    reports: [...state.reports, restrictedReport],
    arbitrations: [...state.arbitrations, outcome],
  }
  persist({ ...states, [request.groupId]: nextState })
  return outcome
}

/**
 * 群组对比复核清单：接收增量群组差异报告中的增量设备行为差异条目。
 * - 跨模块跳过稳定设备画像（skipped 条目不进清单）；
 * - 来源版本随条目保持上一版本；
 * - 受限/样本不足条目标记 suspended，提醒结论暂缓。
 */
export function buildReviewChecklist(groupId: string): ReviewItem[] {
  const state = allStates()[groupId]
  if (!state) {
    return []
  }
  const latestReport = state.reports[state.reports.length - 1]
  if (!latestReport) {
    return []
  }
  return latestReport.entries
    .filter((entry) => !entry.skipped)
    .map((entry) => ({
      groupId,
      reportId: latestReport.id,
      version: latestReport.version,
      profileId: entry.profileId,
      insufficient: entry.insufficient,
      restricted: latestReport.restricted,
      delta: entry.delta,
      lower: entry.after.lower,
      upper: entry.after.upper,
      sourceVersion: entry.sourceVersion,
      trigger: latestReport.trigger,
      suspended: entry.insufficient || latestReport.restricted,
    }))
}
