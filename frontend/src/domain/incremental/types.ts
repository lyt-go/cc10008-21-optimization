/**
 * 增量重算领域模型：设备画像 → 设备行为差异报告 → 群组对比复核清单。
 *
 * 设计约束（对应样本不足处理需求）：
 * 1. 设备用户占比永远携带 Wilson 置信边界，小样本只产出「受限差异」，不包装成精确差异；
 * 2. 增量更新只写发生变更的设备画像，稳定画像跨模块跳过；
 * 3. 同一群组的并发阈值任务做去重合并，重复结果不再次落库；
 * 4. 群组差异来源（sourceVersion）始终沿用上一版本，不被增量刷新覆盖；
 * 5. 版本冲突沿「样本不足限制」或「历史阈值回看」两条仲裁路径展开，当前结论可暂缓。
 */

/** 设备画像某一版本的快照（设备分析模块的处理对象）。 */
export type ProfileSnapshot = {
  profileId: string
  deviceType: string
  os: string
  /** 该画像覆盖的设备用户数，群组样本量由各画像样本数汇总。 */
  sampleSize: number
  /** 行为指标命中数，用于计算行为命中率与用户占比。 */
  behaviorHits: number
  /** 画像内容版本，内容不变时版本不变，用于稳定画像跳过判断。 */
  contentVersion: number
  status: string
}

/** 设备用户占比：点估计 + Wilson 置信边界，边界永远保留。 */
export type ShareMetric = {
  point: number
  lower: number
  upper: number
  /** 参与计算的样本量。 */
  sampleSize: number
  /** 是否命中样本不足限制。 */
  insufficient: boolean
}

/** 单个设备画像在群组内的差异条目（增量设备行为差异报告的最小单元）。 */
export type ProfileDiffEntry = {
  profileId: string
  before: ShareMetric
  after: ShareMetric
  /** 点估计差值，仅在样本充足时可作为结论；样本不足时置为 null。 */
  delta: number | null
  insufficient: boolean
  /** 稳定画像不参与增量对比，直接跳过。 */
  skipped: boolean
  /** 差异来源沿用上一版本（见 GroupDiffReport.sourceVersion 说明）。 */
  sourceVersion: number
}

/** 增量更新的设备群组差异数据报告（群组对比模块的落库对象）。 */
export type GroupDiffReport = {
  id: string
  groupId: string
  version: number
  createdAt: string
  /** 本次增量实际发生变更的画像条目；稳定画像不在其中。 */
  entries: ProfileDiffEntry[]
  /** 群组总样本量。 */
  sampleSize: number
  insufficient: boolean
  threshold: number
  /**
   * 差异来源版本：始终保持上一版本报告的来源，不随增量刷新改写。
   * 首版报告以自身版本为来源基线。
   */
  sourceVersion: number
  /** 受限差异标记：样本不足时为 true，报告不得被解读为精确差异。 */
  restricted: boolean
  /** 触发本次增量的任务类型，用于审计。 */
  trigger: string
}

/** 阈值更新任务（两个阈值任务可能同时刷新同一小样本群组）。 */
export type ThresholdJob = {
  jobId: string
  groupId: string
  threshold: number
  requestedAt: number
  status: 'running' | 'done' | 'deduped'
  /** 去重时复用的已完成任务编号。 */
  reusedJobId?: string
  reportId?: string
}

/** 版本冲突仲裁请求：小样本阈值调整与旧报告重算同时影响同一群组。 */
export type ArbitrationRequest = {
  requestId: string
  groupId: string
  /** 仲裁策略：沿样本不足限制，或沿历史阈值回看。 */
  strategy: 'sample-limit' | 'historical-threshold'
  /** 阈值调整任务携带的新阈值。 */
  newThreshold: number
  /** 旧报告重算任务携带的历史阈值。 */
  historicalThreshold: number
  requestedAt: number
}

/** 仲裁产出：两条路径都必须带置信边界，且都保留当前报告。 */
export type ArbitrationOutcome = {
  requestId: string
  groupId: string
  strategy: 'sample-limit' | 'historical-threshold'
  restrictedReport: GroupDiffReport
  /** 历史阈值对照（sample-limit 路径也回填，保证两条路径产出结构一致）。 */
  historicalComparison: {
    threshold: number
    lower: number
    upper: number
    insufficient: boolean
  }
  /** 当前结论暂缓清单：样本不足或阈值口径冲突的画像编号。 */
  suspendedConclusions: string[]
  /** 当前报告原样保留，不把不足样本包装成精确差异。 */
  preservedReportId: string
  decidedAt: number
}

/** 群组对比复核清单中的一行。 */
export type ReviewItem = {
  groupId: string
  reportId: string
  version: number
  profileId: string
  insufficient: boolean
  restricted: boolean
  delta: number | null
  lower: number
  upper: number
  sourceVersion: number
  trigger: string
  suspended: boolean
}

/** 群组内存状态。 */
export type GroupState = {
  groupId: string
  /** 上一版本画像（before 基线）。 */
  previous: ProfileSnapshot[]
  /** 当前版本画像（after）。 */
  current: ProfileSnapshot[]
  threshold: number
  reports: GroupDiffReport[]
  jobs: ThresholdJob[]
  arbitrations: ArbitrationOutcome[]
  /** 进行中的阈值任务指纹 → 任务编号，供并发去重与复用。 */
  inflight: Record<string, string>
  seq: number
}
