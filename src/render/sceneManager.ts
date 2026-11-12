import type { Plan, TreeInstance, PlantRegion } from '../types';
import { TreeRenderer } from './treeRenderer';
import { pointInPolygon } from '../core/geometry';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import '@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import { PointerEventTypes } from '@babylonjs/core/Events/pointerEvents';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import type { SpeciesParams } from '../types';

export type EditMode = 'view' | 'plant' | 'region' | 'erase';

export interface SceneCallbacks {
  onPlant?: (x: number, z: number) => void;
  onErase?: (ids: string[]) => void;
  onRegionVertex?: (x: number, z: number) => void;
  onSelectTree?: (id: string | null) => void;
  onSunChange?: (azimuth: number, elevation: number) => void;
}

/** 场景总控：Babylon 引擎生命周期、交互与渲染循环 */
export class SceneManager {
  readonly engine: Engine;
  readonly scene: Scene;
  readonly camera: ArcRotateCamera;
  private renderer: TreeRenderer;
  private sun: DirectionalLight;
  private sunMesh: Mesh;
  private shadowGen: ShadowGenerator;
  private ground: Mesh;
  private proxyRoot: TransformNode;
  private proxies = new Map<string, Mesh>(); // treeId -> 拾取代理
  private regionMeshes: AbstractMesh[] = [];
  private pendingMesh: AbstractMesh | null = null;
  private mode: EditMode = 'view';
  private callbacks: SceneCallbacks;
  private currentPlan: Plan | null = null;
  private speciesList: SpeciesParams[] = [];
  private previewMode = false;
  private draggingSun = false;
  private hoverMarker: Mesh;
  private lastFps = 60;

  constructor(canvas: HTMLCanvasElement, callbacks: SceneCallbacks = {}) {
    this.callbacks = callbacks;
    this.engine = new Engine(canvas, true, { stencil: true, antialias: true, powerPreference: 'high-performance' });
    this.engine.setHardwareScalingLevel(1);

    this.scene = new Scene(this.engine);
    this.scene.clearColor = new Color4(0.78, 0.86, 0.92, 1);
    this.scene.fogMode = Scene.FOGMODE_EXP2;
    this.scene.fogColor = new Color3(0.78, 0.86, 0.92);
    this.scene.fogDensity = 0.0032;

    this.camera = new ArcRotateCamera('cam', -Math.PI / 2.4, Math.PI / 3.2, 80, Vector3.Zero(), this.scene);
    this.camera.attachControl(canvas, true);
    this.camera.wheelPrecision = 6;
    this.camera.lowerRadiusLimit = 6;
    this.camera.upperRadiusLimit = 260;
    this.camera.upperBetaLimit = Math.PI / 2.05;
    this.camera.panningSensibility = 40;
    this.camera.minZ = 0.3;
    this.camera.maxZ = 600;

    const hemi = new HemisphericLight('hemi', new Vector3(0.2, 1, 0.3), this.scene);
    hemi.intensity = 0.75;
    hemi.diffuse = new Color3(1, 0.97, 0.9);
    hemi.groundColor = new Color3(0.35, 0.42, 0.3);

    this.sun = new DirectionalLight('sun', new Vector3(-1, -2, -0.6), this.scene);
    this.sun.intensity = 1.6;
    this.sun.diffuse = new Color3(1, 0.93, 0.78);

    this.shadowGen = new ShadowGenerator(1024, this.sun);
    this.shadowGen.useExponentialShadowMap = true;
    this.shadowGen.darkness = 0.38;
    this.shadowGen.bias = 0.004;
    // 风力动画会让投影轻微变化，保持每帧刷新；用 1024 分辨率控制成本
    const shadowMap = this.shadowGen.getShadowMap();
    if (shadowMap) shadowMap.refreshRate = 1;

    this.ground = this.buildGround(60);
    this.proxyRoot = new TransformNode('proxy-root', this.scene);

    // 太阳可视化（可拖拽）
    this.sunMesh = MeshBuilder.CreateSphere('sun-ball', { diameter: 4, segments: 12 }, this.scene);
    const sunMat = new StandardMaterial('sun-mat', this.scene);
    sunMat.emissiveColor = new Color3(1, 0.85, 0.4);
    sunMat.disableLighting = true;
    this.sunMesh.material = sunMat;
    this.sunMesh.isPickable = false;

    this.hoverMarker = MeshBuilder.CreateDisc('hover', { radius: 0.8, tessellation: 24 }, this.scene);
    this.hoverMarker.rotation.x = Math.PI / 2;
    this.hoverMarker.position.y = 0.05;
    const hm = new StandardMaterial('hover-mat', this.scene);
    hm.emissiveColor = new Color3(0.3, 0.8, 0.45);
    hm.alpha = 0.6;
    hm.disableLighting = true;
    this.hoverMarker.material = hm;
    this.hoverMarker.isVisible = false;

    this.renderer = new TreeRenderer(this.scene);
    this.installDrawCounter();
    this.bindPointer(canvas);
    this.startLoop();
  }

  /** 每帧 draw call 统计（引擎内置计数器不按帧结算，自行打点） */
  private frameDrawCalls = 0;
  private lastFrameDrawCalls = 0;

  private installDrawCounter(): void {
    const engine = this.engine;
    const origElements = engine.drawElementsType.bind(engine);
    const origArrays = engine.drawArraysType.bind(engine);
    engine.drawElementsType = (fillMode: number, start: number, count: number, instances?: number) => {
      this.frameDrawCalls += instances && instances > 0 ? 1 : 1;
      return origElements(fillMode, start, count, instances);
    };
    engine.drawArraysType = (fillMode: number, start: number, count: number, instances?: number) => {
      this.frameDrawCalls++;
      return origArrays(fillMode, start, count, instances);
    };
    this.scene.onAfterRenderObservable.add(() => {
      this.lastFrameDrawCalls = this.frameDrawCalls;
      this.frameDrawCalls = 0;
    });
  }

  private buildGround(size: number): Mesh {
    const g = MeshBuilder.CreateGround('ground', { width: size, height: size, subdivisions: 1 }, this.scene);
    const mat = new StandardMaterial('ground-mat', this.scene);
    mat.diffuseColor = new Color3(0.42, 0.55, 0.34);
    mat.specularColor = new Color3(0.05, 0.05, 0.05);
    g.material = mat;
    g.receiveShadows = true;
    g.isPickable = true;

    // 场地边界框
    const border = MeshBuilder.CreateLines(
      'border',
      {
        points: [
          new Vector3(-size / 2, 0.1, -size / 2),
          new Vector3(size / 2, 0.1, -size / 2),
          new Vector3(size / 2, 0.1, size / 2),
          new Vector3(-size / 2, 0.1, size / 2),
          new Vector3(-size / 2, 0.1, -size / 2),
        ],
      },
      this.scene,
    );
    border.color = new Color3(0.9, 0.9, 0.85);
    return g;
  }

  private bindPointer(canvas: HTMLCanvasElement): void {
    this.scene.onPointerObservable.add((info) => {
      const pick = this.scene.pick(this.scene.pointerX, this.scene.pointerY, (m) => m === this.ground);
      const point = pick?.hit ? pick.pickedPoint : null;

      if (info.type === PointerEventTypes.POINTERMOVE) {
        if (this.draggingSun && point) {
          this.updateSunFromPoint(point);
          return;
        }
        this.hoverMarker.isVisible = (this.mode === 'plant' || this.mode === 'region') && !!point;
        if (point) this.hoverMarker.position.set(point.x, 0.06, point.z);
      }

      if (info.type === PointerEventTypes.POINTERDOWN && info.event.button === 0) {
        // 优先判断是否点中太阳（屏幕距离）
        const sunHit = this.scene.pick(this.scene.pointerX, this.scene.pointerY, (m) => m === this.sunMesh);
        if (sunHit?.hit) {
          this.draggingSun = true;
          this.camera.detachControl();
          return;
        }
        if (!point || !this.currentPlan) return;
        const half = this.currentPlan.site.size / 2;
        if (Math.abs(point.x) > half || Math.abs(point.z) > half) return;

        if (this.mode === 'plant') {
          this.callbacks.onPlant?.(point.x, point.z);
        } else if (this.mode === 'region') {
          this.callbacks.onRegionVertex?.(point.x, point.z);
        } else if (this.mode === 'erase') {
          const hitProxy = this.scene.pick(
            this.scene.pointerX,
            this.scene.pointerY,
            (m) => m.metadata?.treeId !== undefined,
          );
          if (hitProxy?.hit && hitProxy.pickedMesh) {
            this.callbacks.onErase?.([hitProxy.pickedMesh.metadata.treeId as string]);
          }
        } else if (this.mode === 'view') {
          const hitProxy = this.scene.pick(
            this.scene.pointerX,
            this.scene.pointerY,
            (m) => m.metadata?.treeId !== undefined,
          );
          this.callbacks.onSelectTree?.(hitProxy?.hit ? (hitProxy.pickedMesh!.metadata.treeId as string) : null);
        }
      }

      if (info.type === PointerEventTypes.POINTERUP && this.draggingSun) {
        this.draggingSun = false;
        this.camera.attachControl(canvas, true);
      }
    });
  }

  private updateSunFromPoint(point: Vector3): void {
    if (!this.currentPlan) return;
    const azimuth = Math.atan2(point.x, point.z);
    const dist = Math.sqrt(point.x * point.x + point.z * point.z);
    const elevation = Math.max(0.12, Math.min(Math.PI / 2 - 0.05, Math.atan2(30, dist)));
    this.currentPlan.site.sunAzimuth = azimuth;
    this.currentPlan.site.sunElevation = elevation;
    this.applySun();
    this.callbacks.onSunChange?.(azimuth, elevation);
  }

  applySun(): void {
    if (!this.currentPlan) return;
    const { sunAzimuth: az, sunElevation: el } = this.currentPlan.site;
    const r = 45;
    const x = r * Math.cos(el) * Math.sin(az);
    const z = r * Math.cos(el) * Math.cos(az);
    const y = r * Math.sin(el);
    this.sun.position = new Vector3(x, y, z);
    this.sun.setDirectionToTarget(Vector3.Zero());
    this.sunMesh.position = this.sun.position.scale(1.6);
    // 定向光正交阴影范围覆盖整个场地
    const half = this.currentPlan.site.size * 0.75;
    this.sun.autoCalcShadowZBounds = false;
    this.sun.orthoTop = half;
    this.sun.orthoBottom = -half;
    this.sun.orthoLeft = -half;
    this.sun.orthoRight = half;
    this.sun.shadowMinZ = 1;
    this.sun.shadowMaxZ = 160;
  }

  setMode(mode: EditMode): void {
    this.mode = mode;
    this.hoverMarker.isVisible = false;
    this.scene.defaultCursor = mode === 'view' ? '' : 'crosshair';
  }

  setCallbacks(callbacks: SceneCallbacks): void {
    this.callbacks = callbacks;
  }

  /** 同步方案数据到渲染层（store 每次变更后调用） */
  syncPlan(plan: Plan, speciesList: SpeciesParams[]): void {
    const sizeChanged = !this.currentPlan || this.currentPlan.site.size !== plan.site.size;
    this.currentPlan = plan;
    this.speciesList = speciesList;

    if (sizeChanged) {
      this.ground.dispose();
      this.scene.getMeshByName('border')?.dispose();
      this.ground = this.buildGround(plan.site.size);
      this.camera.radius = Math.max(this.camera.radius, plan.site.size * 1.2);
    }

    if (this.previewMode) {
      this.proxyRoot.setEnabled(false);
      this.regionMeshes.forEach((m) => m.setEnabled(false));
      this.applySun();
      return;
    }

    this.renderer.sync(speciesList, plan.trees, new Set(plan.conflicts), plan.season);
    this.renderer.setWindStrength(plan.site.windStrength);
    this.syncProxies(plan, speciesList);
    this.syncRegions(plan);
    this.proxyRoot.setEnabled(true);
    this.syncShadowList();
    this.applySun();
  }

  /** 显式维护阴影渲染列表：地面 + 树木薄实例网格（代理与公告板不投影） */
  private syncShadowList(): void {
    const map = this.shadowGen.getShadowMap();
    if (!map) return;
    const wanted = new Set<AbstractMesh>([this.ground, ...this.renderer.shadowMeshes]);
    const current = new Set(map.renderList ?? []);
    for (const m of wanted) if (!current.has(m)) this.shadowGen.addShadowCaster(m);
    for (const m of [...current]) if (!wanted.has(m)) this.shadowGen.removeShadowCaster(m);
  }

  /** 树种库预览：用虚拟单棵树替换场地内容，不改动方案数据 */
  setPreviewSpecies(sp: SpeciesParams | null): void {
    this.previewMode = sp !== null;
    if (!sp) {
      this.proxyRoot.setEnabled(true);
      this.regionMeshes.forEach((m) => m.setEnabled(true));
      if (this.currentPlan) {
        this.renderer.sync(this.speciesList, this.currentPlan.trees, new Set(this.currentPlan.conflicts), this.currentPlan.season);
        this.renderer.setWindStrength(this.currentPlan.site.windStrength);
      }
      return;
    }
    const demo: TreeInstance[] = [
      { id: 'preview-tree', speciesId: sp.id, x: 0, z: 0, rotation: 0, scale: 1 },
    ];
    this.proxyRoot.setEnabled(false);
    this.regionMeshes.forEach((m) => m.setEnabled(false));
    this.renderer.sync([sp], demo, new Set(), 'summer');
    this.renderer.setWindStrength(0.3);
  }

  get isPreview(): boolean {
    return this.previewMode;
  }

  /** 拾取代理：每棵树一个不可见圆柱，挂 treeId，参与射线检测 */
  private syncProxies(plan: Plan, speciesList: SpeciesParams[]): void {
    const alive = new Set<string>();
    const byId = new Map(speciesList.map((s) => [s.id, s]));
    for (const t of plan.trees) {
      alive.add(t.id);
      let proxy = this.proxies.get(t.id);
      const sp = byId.get(t.speciesId);
      const h = sp?.height ?? 9;
      const w = sp?.crownWidth ?? 5;
      if (!proxy) {
        proxy = MeshBuilder.CreateCylinder(`proxy-${t.id}`, { height: h, diameter: w * 0.8, tessellation: 8 }, this.scene);
        proxy.position.y = h / 2;
        // isVisible=false 的网格不进渲染管线（零 draw call），但射线拾取仍生效
        proxy.isVisible = false;
        proxy.isPickable = true;
        proxy.doNotSyncBoundingInfo = true;
        proxy.parent = this.proxyRoot;
        proxy.metadata = { treeId: t.id };
        this.proxies.set(t.id, proxy);
      }
      proxy.position.x = t.x;
      proxy.position.z = t.z;
      proxy.rotation.y = t.rotation;
      proxy.scaling.setAll(t.scale);
      proxy.metadata = { treeId: t.id };
    }
    for (const [id, mesh] of [...this.proxies]) {
      if (!alive.has(id)) {
        mesh.dispose();
        this.proxies.delete(id);
      }
    }
  }

  /** 撒播区域可视化：半透明多边形 + 边线 + 顶点 */
  private syncRegions(plan: Plan): void {
    this.regionMeshes.forEach((m) => m.dispose());
    this.regionMeshes = [];
    for (const region of plan.regions) {
      const fill = this.buildRegionFill(region);
      if (fill) this.regionMeshes.push(fill);
      const linePts = [...region.polygon, region.polygon[0]].map(([x, z]) => new Vector3(x, 0.15, z));
      const lines = MeshBuilder.CreateLines(`rline-${region.id}`, { points: linePts }, this.scene);
      lines.color = new Color3(0.25, 0.55, 0.95);
      lines.isPickable = false;
      this.regionMeshes.push(lines);
      for (const [x, z] of region.polygon) {
        const v = MeshBuilder.CreateSphere(`rv-${region.id}`, { diameter: 0.7, segments: 8 }, this.scene);
        v.position.set(x, 0.2, z);
        const vm = new StandardMaterial('rvm', this.scene);
        vm.emissiveColor = new Color3(0.25, 0.55, 0.95);
        vm.disableLighting = true;
        v.material = vm;
        v.isPickable = false;
        this.regionMeshes.push(v);
      }
    }
  }

  private buildRegionFill(region: PlantRegion): AbstractMesh | null {
    if (region.polygon.length < 3) {
      // 不足三点先画线预览
      if (region.polygon.length >= 2) {
        const pts = region.polygon.map(([x, z]) => new Vector3(x, 0.12, z));
        const l = MeshBuilder.CreateLines(`rpre-${region.id}`, { points: pts }, this.scene);
        l.color = new Color3(0.25, 0.55, 0.95);
        l.isPickable = false;
        return l;
      }
      return null;
    }
    // 三角扇（凸多边形正确；凹多边形用约束三角化成本高，场地圈选以凸区域为主）
    const [cx, cz] = centroid(region.polygon);
    const positions: number[] = [];
    const indices: number[] = [];
    for (const [x, z] of region.polygon) positions.push(x, 0.1, z);
    positions.push(cx, 0.1, cz);
    const c = region.polygon.length;
    for (let i = 0; i < c; i++) {
      indices.push(c, i, (i + 1) % c);
    }
    const mesh = new Mesh(`rfill-${region.id}`, this.scene);
    mesh.setVerticesData('position', positions);
    mesh.setIndices(indices);
    const mat = new StandardMaterial('rfm', this.scene);
    mat.diffuseColor = new Color3(0.25, 0.55, 0.95);
    mat.alpha = 0.22;
    mat.specularColor = new Color3(0, 0, 0);
    mat.backFaceCulling = false;
    mesh.material = mat;
    mesh.isPickable = false;
    return mesh;
  }

  /** 屏幕坐标 → 地面坐标（供 UI 按钮类操作复用） */
  screenToGround(clientX: number, clientY: number): Vector3 | null {
    const rect = this.engine.getInputElementClientRect();
    if (!rect) return null;
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const pick = this.scene.pick(x, y, (m) => m === this.ground);
    return pick?.hit ? pick.pickedPoint : null;
  }

  pointInAnyRegion(x: number, z: number): PlantRegion | null {
    if (!this.currentPlan) return null;
    for (const r of this.currentPlan.regions) {
      if (r.polygon.length >= 3 && pointInPolygon(x, z, r.polygon)) return r;
    }
    return null;
  }

  /** 圈选过程中的临时多边形预览 */
  setPendingPolygon(poly: [number, number][]): void {
    this.pendingMesh?.dispose();
    this.pendingMesh = null;
    if (poly.length < 2) return;
    const pts = poly.map(([x, z]) => new Vector3(x, 0.18, z));
    const lines = MeshBuilder.CreateLines('pending-poly', { points: pts, updatable: false }, this.scene);
    lines.color = new Color3(1, 0.85, 0.4);
    lines.isPickable = false;
    this.pendingMesh = lines;
  }

  clearPendingPolygon(): void {
    this.pendingMesh?.dispose();
    this.pendingMesh = null;
  }

  private startLoop(): void {
    this.engine.runRenderLoop(() => {
      const dt = this.engine.getDeltaTime() / 1000;
      this.renderer.tickWind(dt);
      this.renderer.update(this.camera.position, dt);
      this.scene.render();
      this.lastFps = this.engine.getFps();
    });
  }

  get fps(): number {
    return Math.round(this.lastFps);
  }

  get drawCalls(): number {
    return this.lastFrameDrawCalls;
  }

  /** 鸟瞰相机参数，导出截图前调用 */
  setBirdView(): void {
    if (!this.currentPlan) return;
    const size = this.currentPlan.site.size;
    this.camera.alpha = -Math.PI / 2;
    this.camera.beta = Math.PI / 3.4;
    this.camera.radius = size * 1.55;
    this.camera.target = Vector3.Zero();
  }

  dispose(): void {
    this.engine.stopRenderLoop();
    this.scene.dispose();
    this.engine.dispose();
  }
}

function centroid(poly: [number, number][]): [number, number] {
  let x = 0;
  let z = 0;
  for (const [px, pz] of poly) {
    x += px;
    z += pz;
  }
  return [x / poly.length, z / poly.length];
}
