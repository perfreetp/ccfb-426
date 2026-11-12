/** 全局数据类型定义 */

export type Season = 'spring' | 'summer' | 'autumn' | 'winter';
export type TreeLod = 'high' | 'low' | 'billboard';

/** 树种参数（程序化生成的全部输入） */
export interface SpeciesParams {
  /** 树种唯一 id */
  id: string;
  name: string;
  /** 种子，相同种子 + 相同参数生成结果一致 */
  seed: number;
  /** 成树高度（米） */
  height: number;
  /** 冠幅（米） */
  crownWidth: number;
  /** 主干分段数（递归深度） */
  branchDepth: number;
  /** 主枝与主干的分枝角度（弧度） */
  branchAngle: number;
  /** 每个节点的分枝数量 */
  branchesPerNode: number;
  /** 冠层叶密度 0~1 */
  leafDensity: number;
  /** 是否落叶树（冬季掉叶） */
  deciduous: boolean;
  /** 单棵最小合理株距（米），用于冲突检测 */
  minSpacing: number;
  /** 叶色：春/夏/秋（冬季落叶树无叶） */
  leafColors: Record<Exclude<Season, 'winter'>, [number, number, number]>;
  /** 树干颜色（线性 rgb 0~1） */
  barkColor: [number, number, number];
  /** 内置树种不可删除/改 id */
  builtin?: boolean;
}

/** 场地上的一棵树实例（数据层，渲染层用 ThinInstance 承载） */
export interface TreeInstance {
  id: string;
  speciesId: string;
  x: number;
  z: number;
  /** 绕 Y 轴旋转（弧度） */
  rotation: number;
  /** 整体缩放 */
  scale: number;
  /** 由撒播区域生成时记录区域 id，手点树无此字段 */
  regionId?: string;
}

/** 圈选撒播区域 */
export interface PlantRegion {
  id: string;
  speciesId: string;
  /** 多边形顶点（场地平面坐标 x,z） */
  polygon: [number, number][];
  /** 每 100 平方米株数 */
  density: number;
  /** 撒播随机种子 */
  seed: number;
}

export interface SiteSettings {
  /** 场地边长（米，正方形） */
  size: number;
  /** 风力 0~1 */
  windStrength: number;
  /** 太阳方位角（弧度，绕 Y） */
  sunAzimuth: number;
  /** 太阳高度角（弧度，0~π/2） */
  sunElevation: number;
}

export interface Plan {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  season: Season;
  site: SiteSettings;
  trees: TreeInstance[];
  regions: PlantRegion[];
  /** 冲突（株距不足）的树 id 列表，由编辑逻辑计算 */
  conflicts: string[];
}

/** 导出文件格式 */
export interface PlanFile {
  format: 'garden-plan/v1';
  exportedAt: number;
  species: SpeciesParams[];
  plan: Plan;
}
