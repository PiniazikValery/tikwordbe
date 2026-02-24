export interface PopularityMetrics {
  viewCount: number;
  likeCount: number;
  commentCount: number;
}

export interface PopularityScore {
  score: number;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  calculatedAt: string;
}

export function calculatePopularityScore(metrics: PopularityMetrics): number {
  const viewScore = Math.log10(Math.max(metrics.viewCount, 1));
  const likeScore = Math.log10(Math.max(metrics.likeCount, 1));
  const commentScore = Math.log10(Math.max(metrics.commentCount, 1));

  // Weights: views 50%, likes 35%, comments 15%
  const rawScore = (viewScore * 0.50) + (likeScore * 0.35) + (commentScore * 0.15);

  // Normalize to 0-100 range (a video with 1B views, 10M likes, 1M comments scores ~10 raw)
  const normalized = Math.min(Math.round((rawScore / 10) * 100), 100);

  return normalized;
}

export function buildPopularityScore(metrics: PopularityMetrics): PopularityScore {
  return {
    score: calculatePopularityScore(metrics),
    viewCount: metrics.viewCount,
    likeCount: metrics.likeCount,
    commentCount: metrics.commentCount,
    calculatedAt: new Date().toISOString(),
  };
}
