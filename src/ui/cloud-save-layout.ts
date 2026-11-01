import { TEXT_COLORS } from './text-style.ts';

/** 云存档入口和面板的几何；面板沿用环境设置页的原版 slot 图框。 */
export const CLOUD_PAGE = {
  entry: { x: 1010, y: 21, width: 160, height: 67 },
  panel: { x: 200, y: 100, width: 800, height: 470 },
  titleY: 20,
} as const;

export type CloudPageStatusKind = 'info' | 'success' | 'error';

export interface CloudPageStatus {
  kind: CloudPageStatusKind;
  text: string;
}

export interface CloudPageState {
  available: boolean;
  account: string;
  passwordSet: boolean;
  loggedIn: boolean;
  busy: boolean;
  cloudCount?: number;
  status?: CloudPageStatus;
}

export interface CloudPageActions {
  back(): void;
  account(): void;
  password(): void;
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
