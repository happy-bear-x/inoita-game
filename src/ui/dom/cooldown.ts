import type { Cooldown } from '../../domain/combat.ts';
import { DomComponent } from './components.ts';

/** 冷却取游戏时间的数据，SVG 与文字只在对应值变化时更新。 */
export class DomCooldown extends DomComponent {
  private readonly svg: SVGSVGElement;
  private readonly fill: SVGPathElement;
  private readonly front: SVGPathElement;
  private readonly ring: SVGCircleElement;
  private readonly label: HTMLElement;
  private readonly anchor: 'center' | 'top-left';
  private key = '';
  constructor(parent: DomComponent | HTMLElement, anchor: 'center' | 'top-left' = 'center') {
    super(parent);
    this.anchor = anchor;
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    Object.assign(this.svg.style, { position: 'absolute', left: '0', top: '0', width: '100%', height: '100%', overflow: 'visible' });
    this.fill = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    this.fill.setAttribute('fill', 'rgba(0,0,0,.55)');
    this.front = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    this.front.setAttribute('stroke', '#ffe6a3'); this.front.setAttribute('stroke-width', '2'); this.front.setAttribute('opacity', '.9');
    this.ring = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    this.ring.setAttribute('stroke', '#ffe6a3'); this.ring.setAttribute('fill', 'none'); this.ring.setAttribute('opacity', '.45');
    this.svg.append(this.fill, this.front, this.ring); this.element.appendChild(this.svg);
    this.label = document.createElement('span');
    Object.assign(this.label.style, { position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)', fontSize: '24px', color: '#fff', lineHeight: '1' });
    this.element.appendChild(this.label);
    this.visible(false);
  }
  update(cooldown: Cooldown | undefined, radius: number, seconds = false): void {
    const active = !!cooldown && cooldown.remainingMs > 0;
    const remaining = active ? Math.min(1, Math.max(0, cooldown.durationMs > 0 ? cooldown.remainingMs / cooldown.durationMs : 1)) : 0;
    const text = active && seconds ? String(Math.ceil(cooldown.remainingMs / 1000)) : '';
    const key = `${remaining}|${radius}|${text}`;
    if (key === this.key) return;
    this.key = key; this.visible(active);
    if (!active) return;
    const offset = this.anchor === 'center' ? -radius : 0;
    this.rect({ x: offset, y: offset, width: radius * 2, height: radius * 2 });
    this.svg.setAttribute('viewBox', `${-radius} ${-radius} ${radius * 2} ${radius * 2}`);
    this.ring.setAttribute('r', String(Math.max(0, radius - 1)));
    const angle = -Math.PI / 2 + (1 - remaining) * Math.PI * 2, x = Math.cos(angle) * radius, y = Math.sin(angle) * radius;
    this.fill.setAttribute('d', remaining === 1
      ? `M 0 ${-radius} A ${radius} ${radius} 0 1 1 0 ${radius} A ${radius} ${radius} 0 1 1 0 ${-radius}`
      : `M 0 0 L ${x} ${y} A ${radius} ${radius} 0 ${remaining > .5 ? 1 : 0} 1 0 ${-radius} Z`);
    this.front.setAttribute('d', remaining > 0 && remaining < 1 ? `M 0 0 L ${x} ${y}` : '');
    if (this.label.textContent !== text) this.label.textContent = text;
  }
}
