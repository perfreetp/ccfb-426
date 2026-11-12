import type { Plan, SpeciesParams, TreeInstance, PlantRegion, Season } from '../types';
import { DEFAULT_SPECIES } from '../core/defaultSpecies';
import { storage } from './storage';
import { findSpacingConflicts, scatterInRegion } from '../core/geometry';
import { hashSeed } from '../core/rng';

type Listener = () => void;

function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

function makePlan(name: string, size: number): Plan {
  const now = Date.now();
  return {
    id: uid('plan'),
    name,
    createdAt: now,
    updatedAt: now,
    season: 'summer',
    site: { size, windStrength: 0.3, sunAzimuth: 0.8, sunElevation: 0.9 },
    trees: [],
    regions: [],
    conflicts: [],
  };
}

/** 全局应用状态：方案 + 树种库，防抖自动保存，发布订阅 */
class AppStore {
  plans: Plan[] = [];
  species: SpeciesParams[] = [];
  currentPlanId: string | null = null;
  private listeners = new Set<Listener>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private loaded = false;

  async init(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const [savedPlans, savedSpecies] = await Promise.all([
      storage.loadAllPlans(),
      storage.loadAllSpecies(),
    ]);
    this.plans = savedPlans.sort((a, b) => b.updatedAt - a.updatedAt);
    // 内置树种 + 用户自定义树种（按 id 去重，内置优先）
    const custom = savedSpecies.filter((s) => !s.builtin);
    this.species = [...DEFAULT_SPECIES, ...custom];
    if (this.plans.length > 0) this.currentPlanId = this.plans[0].id;
    this.emit();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    this.listeners.forEach((fn) => fn());
  }

  get currentPlan(): Plan | null {
    return this.plans.find((p) => p.id === this.currentPlanId) ?? null;
  }

  getSpecies(id: string): SpeciesParams | undefined {
    return this.species.find((s) => s.id === id);
  }

  // ---------- 方案 ----------

  createPlan(name?: string): Plan {
    const plan = makePlan(name ?? `方案 ${this.plans.length + 1}`, 60);
    this.plans.unshift(plan);
    this.currentPlanId = plan.id;
    this.persistSoon();
    this.emit();
    return plan;
  }

  duplicatePlan(id: string): Plan {
    const src = this.plans.find((p) => p.id === id);
    if (!src) throw new Error('方案不存在');
    const copy: Plan = structuredClone(src);
    copy.id = uid('plan');
    copy.name = `${src.name} 副本`;
    copy.createdAt = Date.now();
    copy.updatedAt = copy.createdAt;
    copy.trees.forEach((t) => (t.id = uid('tree')));
    copy.regions.forEach((r) => (r.id = uid('region')));
    const idx = this.plans.findIndex((p) => p.id === id);
    this.plans.splice(idx + 1, 0, copy);
    this.currentPlanId = copy.id;
    this.persistSoon();
    this.emit();
    return copy;
  }

  deletePlan(id: string): void {
    this.plans = this.plans.filter((p) => p.id !== id);
    void storage.deletePlan(id);
    if (this.currentPlanId === id) this.currentPlanId = this.plans[0]?.id ?? null;
    this.emit();
  }

  selectPlan(id: string): void {
    this.currentPlanId = id;
    this.emit();
  }

  renamePlan(id: string, name: string): void {
    const p = this.plans.find((x) => x.id === id);
    if (p) {
      p.name = name;
      this.persistSoon();
      this.emit();
    }
  }

  updatePlan(mutator: (p: Plan) => void): void {
    const p = this.currentPlan;
    if (!p) return;
    mutator(p);
    p.updatedAt = Date.now();
    this.recomputeConflicts(p);
    this.persistSoon();
    this.emit();
  }

  // ---------- 树木与区域 ----------

  addTree(t: Omit<TreeInstance, 'id'>): void {
    this.updatePlan((p) => p.trees.push({ ...t, id: uid('tree') }));
  }

  removeTrees(ids: Set<string>): void {
    this.updatePlan((p) => {
      p.trees = p.trees.filter((t) => !ids.has(t.id));
    });
  }

  addRegion(region: Omit<PlantRegion, 'id'>): void {
    this.updatePlan((p) => {
      const full: PlantRegion = { ...region, id: uid('region') };
      p.regions.push(full);
      this.fillRegion(p, full);
    });
  }

  /** 按区域参数确定性生成树木（重新生成会先清掉该区域旧树） */
  private fillRegion(plan: Plan, region: PlantRegion): void {
    plan.trees = plan.trees.filter((t) => t.regionId !== region.id);
    const pts = scatterInRegion(region);
    const rand = (i: number) => {
      const x = Math.sin(region.seed * 999 + i * 137.13) * 43758.5453;
      return x - Math.floor(x);
    };
    pts.forEach(([x, z], i) => {
      plan.trees.push({
        id: uid('tree'),
        speciesId: region.speciesId,
        x,
        z,
        rotation: rand(i) * Math.PI * 2,
        scale: 0.92 + rand(i + 1) * 0.16,
        regionId: region.id,
      });
    });
  }

  removeRegion(regionId: string): void {
    this.updatePlan((p) => {
      p.regions = p.regions.filter((r) => r.id !== regionId);
      p.trees = p.trees.filter((t) => t.regionId !== regionId);
    });
  }

  updateRegion(regionId: string, patch: Partial<PlantRegion>): void {
    this.updatePlan((p) => {
      const r = p.regions.find((x) => x.id === regionId);
      if (!r) return;
      Object.assign(r, patch);
      this.fillRegion(p, r);
    });
  }

  recomputeConflicts(plan: Plan): void {
    const set = findSpacingConflicts(plan.trees, (sid) => this.getSpecies(sid)?.minSpacing ?? 3);
    plan.conflicts = [...set];
  }

  setSeason(season: Season): void {
    this.updatePlan((p) => {
      p.season = season;
    });
  }

  // ---------- 树种库 ----------

  createSpecies(base?: Partial<SpeciesParams>): SpeciesParams {
    const sp: SpeciesParams = {
      id: uid('sp'),
      name: base?.name ?? `新树种 ${this.species.filter((s) => !s.builtin).length + 1}`,
      seed: base?.seed ?? Math.floor(Math.random() * 1e6),
      height: base?.height ?? 9,
      crownWidth: base?.crownWidth ?? 5,
      branchDepth: base?.branchDepth ?? 5,
      branchAngle: base?.branchAngle ?? 0.8,
      branchesPerNode: base?.branchesPerNode ?? 3,
      leafDensity: base?.leafDensity ?? 0.8,
      deciduous: base?.deciduous ?? true,
      minSpacing: base?.minSpacing ?? 3,
      leafColors: base?.leafColors ?? {
        spring: [0.4, 0.65, 0.25],
        summer: [0.15, 0.4, 0.15],
        autumn: [0.85, 0.55, 0.15],
      },
      barkColor: base?.barkColor ?? [0.3, 0.22, 0.15],
    };
    this.species.push(sp);
    void storage.putSpecies(sp);
    this.emit();
    return sp;
  }

  updateSpecies(id: string, patch: Partial<SpeciesParams>): void {
    const sp = this.species.find((s) => s.id === id);
    if (!sp || sp.builtin) return;
    Object.assign(sp, patch);
    void storage.putSpecies(sp);
    this.emit();
  }

  deleteSpecies(id: string): void {
    const sp = this.species.find((s) => s.id === id);
    if (!sp || sp.builtin) return;
    this.species = this.species.filter((s) => s.id !== id);
    void storage.deleteSpecies(id);
    this.emit();
  }

  // ---------- 持久化 ----------

  private persistSoon(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      const p = this.currentPlan;
      if (p) void storage.putPlan(p);
    }, 800);
  }

  /** 切换方案/导出前强制落盘 */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const p = this.currentPlan;
    if (p) await storage.putPlan(p);
  }

  /** 导入文件中的方案（重新分配 id，避免覆盖本地方案） */
  importPlan(data: { format: string; species?: SpeciesParams[]; plan: Plan }): Plan {
    if (data.format !== 'garden-plan/v1' || !data.plan) throw new Error('文件格式不正确');
    for (const sp of data.species ?? []) {
      if (sp.builtin) continue;
      if (!this.species.some((x) => x.id === sp.id)) {
        this.species.push(sp);
        void storage.putSpecies(sp);
      }
    }
    const plan: Plan = structuredClone(data.plan);
    plan.id = uid('plan');
    plan.name = `${plan.name}（导入）`;
    plan.createdAt = Date.now();
    plan.updatedAt = plan.createdAt;
    plan.trees.forEach((t) => (t.id = uid('tree')));
    plan.regions.forEach((r) => (r.id = uid('region')));
    this.recomputeConflicts(plan);
    this.plans.unshift(plan);
    this.currentPlanId = plan.id;
    void storage.putPlan(plan);
    this.emit();
    return plan;
  }

  /** 仅触发自动保存（太阳拖拽等高频场景用，不触发订阅刷新） */
  saveSoon(): void {
    this.persistSoon();
  }

  /** 稳定 hash：用于让渲染层感知数据是否变化 */
  planFingerprint(plan: Plan): string {
    return hashSeed(
      plan.trees.map((t) => `${t.id}:${t.speciesId}:${t.x.toFixed(2)}:${t.z.toFixed(2)}:${t.rotation.toFixed(2)}:${t.scale.toFixed(2)}`).join('|')
      + `#${plan.site.size}#${plan.season}#${plan.conflicts.length}`,
    ).toString(36);
  }
}

export const store = new AppStore();
