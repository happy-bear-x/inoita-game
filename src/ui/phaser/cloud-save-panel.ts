import { TEXT_COLORS } from '../text-style.ts';
import {
  CLOUD_PAGE,
  cloudStatusColor,
  cloudStatusKind,
  cloudStatusText,
  type CloudPageActions,
  type CloudPageState,
} from '../cloud-save-layout.ts';
import type { UiSurface } from './widgets.ts';

export interface CloudSavePageAssets {
  frame: string;
  close: string;
  closePressed: string;
}

function drawStatus(view: UiSurface, state: CloudPageState, left: number, y: number, width: number): void {
  const text = cloudStatusText(state);
  if (!text) return;
  view.text(text, left, y, width, 22, cloudStatusColor(cloudStatusKind(state)));
}

/**
 * 云存档页：账号/密码输入、登录注册，或已登录后的导入/下载/退出。
 * 图框和关闭钮与存档槽页共用；忙碌时只禁用动作，返回钮始终可用。
 */
export function drawCloudSavePage(
  view: UiSurface,
  state: CloudPageState,
  actions: CloudPageActions,
  assets: CloudSavePageAssets,
): void {
  view.button('', 28, 21, 67, 67, actions.back, { image: assets.close, pressed: assets.closePressed })
    .setData('label', '返回存档');
  view.text('云存档', 600, CLOUD_PAGE.titleY, 760, 49).setOrigin(.5, 0);
  const panel = CLOUD_PAGE.panel;
  view.image(assets.frame, panel.x, panel.y, panel.width, panel.height);
  const left = panel.x + 40;
  const right = panel.x + panel.width - 40;
  const width = right - left;
  const disabled = state.busy || !state.available;

  if (!state.loggedIn) {
    let y = panel.y + 50;
    view.text('账号', left, y, 80, 28);
    view.text(state.account || '未填写', left + 90, y, width - 260, 28,
      state.account ? TEXT_COLORS.primary : TEXT_COLORS.muted);
    view.button('输入账号', right - 160, y - 14, 160, 56, actions.account, { fontSize: 24, disabled });
    y += 90;
    view.text('密码', left, y, 80, 28);
    view.text(state.passwordSet ? '已填写' : '未填写', left + 90, y, width - 260, 28,
      state.passwordSet ? TEXT_COLORS.primary : TEXT_COLORS.muted);
    view.button('输入密码', right - 160, y - 14, 160, 56, actions.password, { fontSize: 24, disabled });
    y += 90;
    view.button('登录', left + 100, y, 200, 72, actions.login, { fontSize: 30, disabled });
    view.button('注册', left + 360, y, 200, 72, actions.register, { fontSize: 30, disabled });
    y += 100;
    view.text(
      '账号 3–24 位字母、数字、下划线或汉字，不区分大小写；密码 6–64 位，区分大小写。'
      + '连续输错 3 次锁定 15 分钟；同一账号只允许一处登录。忘记密码无法找回。',
      left, y, width, 18, TEXT_COLORS.secondary,
    );
    drawStatus(view, state, left, y + 84, width);
  } else {
    let y = panel.y + 55;
    view.text(`已登录：${state.account}`, left, y, width, 30);
    y += 48;
    view.text(state.cloudCount === undefined ? '云端存档：正在读取…' : `云端存档：${state.cloudCount} 个`,
      left, y, width, 22, TEXT_COLORS.secondary);
    y += 58;
    view.button('导入本机存档', left, y, 220, 72, actions.upload, { fontSize: 23, disabled });
    view.button('下载云存档', left + 240, y, 220, 72, actions.download, { fontSize: 23, disabled });
    view.button('退出登录', left + 480, y, 220, 72, actions.logout, { fontSize: 23, disabled });
    y += 100;
    view.text('导入：把本机现有存档上传到云端。', left, y, width, 20, TEXT_COLORS.secondary);
    view.text('下载：把云端存档写回本机同号槽位；覆盖后本机原内容无法恢复。',
      left, y + 30, width, 20, TEXT_COLORS.secondary);
    drawStatus(view, state, left, y + 78, width);
  }
  if (!state.available && !cloudStatusText(state)) {
    view.text('云存档暂不可用，本机存档不受影响。', left, panel.y + panel.height - 48, width, 20, TEXT_COLORS.dangerSoft);
  }
}
