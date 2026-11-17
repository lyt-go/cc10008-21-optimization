/**
 * 小样本统计工具：所有占比类指标一律输出 Wilson 置信边界。
 * 样本不足时不输出精确结论，调用方只能拿到带边界的受限指标。
 */
import type { ShareMetric } from './types'

/** 样本不足阈值：群组/画像样本低于该值即触发受限处理。集中在此处，便于阈值调整任务引用。 */
export const MIN_SAMPLE_SIZE = 30
/** 95% 置信水平对应的正态分位数。 */
export const Z_95 = 1.96

function clamp01(value: number): number {
  if (Number.isNaN(value)) {
    return 0
  }
  return Math.min(1, Math.max(0, value))
}

/**
 * Wilson 得分区间：小样本下比正态近似更稳，边界不会越出 [0,1]。
 * 返回的 lower/upper 永远存在，样本不足只改 insufficient 标记，不删除边界。
 */
export function wilsonInterval(hits: number, sampleSize: number): ShareMetric {
  const n = Math.max(0, Math.floor(sampleSize))
  const safeHits = Math.min(Math.max(0, Math.floor(hits)), n)
  const insufficient = n < MIN_SAMPLE_SIZE

  if (n === 0) {
    return { point: 0, lower: 0, upper: 0, sampleSize: 0, insufficient: true }
  }

  const phat = safeHits / n
  const z2 = Z_95 * Z_95
  const denominator = 1 + z2 / n
  const center = (phat + z2 / (2 * n)) / denominator
  const margin =
    (Z_95 * Math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n)) / denominator

  return {
    point: clamp01(phat),
    lower: clamp01(center - margin),
    upper: clamp01(center + margin),
    sampleSize: n,
    insufficient,
  }
}

/**
 * 增量差值：仅当两侧样本都充足时才给出点估计差值；
 * 任一侧样本不足，差值置 null，结论方只能使用置信边界。
 */
export function deltaMetric(before: ShareMetric, after: ShareMetric): number | null {
  if (before.insufficient || after.insufficient) {
    return null
  }
  return Number((after.point - before.point).toFixed(6))
}

/** 置信区间宽度，用于复核清单展示边界松紧。 */
export function intervalWidth(metric: ShareMetric): number {
  return Number((metric.upper - metric.lower).toFixed(6))
}
