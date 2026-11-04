/**
 * 每渲染帧共享的寻路扩展预算。
 *
 * 一次 A* 扩展要查地形和人物占位；几十个敌人各自同步跑完会叠成尖峰。
 * 所有 AI 从这里领预算，领完就等下一渲染帧，成本跟“这一帧能算多少”走，
 * 而不是跟“这一帧有多少个 AI 想算路”走。
 *
 * 份额按发起者预留：每个发起者每帧最多领 `每帧上限 / 上一帧的发起者数`。
 * 只限制总量仍是先到先得——队伍 AI 在逻辑帧里先执行，一次能领走 384 格，
 * 后面的敌人这一帧就拿不到；按上一帧的参与人数均分后，每个搜索者下一帧都有份。
 */
export class PathBudget {
  private readonly perFrame:number;
  private remaining:number;
  /** 当前这一帧出现过的发起者；同一发起者只记录一次。 */
  private readonly seen=new Set<string>();
  /** 上一帧的发起者数；没有请求的渲染帧不会把它清零。 */
  private participants=0;
  private readonly granted=new Map<string,number>();
  private share:number;
  constructor(perFrame:number){
    this.perFrame=perFrame;this.remaining=perFrame;this.share=this.shareFor(0);
  }
  reset():void{
    // 补帧时一个渲染帧可能推进两个逻辑帧，但总上限仍按渲染帧重置，总量不变。
    if(this.seen.size)this.participants=this.seen.size;
    this.seen.clear();this.granted.clear();
    this.remaining=this.perFrame;this.share=this.shareFor(this.participants);
  }
  /**
   * 领取最多 `limit` 个扩展；返回 0 表示这一帧该发起者不再推进搜索。
   * `owner` 是发起者标识（敌人 key 或队员 id），用来计算并累计本帧份额。
   */
  take(owner:string,limit:number):number{
    this.seen.add(owner);
    const used=this.granted.get(owner)??0;
    const granted=Math.max(0,Math.min(limit,this.remaining,this.share-used));
    if(granted>0){this.remaining-=granted;this.granted.set(owner,used+granted);}
    return granted;
  }
  private shareFor(participants:number):number{
    // 还没有历史时按 4 个发起者预留：单个单位第一帧不能领走整份预算。
    return Math.max(1,Math.floor(this.perFrame/Math.max(1,participants||4)));
  }
}
