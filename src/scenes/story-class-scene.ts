import Phaser from 'phaser';
import { SCENE_KEYS } from '../application/scene-keys.ts';
import { ClassSelectionPage, type StoryClassApp } from '../ui/class-selection-page.ts';

export class StoryClassScene extends Phaser.Scene {
  private readonly app:StoryClassApp;
  private page?:ClassSelectionPage;
  constructor(app:StoryClassApp){super(SCENE_KEYS.classSelect);this.app=app;}
  create():void {
    this.page?.dispose();
    const page=new ClassSelectionPage(this,this.app);this.page=page;
    this.events.once('shutdown',()=>{page.dispose();if(this.page===page)this.page=undefined;});
    page.mount();
  }
  override update():void {this.page?.update();}
}
