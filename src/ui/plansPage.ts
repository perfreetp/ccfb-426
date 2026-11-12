import { store } from '../state/store';
import { h, toast } from './dom';

/** 方案列表页：新建/复制/删除/重命名/选择/导入 */
export class PlansPage {
  private root = h('div');

  render(): HTMLElement {
    this.root.innerHTML = '';
    this.root.append(
      h('div', { class: 'section-title', text: '种植方案' }),
      h('button', {
        class: 'primary',
        text: '+ 新建方案',
        onclick: () => {
          const p = store.createPlan();
          toast(`已创建「${p.name}」`);
        },
      }),
    );

    if (store.plans.length === 0) {
      this.root.append(h('div', { class: 'empty', text: '还没有方案，点击上方按钮创建' }));
      return this.root;
    }

    const list = h('div', { style: 'margin-top:14px' });
    for (const p of store.plans) {
      const isCurrent = p.id === store.currentPlanId;
      const nameInput = h('input', {
        value: p.name,
        onchange: (e: Event) => store.renamePlan(p.id, (e.target as HTMLInputElement).value || p.name),
      }) as HTMLInputElement;

      const card = h(
        'div',
        { class: isCurrent ? 'card selected' : 'card' },
        h('div', { class: 'row' }, nameInput),
        h(
          'div',
          { class: 'meta' },
          `${p.trees.length} 棵树 · ${p.regions.length} 个区域 · ${new Date(p.updatedAt).toLocaleString('zh-CN')}`,
        ),
        h(
          'div',
          { class: 'row', style: 'margin-top:10px; gap:6px; flex-wrap:wrap' },
          h('button', {
            class: 'small',
            text: isCurrent ? '✓ 当前' : '打开',
            onclick: () => store.selectPlan(p.id),
          }),
          h('button', {
            class: 'small',
            text: '复制',
            onclick: () => {
              store.duplicatePlan(p.id);
              toast('已复制方案');
            },
          }),
          h('button', {
            class: 'small danger',
            text: '删除',
            onclick: () => {
              if (confirm(`确定删除方案「${p.name}」？此操作不可恢复。`)) {
                store.deletePlan(p.id);
                toast('方案已删除');
              }
            },
          }),
        ),
      );
      list.append(card);
    }
    this.root.append(list);

    this.root.append(
      h('div', { class: 'section-title', text: '从同事处导入' }),
      h('button', {
        class: '',
        style: 'width:100%',
        text: '导入方案文件（.garden.json）',
        onclick: () => {
          const input = document.createElement('input');
          input.type = 'file';
          input.accept = '.json,application/json';
          input.onchange = () => {
            const file = input.files?.[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => {
              try {
                const data = JSON.parse(String(reader.result));
                const plan = store.importPlan(data);
                toast(`已导入「${plan.name}」`);
              } catch (e) {
                toast(`导入失败：${(e as Error).message}`, true);
              }
            };
            reader.readAsText(file);
          };
          input.click();
        },
      }),
      h('div', { class: 'hint', text: '方案每 0.8 秒自动保存到浏览器 IndexedDB，关闭页面不丢失。' }),
    );
    return this.root;
  }
}
