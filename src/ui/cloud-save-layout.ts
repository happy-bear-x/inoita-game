import { TEXT_COLORS } from './text-style.ts';

const PANEL = { x: 200, y: 80, width: 800, height: 520 } as const;
/**
 * 原版 slot 图框的金线内缩约 28×47 像素。内容再缩进一层：横向 72、
 * 纵向从框顶 84 开始，底部留 72，和标题设置页的滚动区取同一套内边距。
 */
const CONTENT = {
  left: PANEL.x + 72,
  top: PANEL.y + 84,
  width: PANEL.width - 72 - 72,
  bottom: PANEL.y + PANEL.height - 72,
} as const;

/**
 * 云存档入口、面板和内部控件几何。账号/密码输入框由 DOM 覆盖层绘制，
 * 这里的矩形既给面板留标签位置，也给覆盖层定位。
 */
export const CLOUD_PAGE = {
  entry: { x: 1010, y: 21, width: 160, height: 67 },
  panel: PANEL,
  titleY: 20,
  content: CONTENT,
  accountLabel: { x: CONTENT.left, y: CONTENT.top },
  passwordLabel: { x: CONTENT.left, y: CONTENT.top + 74 },
  accountInput: { x: CONTENT.left + 90, y: CONTENT.top - 6, width: CONTENT.width - 90, height: 48, fontSize: 24 },
  passwordInput: { x: CONTENT.left + 90, y: CONTENT.top + 68, width: CONTENT.width - 90, height: 48, fontSize: 24 },
  login: { x: CONTENT.left + 100, y: CONTENT.top + 150, width: 200, height: 72 },
  register: { x: CONTENT.left + 360, y: CONTENT.top + 150, width: 200, height: 72 },
  /** 登录前、登录后的说明与状态都放进框内滚动区，长文本不会压到边框。 */
  note: { x: CONTENT.left, y: CONTENT.top + 236, width: CONTENT.width, height: CONTENT.bottom - (CONTENT.top + 236) },
  loggedInNote: { x: CONTENT.left, y: CONTENT.top + 226, width: CONTENT.width, height: CONTENT.bottom - (CONTENT.top + 226) },
  changePassword: { x: CONTENT.left + CONTENT.width - 160, y: CONTENT.top - 14, width: 160, height: 56 },
  actions: { x: CONTENT.left, y: CONTENT.top + 100, width: 200, height: 72, step: 220 },
} as const;

type CloudPageStatusKind = 'info' | 'success' | 'error';

export interface CloudPageStatus {
  kind: CloudPageStatusKind;
  text: string;
}

export interface CloudPageState {
  available: boolean;
  account: string;
  loggedIn: boolean;
  busy: boolean;
  cloudCount?: number;
  status?: CloudPageStatus;
}

export interface CloudPageActions {
  back(): void;
  login(): void;
  register(): void;
  upload(): void;
  download(): void;
  changePassword(): void;
  logout(): void;
}

export function cloudStatusColor(kind: CloudPageStatusKind): string {
  if (kind === 'success') return TEXT_COLORS.success;
  if (kind === 'error') return TEXT_COLORS.dangerSoft;
  return TEXT_COLORS.primary;
}

/** 忙碌时优先显示进度；空闲时显示上一条成功/失败信息。 */
export function cloudStatusText(state: CloudPageState): string | undefined {
  if (state.busy) return state.status?.text ?? '正在连接云端…';
  return state.status?.text;
}

export function cloudStatusKind(state: CloudPageState): CloudPageStatusKind {
  return state.busy ? 'info' : state.status?.kind ?? 'info';
}
