import type { SpeciesParams, TreeInstance, Season, TreeLod } from '../types';
import { getTreeTemplate, createLeafTexture, type TreeTemplate, type LodGeometry } from '../core/treeGenerator';
import { hashSeed } from '../core/rng';
import type { Scene } from '@babylonjs/core/scene';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { WindMaterialPlugin } from './windPlugin';

/** LOD 切换距离（米），带 15% 抖动 + 回差，避免边界树木反复跳变 */
const HIGH_DIST = 35;
const LOW_DIST = 75;
const HYSTERESIS = 1.08;
const GROW_TIME = 0.22;

interface InstanceState {
  tree: TreeInstance;
  lod: TreeLod;
  /** 每棵树固定的 LOD 距离抖动系数 0.85~1.15 */
  jitter: number;
  /** 当前档出现的时间戳（秒），用于缩放生长动画 */
  appearAt: number;
  /** 公告板每帧要更新的矩阵序号 */
  bbIndex: number;
}

interface SpeciesGroup {
  species: SpeciesParams;
  template: TreeTemplate;
  branchMat: PBRMaterial;
  leafMat: PBRMaterial;
  highBranch: Mesh;
  highLeaf: Mesh;
  lowBranch: Mesh;
  lowLeaf: Mesh;
  billboard: Mesh;
  states: InstanceState[];
  /** 各档预分配矩阵缓冲（容量=states 数），用 count 控制有效长度 */
  lodData: Record<TreeLod, Float32Array>;
  lodCount: Record<TreeLod, number>;
  /** 公告板朝向缓冲，相机转动时原地更新 */
  bbData: Float32Array;
  /** 每棵树缓存的静态矩阵（位置/旋转/缩放），数据不变时不重算 */
  staticMatrices: Float32Array;
  dirty: boolean;
  /** 相机是否在本帧移动（决定公告板是否需要重算） */
  cameraMoved: boolean;
}

export class TreeRenderer {
  private groups = new Map<string, SpeciesGroup>();
  private scene: Scene;
  private leafTexture;
  private windPlugins: WindMaterialPlugin[] = [];
  private windStrength = 0.3;
  private now = 0;
  private conflictIds = new Set<string>();
  private season: Season = 'summer';
  private readonly camRight = new Vector3();
  private readonly camUp = new Vector3();

  constructor(scene: Scene) {
    this.scene = scene;
    this.leafTexture = createLeafTexture(scene);
  }

  setWindStrength(v: number): void {
    this.windStrength = v;
    this.windPlugins.forEach((p) => (p.strength = v));
  }

  /** 重建渲染结构：按当前树种与树木数据同步 groups（LOD 状态尽量保留） */
  sync(speciesList: SpeciesParams[], trees: TreeInstance[], conflicts: Set<string>, season: Season): void {
    this.conflictIds = conflicts;
    this.season = season;
    const used = new Set<string>();

    const bySpecies = new Map<string, TreeInstance[]>();
    for (const t of trees) {
      const arr = bySpecies.get(t.speciesId);
      if (arr) arr.push(t);
      else bySpecies.set(t.speciesId, [t]);
    }

    for (const sp of speciesList) {
      const list = bySpecies.get(sp.id);
      if (!list || list.length === 0) continue;
      used.add(sp.id);
      let group = this.groups.get(sp.id);
      if (!group || group.species.seed !== sp.seed || morphChanged(group.species, sp)) {
        if (group) this.disposeGroup(group);
        group = this.createGroup(sp, list);
        this.groups.set(sp.id, group);
      } else {
        group.species = sp;
        this.rebuildStates(group, list);
      }
      this.applySeason(group);
      this.applyColors(group);
      group.dirty = true;
    }

    for (const [id, group] of [...this.groups]) {
      if (!used.has(id)) {
        this.disposeGroup(group);
        this.groups.delete(id);
      }
    }
  }

  private createGroup(sp: SpeciesParams, trees: TreeInstance[]): SpeciesGroup {
    const tpl = getTreeTemplate(sp, this.scene);

    const branchMat = new PBRMaterial(`branch-${sp.id}`, this.scene);
    branchMat.albedoColor = Color3.FromArray(sp.barkColor);
    branchMat.metallic = 0;
    branchMat.roughness = 0.95;
    branchMat.emissiveColor = new Color3(0, 0, 0);
    const branchWind = new WindMaterialPlugin(branchMat, this.windStrength);
    branchWind.strength = this.windStrength;
    this.windPlugins.push(branchWind);

    const leafMat = new PBRMaterial(`leaf-${sp.id}`, this.scene);
    leafMat.albedoColor = this.seasonColor(sp);
    leafMat.metallic = 0;
    leafMat.roughness = 0.8;
    leafMat.albedoTexture = this.leafTexture;
    leafMat.useAlphaFromAlbedoTexture = true;
    leafMat.alphaMode = 6; // ALPHA_COMBINE
    leafMat.backFaceCulling = false;
    leafMat.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
    const leafWind = new WindMaterialPlugin(leafMat, this.windStrength);
    leafWind.strength = this.windStrength;
    this.windPlugins.push(leafWind);

    const highBranch = this.makeMesh(`hb-${sp.id}`, tpl.high.branch, branchMat);
    const highLeaf = this.makeMesh(`hl-${sp.id}`, tpl.high.leaf, leafMat);
    const lowBranch = this.makeMesh(`lb-${sp.id}`, tpl.low.branch, branchMat);
    const lowLeaf = this.makeMesh(`ll-${sp.id}`, tpl.low.leaf, leafMat);

    // 公告板：单位平面，实例化时每帧重建相机朝向矩阵
    const billboard = Mesh.CreatePlane(`bb-mesh-${sp.id}`, 1, this.scene);
    const bbMat = new PBRMaterial(`bbmat-${sp.id}`, this.scene);
    bbMat.albedoTexture = tpl.billboardTexture;
    bbMat.useAlphaFromAlbedoTexture = true;
    bbMat.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
    bbMat.alphaMode = 6;
    bbMat.emissiveColor = new Color3(0.08, 0.08, 0.08);
    bbMat.backFaceCulling = false;
    bbMat.disableLighting = false;
    billboard.material = bbMat;
    billboard.alwaysSelectAsActiveMesh = true;
    billboard.isPickable = false;

    const group: SpeciesGroup = {
      species: sp,
      template: tpl,
      branchMat,
      leafMat,
      highBranch,
      highLeaf,
      lowBranch,
      lowLeaf,
      billboard,
      states: [],
      lodData: { high: new Float32Array(16), low: new Float32Array(16), billboard: new Float32Array(16) },
      lodCount: { high: 0, low: 0, billboard: 0 },
      bbData: new Float32Array(16),
      staticMatrices: new Float32Array(0),
      dirty: true,
      cameraMoved: false,
    };
    this.rebuildStates(group, trees);
    return group;
  }

  private makeMesh(name: string, geo: LodGeometry, mat: PBRMaterial): Mesh {
    const mesh = new Mesh(name, this.scene);
    mesh.setVerticesData('position', geo.positions);
    mesh.setVerticesData('normal', geo.normals);
    mesh.setVerticesData('uv', geo.uvs);
    mesh.setVerticesData('color', geo.colors);
    mesh.setIndices(Array.from(geo.indices));
    // 风插件的自定义 attribute（每顶点 1 分量，显式 stride 绕过内置 kind 推导）
    mesh.setVerticesData('gardenWind', geo.wind, false, 1);
    mesh.material = mat;
    mesh.useVertexColors = true;
    mesh.alwaysSelectAsActiveMesh = true; // 跳过视锥剔除，实例位置无法被包围盒反映
    mesh.isPickable = false;
    mesh.freezeWorldMatrix();
    return mesh;
  }

  /** 同步实例状态；已存在的树保留 LOD 与出现时间，避免重建跳变 */
  private rebuildStates(group: SpeciesGroup, trees: TreeInstance[]): void {
    const prev = new Map(group.states.map((s) => [s.tree.id, s]));
    group.states = trees.map((tree) => {
      const old = prev.get(tree.id);
      if (old) return { ...old, tree };
      return {
        tree,
        lod: 'high',
        jitter: 0.85 + ((hashSeed(tree.id) % 1000) / 1000) * 0.3,
        appearAt: this.now,
        bbIndex: -1,
      };
    });
    const n = Math.max(trees.length, 1);
    group.lodData = {
      high: new Float32Array(n * 16),
      low: new Float32Array(n * 16),
      billboard: new Float32Array(n * 16),
    };
    group.lodCount = { high: 0, low: 0, billboard: 0 };
    group.bbData = new Float32Array(n * 16);
    group.staticMatrices = new Float32Array(trees.length * 16);
    // 预计算每棵树的静态世界矩阵（位置/旋转/缩放，不含生长动画）
    trees.forEach((t, i) => {
      this.composeMatrixInto(t, 1, group.staticMatrices, i * 16);
    });
    group.dirty = true;
  }

  private disposeGroup(group: SpeciesGroup): void {
    [group.highBranch, group.highLeaf, group.lowBranch, group.lowLeaf, group.billboard].forEach((m) => m.dispose());
    group.branchMat.dispose();
    group.leafMat.dispose();
    (group.billboard.material as PBRMaterial)?.dispose();
    // 释放该组的两个风插件（按材质名匹配）
    this.windPlugins = this.windPlugins.filter((p) => {
      const mat = (p as unknown as { _material: PBRMaterial })._material;
      return mat !== group.branchMat && mat !== group.leafMat;
    });
  }

  private seasonColor(sp: SpeciesParams): Color3 {
    if (this.season === 'winter') {
      // 冬季常绿树叶色压暗偏灰
      const c = sp.leafColors.summer;
      return new Color3(c[0] * 0.55, c[1] * 0.6, c[2] * 0.6);
    }
    return Color3.FromArray(sp.leafColors[this.season]);
  }

  private applySeason(group: SpeciesGroup): void {
    group.leafMat.albedoColor = this.seasonColor(group.species);
    const showLeaves = this.season !== 'winter' || !group.species.deciduous;
    group.highLeaf.setEnabled(showLeaves);
    group.lowLeaf.setEnabled(showLeaves);
    // 公告板纹理是夏季快照：冬季落叶树用枝干占位（隐藏公告板，全部走低模枝干）
    group.billboard.setEnabled(showLeaves);
  }

  /** 冲突树标红（thin instance 颜色通道，与顶点色相乘；alpha 必须恒为 1） */
  private applyColors(group: SpeciesGroup): void {
    const meshes = [group.highBranch, group.highLeaf, group.lowBranch, group.lowLeaf];
    for (const mesh of meshes) {
      const capacity = Math.max(group.states.length, 1);
      const colors = new Float32Array(capacity * 4);
      group.states.forEach((s, i) => {
        if (this.conflictIds.has(s.tree.id)) {
          colors[i * 4] = 2.2;
          colors[i * 4 + 1] = 0.25;
          colors[i * 4 + 2] = 0.2;
        } else {
          colors[i * 4] = 1;
          colors[i * 4 + 1] = 1;
          colors[i * 4 + 2] = 1;
        }
        colors[i * 4 + 3] = 1;
      });
      mesh.thinInstanceSetBuffer('color', colors, 4, false);
      mesh.thinInstanceCount = group.states.length;
    }
  }

  private lastCamX = Number.NaN;
  private lastCamZ = Number.NaN;

  /** 每帧：LOD 分级、生长动画、公告板相机朝向；稳态下零缓冲重传 */
  update(camPos: Vector3, deltaSeconds: number): void {
    this.now += deltaSeconds;
    const camMoved =
      Math.abs(camPos.x - this.lastCamX) > 0.01 || Math.abs(camPos.z - this.lastCamZ) > 0.01;
    this.lastCamX = camPos.x;
    this.lastCamZ = camPos.z;

    for (const group of this.groups.values()) {
      let lodChanged = group.dirty;
      let anyGrowing = false;
      const counts = { high: 0, low: 0, billboard: 0 };
      const { states, lodData, staticMatrices } = group;

      for (let i = 0; i < states.length; i++) {
        const st = states[i];
        const t = st.tree;
        const dx = t.x - camPos.x;
        const dz = t.z - camPos.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        const target = this.pickLod(dist, st.jitter, st.lod, group.species);
        if (target !== st.lod) {
          st.lod = target;
          st.appearAt = this.now;
          lodChanged = true;
        }
        const age = this.now - st.appearAt;
        const growing = age < GROW_TIME;
        if (growing) anyGrowing = true;

        if (st.lod === 'billboard') {
          st.bbIndex = counts.billboard;
          counts.billboard++;
        } else {
          const dstLod = st.lod;
          const dst = lodData[dstLod];
          const o = counts[dstLod] * 16;
          counts[dstLod]++;
          if (growing) {
            // 生长中：按缓动缩放即时组合
            const grow = Math.min(1, age / GROW_TIME);
            const eased = 0.7 + 0.3 * grow * grow * (3 - 2 * grow);
            this.composeMatrixInto(t, eased, dst, o);
          } else {
            // 稳态：直接拷贝预计算静态矩阵
            dst.set(staticMatrices.subarray(i * 16, i * 16 + 16), o);
          }
        }
      }

      const needStaticUpload = lodChanged || anyGrowing;
      group.lodCount = counts;
      this.flushMesh(group.highBranch, lodData.high, counts.high, needStaticUpload);
      this.flushMesh(group.highLeaf, lodData.high, counts.high, needStaticUpload);
      this.flushMesh(group.lowBranch, lodData.low, counts.low, needStaticUpload);
      this.flushMesh(group.lowLeaf, lodData.low, counts.low, needStaticUpload);

      // 公告板：相机移动或 LOD 变化时重建朝向
      if (counts.billboard > 0 && (camMoved || lodChanged || anyGrowing)) {
        this.updateBillboards(group, states);
      }
      group.billboard.thinInstanceCount = counts.billboard;
      group.dirty = false;
    }
  }

  private pickLod(dist: number, jitter: number, current: TreeLod, sp: SpeciesParams): TreeLod {
    const highEdge = HIGH_DIST * jitter;
    const lowEdge = LOW_DIST * jitter;
    // 冬季落叶树没有叶，公告板是带叶快照不可用，最远只走低模
    const winterBare = this.season === 'winter' && sp.deciduous;
    if (current === 'high') {
      if (dist > highEdge) return 'low';
      return 'high';
    }
    if (current === 'low') {
      if (dist < highEdge / HYSTERESIS) return 'high';
      if (!winterBare && dist > lowEdge) return 'billboard';
      return 'low';
    }
    // billboard → 需越过回差线才升档
    if (dist < lowEdge / HYSTERESIS) return 'low';
    return 'billboard';
  }

  /** 直接把 Y 旋转 + 缩放 + 平移写进 Float32Array（列主序），零对象分配 */
  private composeMatrixInto(t: TreeInstance, extraScale: number, out: Float32Array, o: number): void {
    const s = t.scale * extraScale;
    const c = Math.cos(t.rotation) * s;
    const sn = Math.sin(t.rotation) * s;
    // 列 0：右向量；列 1：上；列 2：前；列 3：平移
    out[o] = c;        out[o + 1] = 0; out[o + 2] = -sn;    out[o + 3] = 0;
    out[o + 4] = 0;    out[o + 5] = s; out[o + 6] = 0;      out[o + 7] = 0;
    out[o + 8] = sn;   out[o + 9] = 0; out[o + 10] = c;    out[o + 11] = 0;
    out[o + 12] = t.x; out[o + 13] = 0; out[o + 14] = t.z; out[o + 15] = 1;
  }

  private flushMesh(mesh: Mesh, data: Float32Array, count: number, upload: boolean): void {
    if (upload) {
      // 缓冲按全组容量预分配，thinInstanceCount 控制实际绘制数量
      mesh.thinInstanceSetBuffer('matrix', data, 16, false);
    }
    mesh.thinInstanceCount = count;
  }

  private updateBillboards(group: SpeciesGroup, states: InstanceState[]): void {
    const cam = this.scene.activeCamera;
    if (!cam) return;
    const forward = cam.getDirection(Vector3.Forward());
    Vector3.CrossToRef(Vector3.Up(), forward, this.camRight).normalize();
    this.camUp.copyFrom(Vector3.Up());

    const w = group.template.billboardWidth;
    const h = group.template.billboardHeight;
    const data = group.bbData;
    const r = this.camRight;
    const u = this.camUp;
    const f = forward;
    let out = 0;
    for (let i = 0; i < states.length; i++) {
      const st = states[i];
      if (st.lod !== 'billboard') continue;
      const t = st.tree;
      const age = this.now - st.appearAt;
      const grow = Math.min(1, age / GROW_TIME);
      const eased = 0.7 + 0.3 * grow * grow * (3 - 2 * grow);
      const s = t.scale * eased;
      const sw = w * s;
      const sh = h * s;
      // 列主序 4x4：列0=右*宽，列1=上*高，列2=前，列3=平面中心
      data[out] = r.x * sw; data[out + 1] = r.y * sw; data[out + 2] = r.z * sw; data[out + 3] = 0;
      data[out + 4] = u.x * sh; data[out + 5] = u.y * sh; data[out + 6] = u.z * sh; data[out + 7] = 0;
      data[out + 8] = f.x; data[out + 9] = f.y; data[out + 10] = f.z; data[out + 11] = 0;
      data[out + 12] = t.x; data[out + 13] = sh / 2; data[out + 14] = t.z; data[out + 15] = 1;
      out += 16;
    }
    group.billboard.thinInstanceSetBuffer('matrix', data, 16, false);
  }

  /** 推进所有风插件相位 */
  tickWind(deltaSeconds: number): void {
    for (const p of this.windPlugins) p.tick(deltaSeconds);
  }

  /** 所有参与阴影的网格（枝干/叶片的高/低模；公告板不投影） */
  get shadowMeshes(): Mesh[] {
    const out: Mesh[] = [];
    for (const g of this.groups.values()) {
      out.push(g.highBranch, g.highLeaf, g.lowBranch, g.lowLeaf);
    }
    return out;
  }

  get totalDrawCalls(): number {
    return this.groups.size * 5;
  }

  dispose(): void {
    for (const g of this.groups.values()) this.disposeGroup(g);
    this.groups.clear();
    this.leafTexture.dispose();
  }
}

/** 影响骨架形态的参数变化才需要重建模板（颜色/株距变化不重建） */
function morphChanged(a: SpeciesParams, b: SpeciesParams): boolean {
  return (
    a.seed !== b.seed ||
    a.height !== b.height ||
    a.crownWidth !== b.crownWidth ||
    a.branchDepth !== b.branchDepth ||
    a.branchAngle !== b.branchAngle ||
    a.branchesPerNode !== b.branchesPerNode ||
    a.leafDensity !== b.leafDensity
  );
}
