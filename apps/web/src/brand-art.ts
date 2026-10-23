/**
 * 品牌记号：一片 25 见方的瓷砖，被一条 45° 的接缝斜切成两片；右下那片用强调色。
 * 瓷砖是 Tessera（镶嵌片），接缝是探索路径，着色的一片是落位的结论。
 *
 * 两片先在 32 的画布内画满，再用圆角方框裁出外轮廓：接缝两侧各留 0.92，
 * 垂直缝宽 1.84（按 32 的画布算），缩到 16px 仍有约 1px，两片不会糊成一块。
 */
export const markViewBox = 32;

export const markTile = { x: 3.5, y: 3.5, size: 25, radius: 5.5 };

/** 斜切的两半：上片止于 x+y=30.7，右下片起于 x+y=33.3，关于 x+y=32 对称。 */
export const markPieces = {
  base: "M3.5 3.5H27.2L3.5 27.2Z",
  accent: "M28.5 28.5H4.8L28.5 4.8Z",
} as const;
