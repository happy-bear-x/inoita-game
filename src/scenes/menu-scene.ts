import Phaser from 'phaser';
import { SCENE_KEYS } from '../application/scene-keys.ts';
import type { MenuContext } from '../application/ports.ts';
import { SceneUiAssets } from '../ui/phaser/ui-asset-host.ts';
import { TitleMenuController } from '../ui/title-menu-controller.ts';

/** 场景持有常驻素材；每次进入标题页创建独立的界面。 */
export class MenuScene extends Phaser.Scene {
  readonly app:MenuContext;
  private readonly titleAssets:SceneUiAssets;
  private assetsBound=false;
  private page?:TitleMenuController;
  constructor(app:MenuContext){super(SCENE_KEYS.menu);this.app=app;this.titleAssets=new SceneUiAssets(this);}
  create(options:{page?:'home'|'slots'}={}):void {
    if(!this.assetsBound){this.assetsBound=true;this.events.once(Phaser.Scenes.Events.DESTROY,()=>this.titleAssets.releaseResident());}
    this.page?.dispose();
    const page=new TitleMenuController(this,this.app,this.titleAssets);this.page=page;
    this.events.once('shutdown',()=>{page.dispose();if(this.page===page)this.page=undefined;});
    page.open(options);
  }
}
