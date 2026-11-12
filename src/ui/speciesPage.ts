import type { SpeciesParams, Season } from '../types';
import { store } from '../state/store';
import { h, slider, rgbToHex, hexToRgb, toast } from './dom';
import type { SceneManager } from '../render/sceneManager';

const SEASON_LABEL: Record<Season, string> = {
  spring: '春',
  summer: '夏',
  autumn: '秋',
  winter: '冬',
};

/** 树种库页：树种管理 + 参数化生成 + 3D 实时预览（同种子结果一致） */
export class SpeciesPage {
  private root = h('div');
  private scene: SceneManager;
  private editingId: string | null = null;
  /** 编辑缓冲：拖动滑块只更新本地对象，松手或切走时提交，避免每帧重建几何 */
  private draft: SpeciesParams | null = null;

  constructor(scene: SceneManager) {
    this.scene = scene;
  }

  private get editing(): SpeciesParams | null {
    return this.editingId ? store.getSpecies(this.editingId) ?? null : null;
  }

  render(): HTMLElement {
    this.root.innerHTML = '';
    this.commitDraft();

    this.root.append(h('div', { class: 'section-title', text: '树种库' }));
    const list = h('div');
    for (const sp of store.species) {
      const active = sp.id === this.editingId;
      list.append(
        h(
          'div',
          {
            class: active ? 'card selected' : 'card',
            onclick: () => this.select(sp.id),
          },
          h(
            'div',
            { class: 'row' },
            h('span', { class: 'swatch', style: `background:${rgbToHex(sp.leafColors.summer)}` }),
            h('span', { class: 'name', text: sp.name }),
            sp.builtin ? h('span', { class: 'badge builtin', text: '内置' }) : h('span', { class: 'badge', text: '自定义' }),
          ),
          h('div', { class: 'meta', text: `高 ${sp.height}m · 冠幅 ${sp.crownWidth}m · ${sp.deciduous ? '落叶' : '常绿'} · 种子 ${sp.seed}` }),
        ),
      );
    }
    this.root.append(list);

    this.root.append(
      h(
        'button',
        {
          class: 'primary',
          style: 'margin-top:8px',
          text: '+ 新建自定义树种',
          onclick: () => {
            const sp = store.createSpecies();
            this.select(sp.id);
            toast('已创建树种，调整参数实时预览');
          },
        },
      ),
    );

    if (this.editing) this.root.append(this.editor(this.editing));
    else this.root.append(h('div', { class: 'empty', text: '选择一个树种查看 3D 形态与参数' }));

    return this.root;
  }

  private select(id: string): void {
    this.commitDraft();
    this.editingId = id;
    const sp = store.getSpecies(id);
    if (sp) {
      this.draft = structuredClone(sp);
      this.scene.setPreviewSpecies(sp);
    }
    this.render();
  }

  /** 缓冲参数提交到 store（内置树种仅允许在预览中试验，不持久化） */
  private commitDraft(): void {
    if (!this.draft || !this.editingId) {
      this.draft = null;
      return;
    }
    const target = store.getSpecies(this.editingId);
    if (target && !target.builtin) {
      store.updateSpecies(this.editingId, this.draft);
    }
    this.draft = null;
  }

  private editor(sp: SpeciesParams): HTMLElement {
    const readonly = !!sp.builtin;
    const draft: SpeciesParams = this.draft ?? structuredClone(sp);
    this.draft = draft;

    const box = h('div');
    box.append(
      h('div', { class: 'section-title', text: readonly ? `参数预览（${sp.name} 为内置树种，另存后可改）` : '生成参数' }),
    );

    const nameInput = h('input', {
      value: draft.name,
      disabled: readonly ? true : undefined,
      onchange: (e: Event) => {
        draft.name = (e.target as HTMLInputElement).value;
        this.liveRefresh(draft);
      },
    }) as HTMLInputElement;
    box.append(h('div', { class: 'field' }, h('label', { text: '名称' }), nameInput));

    // 种子：相同种子 + 相同参数 => 相同形态
    const seedInput = h('input', {
      type: 'number',
      value: String(draft.seed),
      disabled: readonly ? true : undefined,
      onchange: (e: Event) => {
        draft.seed = parseInt((e.target as HTMLInputElement).value, 10) || 1;
        this.liveRefresh(draft);
      },
    }) as HTMLInputElement;
    box.append(
      h(
        'div',
        { class: 'field' },
        h('label', { text: '随机种子（同种子同形态）' }),
        h('div', { class: 'row' }, seedInput, h('button', {
          class: 'small',
          text: '换一个',
          onclick: () => {
            draft.seed = Math.floor(Math.random() * 1e6);
            seedInput.value = String(draft.seed);
            this.liveRefresh(draft);
          },
        })),
      ),
    );

    box.append(
      slider('成树高度（米）', draft.height, 3, 20, 0.5, (v) => { draft.height = v; this.liveRefresh(draft); }, (v) => `${v.toFixed(1)} m`),
      slider('冠幅（米）', draft.crownWidth, 1.5, 12, 0.25, (v) => { draft.crownWidth = v; this.liveRefresh(draft); }, (v) => `${v.toFixed(2)} m`),
      slider('分枝深度（递归层级）', draft.branchDepth, 3, 7, 1, (v) => { draft.branchDepth = v; this.liveRefresh(draft); }, (v) => `${v} 层`),
      slider('分枝角度', draft.branchAngle, 0.2, 1.4, 0.02, (v) => { draft.branchAngle = v; this.liveRefresh(draft); }, (v) => `${Math.round((v * 180) / Math.PI)}°`),
      slider('每节分枝数', draft.branchesPerNode, 2, 5, 1, (v) => { draft.branchesPerNode = v; this.liveRefresh(draft); }, (v) => `${v} 枝`),
      slider('叶密度', draft.leafDensity, 0.1, 1, 0.05, (v) => { draft.leafDensity = v; this.liveRefresh(draft); }, (v) => `${Math.round(v * 100)}%`),
      slider('最小株距（米）', draft.minSpacing, 1, 8, 0.1, (v) => { draft.minSpacing = v; }, (v) => `${v.toFixed(1)} m`),
    );

    const deciduousBox = h('input', {
      type: 'checkbox',
      disabled: readonly ? true : undefined,
      onchange: (e: Event) => {
        draft.deciduous = (e.target as HTMLInputElement).checked;
        this.liveRefresh(draft);
      },
    }) as HTMLInputElement;
    deciduousBox.checked = draft.deciduous;
    box.append(
      h('div', { class: 'checkbox-row' },
        deciduousBox,
        h('span', { text: '落叶树（冬季落叶，只剩枝干）' }),
      ),
    );

    // 叶色（春/夏/秋）
    box.append(h('div', { class: 'section-title', text: '叶色（春 / 夏 / 秋）' }));
    (['spring', 'summer', 'autumn'] as const).forEach((season) => {
      const color = h('input', {
        type: 'color',
        value: rgbToHex(draft.leafColors[season]),
        onchange: (e: Event) => {
          draft.leafColors[season] = hexToRgb((e.target as HTMLInputElement).value);
          this.liveRefresh(draft);
        },
      }) as HTMLInputElement;
      box.append(h('div', { class: 'color-row' }, color, h('span', { text: SEASON_LABEL[season] + '季叶色' })));
    });
    const bark = h('input', {
      type: 'color',
      value: rgbToHex(draft.barkColor),
      onchange: (e: Event) => {
        draft.barkColor = hexToRgb((e.target as HTMLInputElement).value);
        this.liveRefresh(draft);
      },
    }) as HTMLInputElement;
    box.append(h('div', { class: 'color-row' }, bark, h('span', { text: '树干颜色' })));

    if (readonly) {
      box.append(
        h('button', {
          class: 'primary',
          style: 'margin-top:10px',
          text: '另存为自定义树种',
          onclick: () => {
            const copy = store.createSpecies({ ...draft, name: `${draft.name} 改良` });
            this.editingId = copy.id;
            this.draft = null;
            store.updateSpecies(copy.id, draft);
            this.select(copy.id);
            toast('已另存为自定义树种');
          },
        }),
      );
    } else {
      box.append(
        h(
          'div',
          { class: 'row', style: 'margin-top:12px; gap:8px' },
          h('button', {
            class: 'small',
            style: 'flex:1',
            text: '保存修改',
            onclick: () => {
              this.commitDraft();
              toast('树种已保存');
              this.render();
            },
          }),
          h('button', {
            class: 'small danger',
            style: 'flex:1',
            text: '删除树种',
            onclick: () => {
              if (confirm(`删除树种「${sp.name}」？已使用该树种的方案不受影响但将无法显示其形态。`)) {
                store.deleteSpecies(sp.id);
                this.editingId = null;
                this.scene.setPreviewSpecies(null);
                this.render();
              }
            },
          }),
        ),
      );
    }
    return box;
  }

  /** 拖拽中实时刷新预览（不经过 store，不重建持久化数据） */
  private liveRefresh(draft: SpeciesParams): void {
    this.scene.setPreviewSpecies(draft);
  }

  dispose(): void {
    this.commitDraft();
    this.scene.setPreviewSpecies(null);
    this.editingId = null;
  }
}
