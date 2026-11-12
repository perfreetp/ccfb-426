import { store } from './state/store';
import { SceneManager } from './render/sceneManager';
import { PlansPage } from './ui/plansPage';
import { SpeciesPage } from './ui/speciesPage';
import { SitePage } from './ui/sitePage';
import { SeasonPage } from './ui/seasonPage';
import { ExportPage } from './ui/exportPage';
import { h } from './ui/dom';
import type { SpeciesParams } from './types';
import { templateKey } from './core/treeGenerator';
import './ui/styles.css';

type TabId = 'plans' | 'species' | 'site' | 'season' | 'export';

const TABS: { id: TabId; label: string }[] = [
  { id: 'plans', label: '方案' },
  { id: 'species', label: '树种库' },
  { id: 'site', label: '场地编辑' },
  { id: 'season', label: '四季预览' },
  { id: 'export', label: '导出' },
];

/** 应用外壳：顶栏页签 + 侧栏页面 + 3D 视口 */
class App {
  private tab: TabId = 'plans';
  private scene!: SceneManager;
  private sidebar = h('div', { class: 'sidebar' });
  private hudFps = h('b', { text: '0' });
  private hudDraw = h('b', { text: '0' });
  private hudTrees = h('b', { text: '0' });
  private hudLod = h('b', { text: '-' });
  private page: { dispose?: () => void; render?: () => HTMLElement } | null = null;
  private lastTreeFp = '';
  private lastSpeciesFp = '';
  private lastSeason = '';

  async start(): Promise<void> {
    await store.init();
    if (store.plans.length === 0) store.createPlan('示范方案');

    const canvas = h('canvas', { style: 'width:100%;height:100%;display:block;touch-action:none' }) as HTMLCanvasElement;
    const viewport = h('div', { class: 'viewport' }, canvas, this.buildHud());

    this.scene = new SceneManager(canvas);
    // 调试/自动化测试句柄
    (window as unknown as { __sceneManager: SceneManager }).__sceneManager = this.scene;
    (window as unknown as { __sceneEngine: unknown }).__sceneEngine = this.scene.engine;
    this.syncFromStore(true);

    const topbar = h(
      'div',
      { class: 'topbar' },
      h('div', { class: 'logo', text: '🌳 园林植物配置预览' }),
      h('div', { class: 'tabs' }, ...TABS.map((t) =>
        h('button', {
          class: this.tab === t.id ? 'tab active' : 'tab',
          onclick: () => this.switchTab(t.id),
          text: t.label,
        }),
      )),
      h('div', { class: 'status' },
        h('span', {}, document.createTextNode('自动保存 '), h('b', { text: '已开启' })),
      ),
    );

    const main = h('div', { class: 'main' }, this.sidebar, viewport);
    const root = document.getElementById('app')!;
    root.append(topbar, main);

    // store 变更 => 渲染层同步（指纹守卫，太阳拖拽不触发几何重建）
    store.subscribe(() => this.syncFromStore(false));
    this.startHudTimer();
    this.renderPage();

    // 窗口尺寸变化
    const ro = new ResizeObserver(() => this.scene.engine.resize());
    ro.observe(viewport);
  }

  private buildHud(): HTMLElement {
    return h('div', { class: 'hud' },
      h('span', {}, document.createTextNode('FPS '), this.hudFps),
      h('span', {}, document.createTextNode('Draw Calls '), this.hudDraw),
      h('span', {}, document.createTextNode('树木 '), this.hudTrees),
      h('span', {}, document.createTextNode('LOD '), this.hudLod),
    );
  }

  private switchTab(tab: TabId): void {
    this.page?.dispose?.();
    this.page = null;
    this.tab = tab;
    // 离开树种库时退出预览
    if (tab !== 'species') this.scene.setPreviewSpecies(null);
    document.querySelectorAll('.tab').forEach((el, i) => {
      el.className = TABS[i].id === tab ? 'tab active' : 'tab';
    });
    this.syncFromStore(true);
    this.renderPage();
  }

  private renderPage(): void {
    this.sidebar.innerHTML = '';
    switch (this.tab) {
      case 'plans':
        this.page = new PlansPage();
        break;
      case 'species':
        this.page = new SpeciesPage(this.scene);
        break;
      case 'site':
        this.page = new SitePage(this.scene);
        break;
      case 'season':
        this.page = new SeasonPage(this.scene);
        break;
      case 'export':
        this.page = new ExportPage(this.scene);
        break;
    }
    if (this.page && 'render' in this.page) {
      this.sidebar.append((this.page as { render: () => HTMLElement }).render());
    }
  }

  /** 把 store 数据同步到 3D 场景；force 用于切页/首次加载 */
  private syncFromStore(force: boolean): void {
    const plan = store.currentPlan;
    if (!plan) return;

    const treeFp = store.planFingerprint(plan);
    const speciesFp = store.species.map((s: SpeciesParams) => templateKey(s)).join('||');
    const treeChanged = force || treeFp !== this.lastTreeFp;
    const speciesChanged = force || speciesFp !== this.lastSpeciesFp;
    const seasonChanged = force || plan.season !== this.lastSeason;

    if (treeChanged || speciesChanged || seasonChanged) {
      if (!this.scene.isPreview) {
        this.scene.syncPlan(plan, store.species);
      }
      this.lastTreeFp = treeFp;
      this.lastSpeciesFp = speciesFp;
      this.lastSeason = plan.season;
    }

    // 当前页重绘（侧栏统计/冲突数等）；正在操作表单时跳过，避免输入丢焦点
    const active = document.activeElement;
    const typing = active && ['INPUT', 'SELECT', 'TEXTAREA'].includes(active.tagName);
    if (!typing) {
      if (this.page && 'render' in this.page) {
        this.sidebar.innerHTML = '';
        this.sidebar.append((this.page as { render: () => HTMLElement }).render());
      }
    }
  }

  private startHudTimer(): void {
    setInterval(() => {
      this.hudFps.textContent = String(this.scene.fps);
      this.hudDraw.textContent = String(this.scene.drawCalls);
      const plan = store.currentPlan;
      this.hudTrees.textContent = String(plan?.trees.length ?? 0);
      this.hudLod.textContent = this.scene.isPreview ? '预览' : '高/低/公告板';
    }, 500);
  }
}

new App().start().catch((e) => {
  console.error(e);
  document.getElementById('app')!.innerHTML = `<div style="padding:40px;color:#d9655a">初始化失败：${(e as Error).message}</div>`;
});
