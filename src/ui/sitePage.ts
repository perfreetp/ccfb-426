import type { PlantRegion } from '../types';
import { store } from '../state/store';
import { h, slider, toast } from './dom';
import type { SceneManager, EditMode } from '../render/sceneManager';
import { polygonArea } from '../core/geometry';

/** 场地编辑页：单棵点种 / 圈区域按密度撒播 / 擦除 / 株距冲突提示 */
export class SitePage {
  private root = h('div');
  private scene: SceneManager;
  private mode: EditMode = 'view';
  private selectedSpeciesId: string;
  private density = 12;
  private pending: [number, number][] = [];
  private selectedTreeId: string | null = null;

  constructor(scene: SceneManager) {
    this.scene = scene;
    this.selectedSpeciesId = store.species[0]?.id ?? '';
  }

  render(): HTMLElement {
    const plan = store.currentPlan;
    this.root.innerHTML = '';
    if (!plan) {
      this.root.append(h('div', { class: 'empty', text: '请先在「方案」页创建或打开一个方案' }));
      return this.root;
    }

    this.root.append(
      h('div', { class: 'section-title', text: '编辑工具' }),
      h(
        'div',
        { class: 'toolgrid' },
        this.toolBtn('view', '👁 浏览', '旋转视角 / 点选树木'),
        this.toolBtn('plant', '🌱 点种', '在场地单击种下一棵树'),
        this.toolBtn('region', '⬡ 圈选撒播', '依次点击圈出区域，双击闭合'),
        this.toolBtn('erase', '✖ 擦除', '点击树木移除'),
      ),
    );

    if (this.mode === 'plant' || this.mode === 'region') {
      this.root.append(this.speciesPicker());
    }
    if (this.mode === 'region') {
      this.root.append(
        slider('撒播密度（株/100㎡）', this.density, 2, 40, 1, (v) => (this.density = v), (v) => `${v} 株`),
        h('div', { class: 'hint', text: `在场地中依次点击圈出多边形（至少 3 个点），双击或点「闭合区域」生成。已添加 ${this.pending.length} 个顶点。` }),
        h('div', { class: 'row', style: 'gap:8px' },
          h('button', {
            class: 'small',
            style: 'flex:1',
            text: '↩ 撤销顶点',
            onclick: () => {
              this.pending.pop();
              this.scene.setPendingPolygon(this.pending);
            },
          }),
          h('button', {
            class: 'small primary',
            style: 'flex:1',
            text: '✓ 闭合区域',
            onclick: () => this.closeRegion(),
          }),
        ),
      );
    }

    if (this.mode === 'erase') {
      this.root.append(h('div', { class: 'hint', text: '点击任意树木将其移除。区域撒播生成的树被单独擦除不影响区域本身。' }));
    }

    // 冲突提示
    if (plan.conflicts.length > 0) {
      this.root.append(
        h('div', { class: 'warn-box' },
          h('div', { text: `⚠ 检测到 ${plan.conflicts.length} 棵树冠距不足（场景中以红色标出）` }),
          h('div', { style: 'margin-top:6px' },
            h('button', {
              class: 'small danger',
              text: '全部移除冲突树',
              onclick: () => {
                store.removeTrees(new Set(plan.conflicts));
                toast('已移除冲突树木');
              },
            }),
          ),
        ),
      );
    }

    if (this.selectedTreeId) {
      const t = plan.trees.find((x) => x.id === this.selectedTreeId);
      if (t) {
        const sp = store.getSpecies(t.speciesId);
        this.root.append(
          h('div', { class: 'card' },
            h('div', { class: 'row' },
              h('span', { class: 'name', text: sp?.name ?? '未知树种' }),
              h('button', {
                class: 'small danger',
                text: '删除',
                onclick: () => {
                  store.removeTrees(new Set([t.id]));
                  this.selectedTreeId = null;
                  this.render();
                },
              }),
            ),
            h('div', { class: 'meta', text: `坐标 (${t.x.toFixed(1)}, ${t.z.toFixed(1)}) · 缩放 ${t.scale.toFixed(2)}${t.regionId ? ' · 区域撒播' : ' · 手动点种'}` }),
            slider('缩放', t.scale, 0.5, 1.8, 0.02, (v) => {
              t.scale = v;
              store.updatePlan(() => {});
            }, (v) => v.toFixed(2)),
          ),
        );
      }
    }

    // 区域列表
    this.root.append(h('div', { class: 'section-title', text: `撒播区域（${plan.regions.length}）` }));
    if (plan.regions.length === 0) {
      this.root.append(h('div', { class: 'empty', text: '暂无区域，使用「圈选撒播」工具创建' }));
    }
    for (const r of plan.regions) {
      const sp = store.getSpecies(r.speciesId);
      const area = polygonArea(r.polygon);
      const count = plan.trees.filter((t) => t.regionId === r.id).length;
      this.root.append(
        h('div', { class: 'card' },
          h('div', { class: 'row' },
            h('span', { class: 'name', text: sp?.name ?? '未知' }),
            h('span', { class: 'badge', text: `${count} 棵` }),
          ),
          h('div', { class: 'meta', text: `面积 ${area.toFixed(0)}㎡ · 密度 ${r.density} 株/100㎡` }),
          h('div', { style: 'margin-top:8px' },
            slider('密度', r.density, 2, 40, 1, (v) => {
              store.updateRegion(r.id, { density: v });
            }, (v) => `${v} 株`),
          ),
          h('div', { class: 'row', style: 'gap:6px' },
            h('button', {
              class: 'small',
              style: 'flex:1',
              text: '重新撒播（换种子）',
              onclick: () => store.updateRegion(r.id, { seed: Math.floor(Math.random() * 1e6) }),
            }),
            h('button', {
              class: 'small danger',
              style: 'flex:1',
              text: '删除区域',
              onclick: () => {
                if (confirm('删除区域会同时移除该区域撒播的树木，确定？')) {
                  store.removeRegion(r.id);
                  toast('区域已删除');
                }
              },
            }),
          ),
        ),
      );
    }

    this.root.append(
      h('div', { class: 'section-title', text: '场地统计' }),
      h('div', { class: 'card' },
        h('div', { class: 'meta', style: 'font-size:13px; line-height:2' },
          `场地边长：${plan.site.size} 米（${plan.site.size * plan.site.size} ㎡）`,
          h('br'),
          `树木总数：${plan.trees.length} 棵`,
          h('br'),
          `树种数：${new Set(plan.trees.map((t) => t.speciesId)).size} 种`,
        ),
      ),
    );
    return this.root;
  }

  private toolBtn(mode: EditMode, label: string, desc: string): HTMLElement {
    return h('button', {
      class: this.mode === mode ? 'toolbtn active' : 'toolbtn',
      onclick: () => this.setMode(mode),
    }, h('div', { text: label }), h('div', { style: 'font-size:11px;opacity:0.75', text: desc }));
  }

  private speciesPicker(): HTMLElement {
    const select = h('select', {
      onchange: (e: Event) => (this.selectedSpeciesId = (e.target as HTMLSelectElement).value),
    }) as HTMLSelectElement;
    for (const sp of store.species) {
      const opt = h('option', { value: sp.id, text: `${sp.name}（株距≥${sp.minSpacing}m）` }) as HTMLOptionElement;
      if (sp.id === this.selectedSpeciesId) opt.selected = true;
      select.append(opt);
    }
    return h('div', { class: 'field', style: 'margin-top:14px' }, h('label', { text: '选择树种' }), select);
  }

  private setMode(mode: EditMode): void {
    this.mode = mode;
    this.pending = [];
    this.scene.clearPendingPolygon();
    this.scene.setMode(mode);
    this.bindSceneCallbacks();
    this.render();
  }

  private bindSceneCallbacks(): void {
    this.scene.setCallbacks({
      onPlant: (x, z) => {
        if (!this.selectedSpeciesId) return toast('请先选择树种', true);
        store.addTree({ speciesId: this.selectedSpeciesId, x, z, rotation: Math.random() * Math.PI * 2, scale: 1 });
        const plan = store.currentPlan;
        if (plan && plan.conflicts.length > 0) {
          toast(`株距不足！当前 ${plan.conflicts.length} 棵树冲突`, true);
        }
      },
      onErase: (ids) => store.removeTrees(new Set(ids)),
      onRegionVertex: (x, z) => {
        // 双击闭合：pointer 事件会连续触发两次近似点
        const last = this.pending[this.pending.length - 1];
        if (last && Math.hypot(last[0] - x, last[1] - z) < 0.8) {
          this.closeRegion();
          return;
        }
        this.pending.push([x, z]);
        this.scene.setPendingPolygon(this.pending);
      },
      onSelectTree: (id) => {
        this.selectedTreeId = id;
        this.render();
      },
    });
  }

  private closeRegion(): void {
    if (this.pending.length < 3) return toast('至少需要 3 个顶点才能围成区域', true);
    const region: Omit<PlantRegion, 'id'> = {
      speciesId: this.selectedSpeciesId || store.species[0].id,
      polygon: this.pending.map(([x, z]) => [x, z]),
      density: this.density,
      seed: Math.floor(Math.random() * 1e6),
    };
    store.addRegion(region);
    this.pending = [];
    this.scene.clearPendingPolygon();
    toast('区域已创建并按密度撒播');
    this.render();
  }

  dispose(): void {
    this.scene.clearPendingPolygon();
    this.scene.setMode('view');
    this.scene.setCallbacks({});
  }
}
