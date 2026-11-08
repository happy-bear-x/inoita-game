/**
 * 标题页的更新日志：按条目顺序显示正文，不显示版本号或日期。
 * 内容集中在 `public/content/changelog.json`，点按钮时才加载。
 */
export interface ChangelogCatalog {
  version: 1;
  /** 每条是一段正文；空字符串会被内容校验拒绝。 */
  entries: string[];
}
