/**
 * 标题页的更新日志：顶部显示标题页版本号，正文按条目顺序编号。
 * 内容集中在 `public/content/changelog.json`，点按钮时才加载。
 */
export interface ChangelogCatalog {
  version: 1;
  /** 每条是一段正文；空字符串会被内容校验拒绝。 */
  entries: string[];
}
