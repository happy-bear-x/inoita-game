import assert from 'node:assert/strict';
import test, {after} from 'node:test';
import { DomUi } from '../src/ui/dom/dom-ui.ts';
import { MenuTextLayer } from '../src/ui/dom/menu-text.ts';
import { installMenuDom } from './support/menu-dom.ts';

after(installMenuDom());

test('text follows translated viewports and anchor changes without recreating labels',()=>{
  const dom=new DomUi();let x=10,y=20;const labels:ReturnType<DomUi['label']>[]=[];
  const layer=new MenuTextLayer({label:(...args)=>{const label=dom.label(...args);labels.push(label);return label;}},(px,py)=>({x:x+px,y:y+py,scale:1}),()=>0);
  layer.register('page',writer=>writer.add({key:'title',text:'人物',x:30,y:40,style:{size:20}}));
  layer.renderPage('page');const label=labels[0];assert(label.element.style.transform.includes('40px, 60px'));
  x=100;y=200;layer.refresh();assert.equal(labels.length,1);assert(label.element.style.transform.includes('130px, 240px'));
  label.setAnchor(.5,1);assert(label.element.style.transform.includes('translate(-50%, -100%)'));
  layer.destroy();
});

