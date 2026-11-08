/**
 * 浏览器页面自身的缩放和长按菜单。
 *
 * 游戏画布按窗口大小重排，页面一旦被缩放，画布、DOM 界面和触摸坐标就会对不上。
 * `index.html` 的 viewport 和 `game.css` 的 `touch-action` 已经挡掉大部分手势，
 * 但 iOS Safari 从 iOS 10 起会忽略 `user-scalable=no`；桌面浏览器还有
 * Ctrl/⌘ + 滚轮和 Ctrl/⌘ + `+`、`-`、`0` 两套整页缩放。长按则会在图片上弹出
 * 「保存图片」、在文字上开始选择，和游戏里的长按操作冲突。
 *
 * 输入框是例外：云存档账号密码和存档改名需要系统自带的粘贴、选择菜单。
 */

function editable(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && (target instanceof HTMLInputElement
      || target instanceof HTMLTextAreaElement
      || target.isContentEditable);
}

export function installPageInteractionGuard(): void {
  // iOS Safari 专有的 gesture 事件；其他浏览器不发，监听没有副作用。
  for (const type of ['gesturestart', 'gesturechange', 'gestureend'])
    document.addEventListener(type, event => event.preventDefault(), { passive: false });

  // 双指触摸兜底：少数浏览器既不认 touch-action，也不发 gesture 事件。
  document.addEventListener('touchmove', event => {
    if (event.touches.length > 1) event.preventDefault();
  }, { passive: false });

  // 桌面浏览器 Ctrl/⌘ + 滚轮（触控板双指捏合也会转成带 ctrlKey 的 wheel）。
  window.addEventListener('wheel', event => {
    if (event.ctrlKey || event.metaKey) event.preventDefault();
  }, { passive: false });

  // 桌面浏览器 Ctrl/⌘ + `+`、`-`、`0` 的整页缩放。
  window.addEventListener('keydown', event => {
    if (!(event.ctrlKey || event.metaKey)) return;
    if (event.key === '+' || event.key === '-' || event.key === '=' || event.key === '0')
      event.preventDefault();
  });

  // 长按选择、图片拖动和右键菜单；输入框保留原生的粘贴和编辑菜单。
  for (const type of ['contextmenu', 'selectstart', 'dragstart'])
    document.addEventListener(type, event => {
      if (!editable(event.target)) event.preventDefault();
    }, { capture: true });
}
