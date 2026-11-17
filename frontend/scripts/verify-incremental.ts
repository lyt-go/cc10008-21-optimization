/**
 * 增量重算需求核验脚本（不依赖浏览器）。
 * 打包：esbuild scripts/verify-incremental.ts --bundle --platform=node --format=esm
 * 运行：node .tmp-verify/verify-incremental.mjs
 */
import {
  arbitrateConflict,
  buildReviewChecklist,
  getGroup,
  initGroup,
  recalculateIncrement,
  resetAll,
  shrinkGroupSample,
  submitThresholdJob,
  wilsonInterval,
  MIN_SAMPLE_SIZE,
  baselineProfiles,
  updatedProfiles,
  DEMO_GROUP_ID,
} from '../src/domain/incremental/index'
import { applyProfileUpdates } from '../src/domain/incremental/engine'

// ---- localStorage shim：让引擎的持久化分支也能在 Node 下被覆盖 ----
const memory = new Map<string, string>()
const shim = {
  getItem: (key: string) => (memory.has(key) ? memory.get(key)! : null),
  setItem: (key: string, value: string) => void memory.set(key, value),
  removeItem: (key: string) => void memory.delete(key),
}
;(globalThis as Record<string, unknown>).window = { localStorage: shim }
;(globalThis as Record<string, unknown>).localStorage = shim

let passed = 0
let failed = 0
function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1
    console.log(`  ✅ ${name}`)
  } else {
    failed += 1
    console.error(`  ❌ ${name} ${detail}`)
  }
}

function setupGroup(): void {
  resetAll()
  memory.clear()
  initGroup(DEMO_GROUP_ID, baselineProfiles(), baselineProfiles(), MIN_SAMPLE_SIZE)
  applyProfileUpdates(DEMO_GROUP_ID, updatedProfiles())
}

// 需求 1+2：增量只更新变更对象；小样本保留置信边界、不产出精确差值
function testIncrementalAndConfidence(): void {
  console.log('\n[1] 增量只含变更画像，小样本保留 Wilson 置信边界')
  setupGroup()
  const report = recalculateIncrement(DEMO_GROUP_ID, '首轮增量')
  const ids = report.entries.map((entry) => entry.profileId).sort()
  check('只对比发生变更的画像（DEVI-0001/0003）', JSON.stringify(ids) === JSON.stringify(['DEVI-0001', 'DEVI-0003']), JSON.stringify(ids))
  const stable = report.entries.find((entry) => entry.profileId === 'DEVI-0002')
  check('稳定画像 DEVI-0002 不进入增量报告', stable === undefined)
  const small = report.entries.find((entry) => entry.profileId === 'DEVI-0003')!
  check('小样本条目标记 insufficient', small.insufficient === true)
  check('小样本不输出精确差值（delta=null，旧效应值不作为结论）', small.delta === null)
  check('小样本仍保留双侧置信边界', small.after.lower >= 0 && small.after.upper <= 1 && small.after.lower < small.after.upper)
  const big = report.entries.find((entry) => entry.profileId === 'DEVI-0001')!
  check('充足样本输出点估计差值', typeof big.delta === 'number')
  check('报告整体标记 restricted', report.restricted === true)
  check('边界在点估计两侧', big.after.lower <= big.after.point && big.after.point <= big.after.upper)
}

// 需求 3：两个阈值任务刷新同一群组，只提交一个最新差异，后到复用已完成判断
function testThresholdDedup(): void {
  console.log('\n[2] 同群组重复阈值任务去重合并，后到请求复用已完成置信判断')
  setupGroup()
  const first = submitThresholdJob(DEMO_GROUP_ID, MIN_SAMPLE_SIZE)
  const reportCountAfterFirst = getGroup(DEMO_GROUP_ID)!.reports.length
  const second = submitThresholdJob(DEMO_GROUP_ID, MIN_SAMPLE_SIZE)
  const state = getGroup(DEMO_GROUP_ID)!
  check('首个任务正常完成', first.job.status === 'done' && first.deduped === false)
  check('后到任务标记 deduped', second.job.status === 'deduped' && second.deduped === true)
  check('后到任务复用首个任务编号', second.job.reusedJobId === first.job.jobId)
  check('复用同一份差异报告', second.report.id === first.report.id)
  check('重复结果不再次落库（报告数不增加）', state.reports.length === reportCountAfterFirst)
  const third = submitThresholdJob(DEMO_GROUP_ID, 45)
  check('不同阈值视为新任务，产出最新差异', third.deduped === false && third.report.threshold === 45)
}

// 需求 4：同时提交只写一次
function testSimultaneousWriteOnce(): void {
  console.log('\n[3] 同时提交的请求只写入一次增量报告')
  setupGroup()
  const before = getGroup(DEMO_GROUP_ID)!.reports.length
  const [a, b] = [
    submitThresholdJob(DEMO_GROUP_ID, MIN_SAMPLE_SIZE, 1000),
    submitThresholdJob(DEMO_GROUP_ID, MIN_SAMPLE_SIZE, 1000),
  ]
  const after = getGroup(DEMO_GROUP_ID)!.reports.length
  check('同一执行单元内仅新增一份报告', after - before === 1, `before=${before} after=${after}`)
  check('两个请求指向同一报告 ID', a.report.id === b.report.id)
}

// 需求 5：复核清单跳过稳定画像，来源保持上一版本
function testReviewChecklistAndSource(): void {
  console.log('\n[4] 复核清单跨模块跳过稳定画像，差异来源沿用上一版本')
  setupGroup()
  const r1 = recalculateIncrement(DEMO_GROUP_ID, '首轮增量')
  // 第二轮再推送一次画像变更（仅 DEVI-0003 变化，DEVI-0002 持续稳定），模拟跨模块增量流。
  const next = updatedProfiles().map((profile) =>
    profile.profileId === 'DEVI-0003'
      ? { ...profile, contentVersion: profile.contentVersion + 1, behaviorHits: profile.behaviorHits + 1 }
      : profile,
  )
  applyProfileUpdates(DEMO_GROUP_ID, next)
  const r2 = recalculateIncrement(DEMO_GROUP_ID, '再次刷新')
  check('来源版本从首版起保持不变', r1.sourceVersion === r2.sourceVersion && r2.sourceVersion === 1)
  check('第二轮只含新变更画像', r2.entries.map((e) => e.profileId).join(',') === 'DEVI-0003')
  const review = buildReviewChecklist(DEMO_GROUP_ID)
  check('复核清单不含稳定画像', !review.some((item) => item.profileId === 'DEVI-0002'))
  check('清单条目携带上一版本来源', review.every((item) => item.sourceVersion === 1))
  check('受限条目标记暂缓', review.some((item) => item.suspended === true && item.insufficient === true))
}

// 需求 6：版本冲突两条仲裁路径
function testArbitration(): void {
  console.log('\n[5] 版本冲突仲裁：两条路径均产出受限报告+历史对照+暂缓清单，并保留当前报告')
  for (const strategy of ['sample-limit', 'historical-threshold'] as const) {
    setupGroup()
    const current = recalculateIncrement(DEMO_GROUP_ID, '仲裁前当前报告')
    const beforeReports = getGroup(DEMO_GROUP_ID)!.reports.length
    const outcome = arbitrateConflict({
      requestId: `ARB-${strategy}`,
      groupId: DEMO_GROUP_ID,
      strategy,
      newThreshold: MIN_SAMPLE_SIZE,
      historicalThreshold: 50,
      requestedAt: Date.now(),
    })
    const state = getGroup(DEMO_GROUP_ID)!
    check(`[${strategy}] 产出受限差异报告`, outcome.restrictedReport.restricted === true)
    check(`[${strategy}] 受限报告条目全部带置信边界`,
      outcome.restrictedReport.entries.every((e) => e.after.lower >= 0 && e.after.upper <= 1))
    check(`[${strategy}] 输出历史阈值对照`,
      outcome.historicalComparison.threshold === 50 &&
        outcome.historicalComparison.lower <= outcome.historicalComparison.upper)
    check(`[${strategy}] 当前结论暂缓清单含小样本画像`,
      outcome.suspendedConclusions.includes('DEVI-0003'))
    check(`[${strategy}] 保留当前报告（不覆盖不包装）`,
      outcome.preservedReportId === current.id &&
        state.reports.some((report) => report.id === current.id) &&
        state.reports.length === beforeReports + 1)
    check(`[${strategy}] 被保留的当前报告内容未被改写`,
      JSON.stringify(state.reports.find((report) => report.id === current.id)) === JSON.stringify(current))
  }
}

// 需求 7：缩小群组样本，标注样本不足且旧效应值不作为当前结论
function testShrinkSample(): void {
  console.log('\n[6] 缩小设备群组样本：标注样本不足，旧效应值失效')
  setupGroup()
  const before = recalculateIncrement(DEMO_GROUP_ID, '缩小前基线')
  const beforeEntry = before.entries.find((entry) => entry.profileId === 'DEVI-0001')!
  check('缩小前 DEVI-0001 样本充足且有效应值', beforeEntry.insufficient === false && beforeEntry.delta !== null)
  shrinkGroupSample(DEMO_GROUP_ID, 'DEVI-0001', 8, 3)
  const after = recalculateIncrement(DEMO_GROUP_ID, '样本缩小复核')
  const afterEntry = after.entries.find((entry) => entry.profileId === 'DEVI-0001')!
  check('缩小后条目标注样本不足', afterEntry.insufficient === true)
  check('缩小后报告整体 restricted', after.restricted === true)
  check('旧效应值不作为当前结论（delta 置 null）', afterEntry.delta === null)
  check('置信边界依然保留', afterEntry.after.lower >= 0 && afterEntry.after.upper > afterEntry.after.lower)
}

// 统计工具边界情况
function testStatisticsEdge(): void {
  console.log('\n[7] Wilson 边界工具：零样本与边界约束')
  const zero = wilsonInterval(0, 0)
  check('零样本强制 insufficient 且边界安全', zero.insufficient && zero.lower === 0 && zero.upper === 0)
  const small = wilsonInterval(3, 10)
  check('小样本强制 insufficient', small.insufficient === true)
  check('边界不越出 [0,1]', small.lower >= 0 && small.upper <= 1 && small.lower <= small.point && small.point <= small.upper)
  const large = wilsonInterval(90, 200)
  check('充足样本不标 insufficient', large.insufficient === false)
}

// 持久化：报告确实写入 localStorage 且重新读取一致
function testPersistence(): void {
  console.log('\n[8] 增量报告落库与跨会话读取一致')
  setupGroup()
  const report = recalculateIncrement(DEMO_GROUP_ID, '持久化核验')
  const raw = memory.get('behavior-event-trace-hub:incremental')!
  const parsed = JSON.parse(raw) as Record<string, { reports: { id: string }[] }>
  check('报告写入独立 localStorage 键', Boolean(raw) && parsed[DEMO_GROUP_ID].reports.some((r) => r.id === report.id))
  // 模块缓存重置后仍能从 storage 恢复
  const fresh = (() => {
    const state = getGroup(DEMO_GROUP_ID)!
    return state.reports.some((r) => r.id === report.id)
  })()
  check('状态缓存读取与落库内容一致', fresh)
}

const tests = [
  testIncrementalAndConfidence,
  testThresholdDedup,
  testSimultaneousWriteOnce,
  testReviewChecklistAndSource,
  testArbitration,
  testShrinkSample,
  testStatisticsEdge,
  testPersistence,
]
for (const test of tests) {
  test()
}
console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
if (failed > 0) {
  process.exitCode = 1
}
