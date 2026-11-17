import Phaser from 'phaser';
import { SCENE_KEYS } from '../application/scene-keys.ts';
import { ClassSelectionPage, type StoryClassApp } from '../ui/class-selection-page.ts';

export class StoryClassScene extends Phaser.Scene {
  private readonly app:StoryClassApp;
  private page?:ClassSelectionPage;
  constructor(app:StoryClassApp){super(SCENE_KEYS.classSelect);this.app=app;}
  create():void {
    const previous=this.page;
    if(previous){this.scale.off('resize',previous.layout,previous);previous.dispose();}
    const page=new ClassSelectionPage(this,this.app,()=>this.scene.restart());this.page=page;
    this.scale.on('resize',page.layout,page);
    this.events.once('shutdown',()=>{
      this.scale.off('resize',page.layout,page);
      page.dispose();if(this.page===page)this.page=undefined;
    });
    page.mount();
  }
  override update():void {this.page?.update();}
}
