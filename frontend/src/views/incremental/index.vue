<template>
  <section class="page" data-module="incremental">
    <header class="page-head">
      <div>
        <h2>增量重算与小样本置信边界</h2>
        <p class="page-desc">
          设备画像 → 增量设备行为差异报告 → 群组对比复核清单。小样本只产出带 Wilson 置信边界的受限差异，
          重复阈值任务去重合并，冲突仲裁沿样本不足限制或历史阈值回看展开。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="bootstrap">加载/恢复场景</button>
        <button class="btn" type="button" @click="resetScenario">重置场景</button>
      </div>
    </header>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">群组总样本量</span>
        <strong class="stat-value" :class="{ warn: groupInsufficient }">{{ totalSample }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">当前阈值</span>
        <strong class="stat-value">{{ state?.threshold ?? '—' }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">已落库差异报告</span>
        <strong class="stat-value">{{ state?.reports.length ?? 0 }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">阈值任务（含去重）</span>
        <strong class="stat-value">{{ state?.jobs.length ?? 0 }}</strong>
      </article>
    </div>

    <div class="action-panel">
      <div class="action-group">
        <span class="action-title">阈值更新任务（重复提交自动去重）</span>
        <button class="btn" type="button" @click="singleJob(30)">提交阈值任务 30</button>
        <button class="btn" type="button" @click="singleJob(45)">提交阈值任务 45</button>
        <button class="btn" type="button" @click="simultaneousJobs">同时提交两个相同请求</button>
      </div>
      <div class="action-group">
        <span class="action-title">样本不足处理</span>
        <button class="btn" type="button" @click="shrinkSample">缩小 DEVI-0001 样本到 8</button>
      </div>
      <div class="action-group">
        <span class="action-title">版本冲突仲裁（保留当前报告）</span>
        <button class="btn" type="button" @click="arbitrate('sample-limit')">沿样本不足限制仲裁</button>
        <button class="btn" type="button" @click="arbitrate('historical-threshold')">沿历史阈值回看仲裁</button>
      </div>
    </div>

    <p v-if="message" class="action-message">{{ message }}</p>

    <h3 class="section-title">设备画像处理点（当前版本）</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>画像编号</th>
          <th>设备类型 / 系统</th>
          <th>样本量</th>
          <th>行为命中</th>
          <th>命中率点估计</th>
          <th>Wilson 置信边界</th>
          <th>内容版本</th>
          <th>样本判定</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="snapshot in snapshots" :key="snapshot.profileId">
          <td>{{ snapshot.profileId }}</td>
          <td>{{ snapshot.deviceType }} / {{ snapshot.os }}</td>
          <td>{{ snapshot.sampleSize }}</td>
          <td>{{ snapshot.behaviorHits }}</td>
          <td>{{ pct(metricOf(snapshot).point) }}</td>
          <td>[{{ pct(metricOf(snapshot).lower) }}, {{ pct(metricOf(snapshot).upper) }}]</td>
          <td>v{{ snapshot.contentVersion }}</td>
          <td>
            <span :class="metricOf(snapshot).insufficient ? 'tag tag-warn' : 'tag tag-ok'">
              {{ metricOf(snapshot).insufficient ? '样本不足' : '样本充足' }}
            </span>
          </td>
        </tr>
      </tbody>
    </table>

    <h3 class="section-title">最新增量报告（增量更新的设备群组差异数据报告）</h3>
    <table v-if="latestReport" class="data-table">
      <thead>
        <tr>
          <th>画像编号</th>
          <th>变更前占比 [边界]</th>
          <th>变更后占比 [边界]</th>
          <th>增量差值</th>
          <th>样本不足</th>
          <th>跳过</th>
          <th>差异来源版本</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="entry in latestReport.entries" :key="entry.profileId">
          <td>{{ entry.profileId }}</td>
          <td>{{ pct(entry.before.point) }} [{{ pct(entry.before.lower) }}, {{ pct(entry.before.upper) }}]</td>
          <td>{{ pct(entry.after.point) }} [{{ pct(entry.after.lower) }}, {{ pct(entry.after.upper) }}]</td>
          <td>
            <span v-if="entry.delta === null" class="tag tag-warn">结论暂缓</span>
            <span v-else>{{ pct(entry.delta) }}</span>
          </td>
          <td>{{ entry.insufficient ? '是' : '否' }}</td>
          <td>{{ entry.skipped ? '稳定画像跳过' : '否' }}</td>
          <td>v{{ entry.sourceVersion }}</td>
        </tr>
        <tr v-if="!latestReport.entries.length">
          <td colspan="7" class="empty-state">本轮无变更画像，未产生增量条目（稳定画像跨模块跳过）</td>
        </tr>
      </tbody>
    </table>
    <p v-if="latestReport" class="report-meta">
      报告 {{ latestReport.id }} · 版本 v{{ latestReport.version }} · 触发：{{ latestReport.trigger }} ·
      阈值 {{ latestReport.threshold }} · 群组样本 {{ latestReport.sampleSize }} ·
      来源保持 <strong>v{{ latestReport.sourceVersion }}</strong> ·
      <span :class="latestReport.restricted ? 'tag tag-warn' : 'tag tag-ok'">
        {{ latestReport.restricted ? '受限差异报告（不得解读为精确差异）' : '常规差异报告' }}
      </span>
    </p>

    <h3 class="section-title">群组对比复核清单（接收增量设备行为差异报告）</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>报告</th>
          <th>画像编号</th>
          <th>置信边界</th>
          <th>差值结论</th>
          <th>来源版本</th>
          <th>触发任务</th>
          <th>复核状态</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in review" :key="`${item.reportId}-${item.profileId}`">
          <td>{{ item.reportId }}</td>
          <td>{{ item.profileId }}</td>
          <td>[{{ pct(item.lower) }}, {{ pct(item.upper) }}]</td>
          <td>
            <span v-if="item.delta === null" class="tag tag-warn">旧效应值不作为当前结论</span>
            <span v-else>{{ pct(item.delta) }}</span>
          </td>
          <td>v{{ item.sourceVersion }}</td>
          <td>{{ item.trigger }}</td>
          <td>
            <span :class="item.suspended ? 'tag tag-warn' : 'tag tag-ok'">
              {{ item.suspended ? '结论暂缓' : '可复核' }}
            </span>
          </td>
        </tr>
        <tr v-if="!review.length">
          <td colspan="7" class="empty-state">暂无复核条目</td>
        </tr>
      </tbody>
    </table>

    <h3 class="section-title">阈值更新任务去重轨迹</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>任务编号</th>
          <th>阈值</th>
          <th>状态</th>
          <th>复用任务</th>
          <th>差异报告</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="job in jobs" :key="job.jobId">
          <td>{{ job.jobId }}</td>
          <td>{{ job.threshold }}</td>
          <td>
            <span :class="job.status === 'deduped' ? 'tag tag-warn' : 'tag tag-ok'">
              {{ job.status === 'deduped' ? '去重复用' : '已完成' }}
            </span>
          </td>
          <td>{{ job.reusedJobId ?? '—' }}</td>
          <td>{{ job.reportId ?? '—' }}</td>
        </tr>
        <tr v-if="!jobs.length">
          <td colspan="5" class="empty-state">暂无阈值任务</td>
        </tr>
      </tbody>
    </table>

    <h3 class="section-title">版本冲突仲裁记录</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>请求</th>
          <th>仲裁路径</th>
          <th>受限报告</th>
          <th>历史阈值对照 [边界]</th>
          <th>暂缓清单</th>
          <th>保留的当前报告</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="outcome in arbitrations" :key="outcome.requestId">
          <td>{{ outcome.requestId }}</td>
          <td>{{ outcome.strategy === 'sample-limit' ? '样本不足限制' : '历史阈值回看' }}</td>
          <td>
            {{ outcome.restrictedReport.id }}
            <span class="tag tag-warn">受限</span>
          </td>
          <td>
            阈值 {{ outcome.historicalComparison.threshold }} ·
            [{{ pct(outcome.historicalComparison.lower) }}, {{ pct(outcome.historicalComparison.upper) }}] ·
            {{ outcome.historicalComparison.insufficient ? '历史口径下不足' : '历史口径下充足' }}
          </td>
          <td>{{ outcome.suspendedConclusions.join('、') || '—' }}</td>
          <td>{{ outcome.preservedReportId }}</td>
        </tr>
        <tr v-if="!arbitrations.length">
          <td colspan="6" class="empty-state">暂无仲裁记录</td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  bootstrapScenario,
  runArbitration,
  runThresholdJob,
  shrinkAndRecalculate,
} from '@/domain/incremental/scenario'
import {
  buildReviewChecklist,
  getGroup,
  resetGroup,
} from '@/domain/incremental/engine'
import { wilsonInterval } from '@/domain/incremental/statistics'
import { DEMO_GROUP_ID } from '@/domain/incremental/scenario'
import type {
  ArbitrationOutcome,
  GroupState,
  ProfileSnapshot,
  ReviewItem,
  ThresholdJob,
} from '@/domain/incremental/types'

const state = ref<GroupState | undefined>()
const review = ref<ReviewItem[]>([])
const jobs = ref<ThresholdJob[]>([])
const arbitrations = ref<ArbitrationOutcome[]>([])
const message = ref('')

const snapshots = computed<ProfileSnapshot[]>(() => state.value?.current ?? [])
const latestReport = computed(() => {
  const reports = state.value?.reports ?? []
  return reports[reports.length - 1]
})
const totalSample = computed(() =>
  snapshots.value.reduce((sum, snapshot) => sum + snapshot.sampleSize, 0),
)
const groupInsufficient = computed(() =>
  Boolean(state.value && totalSample.value < state.value.threshold),
)

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function metricOf(snapshot: ProfileSnapshot) {
  return wilsonInterval(snapshot.behaviorHits, snapshot.sampleSize)
}

function refresh(notice = ''): void {
  state.value = getGroup(DEMO_GROUP_ID)
  review.value = buildReview()
  jobs.value = state.value?.jobs ?? []
  arbitrations.value = state.value?.arbitrations ?? []
  if (notice) {
    message.value = notice
  }
}

function buildReview(): ReviewItem[] {
  // 复核清单由引擎统一构建，页面不做业务判断。
  return buildReviewChecklist(DEMO_GROUP_ID)
}

function bootstrap(): void {
  const summary = bootstrapScenario()
  state.value = summary.state
  refresh('场景已加载：仅变更画像进入增量，稳定画像 DEVI-0002 跨模块跳过')
}

function resetScenario(): void {
  resetGroup(DEMO_GROUP_ID)
  bootstrap()
  message.value = '场景已重置并重新播种'
}

function singleJob(threshold: number): void {
  const result = runThresholdJob(threshold)
  refresh(
    result.deduped
      ? `任务 ${result.job.jobId} 复用已完成任务 ${result.job.reusedJobId} 的置信判断，未重复落库`
      : `任务 ${result.job.jobId} 完成，产出最新差异 ${result.report.id}`,
  )
}

function simultaneousJobs(): void {
  const before = getGroup(DEMO_GROUP_ID)?.reports.length ?? 0
  const a = runThresholdJob(30)
  const b = runThresholdJob(30)
  const after = getGroup(DEMO_GROUP_ID)?.reports.length ?? 0
  refresh(
    `同时提交两个请求：报告仅写入 ${after - before} 次；${b.job.jobId} 去重至 ${a.job.jobId}，共用报告 ${a.report.id}`,
  )
}

function shrinkSample(): void {
  const summary = shrinkAndRecalculate('DEVI-0001', 8, 3)
  state.value = summary.state
  refresh('已缩小 DEVI-0001 样本：报告标注样本不足，旧效应值失效（差值置为结论暂缓），置信边界保留')
}

function arbitrate(strategy: 'sample-limit' | 'historical-threshold'): void {
  const outcome = runArbitration(strategy)
  refresh(
    `仲裁完成（${strategy === 'sample-limit' ? '样本不足限制' : '历史阈值回看'}）：` +
      `受限报告 ${outcome.restrictedReport.id}，当前报告 ${outcome.preservedReportId} 原样保留，` +
      `暂缓 ${outcome.suspendedConclusions.length} 项结论`,
  )
}

onMounted(bootstrap)
</script>

<style scoped>
.action-panel {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 12px;
}
.action-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: flex-start;
}
.action-title {
  font-size: 12px;
  color: var(--muted);
}
.action-message {
  color: #1f6feb;
  font-size: 13px;
}
.section-title {
  font-size: 15px;
  margin: 18px 0 8px;
}
.tag {
  border-radius: 999px;
  padding: 2px 8px;
  font-size: 12px;
}
.tag-ok {
  background: #e7f6ec;
  color: #1a7f37;
}
.tag-warn {
  background: #fdecec;
  color: #b42318;
}
.warn {
  color: #b42318;
}
.report-meta {
  font-size: 12px;
  color: var(--muted);
  margin-top: 6px;
}
</style>
