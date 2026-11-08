/**
 * 普攻连打的输入门控。
 *
 * 原版 `GAMESTATE_PressKeyPlay @0x12f6f8` 的攻击键分支只在角色站立时
 * （`CHAR_IsCurrentActionStand`）发起 `CHAR_StartActionEx(ch, CHAR_GetDefaultAttack(ch), 1)`，
 * 触摸层按住会持续重复按键事件，所以出手一结束、人还站着就接下一击。复刻版按同一门控
 * 做成「开始攻击之后站定自动连打」：摇杆一动会清当前目标（`CHAR_SetTarget(ch,0)`），
 * 连打随之停止；玩家完成一次对敌技能后，也会尝试接一次普攻。
 */
interface BasicAttackRepeatState {
  /** 当前选中的目标；空表示连打结束。 */
  targetId: string | undefined;
  attackState: 'idle' | 'approaching' | 'attacking';
}

export class BasicAttackRepeat {
  private engaged = false;
  private firstAfterSkill = false;
  /** 玩家发起一次普攻时调用；按交互键不算。 */
  engage(): void { this.engaged = true; this.firstAfterSkill = false; }
  /** 攻击技能完成后尝试一次普攻；无锁定目标时由普攻规则搜索。 */
  engageAfterSkill(): void { this.engaged = true; this.firstAfterSkill = true; }
  /** 停手：摇杆一动（目标被清掉）时调用；目标死亡由 `next` 自己发现。 */
  release(): void { this.engaged = false; this.firstAfterSkill = false; }
  get active(): boolean { return this.engaged; }
  /** 每帧问一次：这一帧要不要自动接下一击；技能结束后的首次普攻可自行找目标。 */
  next(state: BasicAttackRepeatState): boolean {
    if (!this.engaged) return false;
    if (!state.targetId && !this.firstAfterSkill) { this.release(); return false; }
    if (state.attackState !== 'idle') return false;
    this.firstAfterSkill = false;
    return true;
  }
}
