/**
 * 全局键盘路由：同一次按键只交给一个作用域，避免世界、菜单和弹层各订阅一次。
 *
 * 作用域从高到低固定为 `text-input`、`modal`、`menu`、`dialogue`、`world`。
 * 文本输入框有焦点时整场键盘归输入框；弹层打开时菜单和世界都不再收到按键。
 * 按钮点击、滚动和拖拽仍由 Phaser 自己的输入处理，这里只接键盘。
 */
const INPUT_SCOPES = ['text-input', 'modal', 'menu', 'dialogue', 'world'] as const;
type InputScope = typeof INPUT_SCOPES[number];
/** 返回 `true` 表示这次按键已被消费，不再交给后面的作用域。 */
type InputKeyHandler = (event: KeyboardEvent) => boolean;

interface InputScopeOptions {
  /** 当前是否接收按键；默认一直接收。 */
  active?: () => boolean;
  /**
   * 独占时，即使本次没有消费，也不再交给同作用域更早注册的处理器和更低的作用域。
   * 菜单、弹层和文本输入打开时用独占；世界和剧情层的普通按键用默认的 `false`。
   */
  exclusive?: () => boolean;
}

interface InputRouterOptions {
  /** 文本输入框是否正在接收键盘；默认检查 `document.activeElement`，测试可注入。 */
  textInputFocused?: () => boolean;
}

interface Registration {
  scope: InputScope;
  handler: InputKeyHandler;
  active: () => boolean;
  exclusive: () => boolean;
}

/** 当前焦点是否在可输入文本的 DOM 元素上。 */
function editingText(): boolean {
  const element = globalThis.document?.activeElement as HTMLElement | null | undefined;
  if (!element) return false;
  return element.tagName === 'INPUT' || element.tagName === 'TEXTAREA'
    || element.tagName === 'SELECT' || element.isContentEditable;
}

export class InputRouter {
  private readonly registrations: Registration[] = [];
  private readonly textInputFocused: () => boolean;

  constructor(options: InputRouterOptions = {}) {
    this.textInputFocused = options.textInputFocused ?? editingText;
  }

  /**
   * 注册一个键盘处理器，返回注销函数。同一作用域可以注册多个：后注册的先收到，
   * 用于标题页、职业选择这类互斥的全屏页面；场景关闭时必须调用注销函数。
   */
  register(scope: InputScope, handler: InputKeyHandler, options: InputScopeOptions = {}): () => void {
    const registration: Registration = {
      scope, handler,
      active: options.active ?? (() => true),
      exclusive: options.exclusive ?? (() => false)
    };
    this.registrations.push(registration);
    return () => {
      const index = this.registrations.indexOf(registration);
      if (index >= 0) this.registrations.splice(index, 1);
    };
  }

  /** 把原始键盘事件交给最高优先级的作用域；返回值表示这次按键是否被消费。 */
  dispatch(event: KeyboardEvent): boolean {
    // 输入框有焦点时，按键由 DOM 自己处理；游戏层全部让路。
    if (this.textInputFocused()) {
      const handler = this.activeIn('text-input').at(0)?.handler;
      if (handler) handler(event);
      return true;
    }
    for (const scope of INPUT_SCOPES) {
      if (scope === 'text-input') continue;
      for (const registration of this.activeIn(scope)) {
        // 取出来再调用，处理器不依赖 `this`；适配器需要状态时自己用箭头函数包一层。
        const handler = registration.handler;
        if (handler(event)) return true;
        if (registration.exclusive()) return false;
      }
    }
    return false;
  }

  /** 该作用域当前可用的处理器，后注册的排在前面。 */
  private activeIn(scope: InputScope): Registration[] {
    const active: Registration[] = [];
    for (let index = this.registrations.length - 1; index >= 0; index--) {
      const registration = this.registrations[index]!;
      if (registration.scope === scope && registration.active()) active.push(registration);
    }
    return active;
  }
}
