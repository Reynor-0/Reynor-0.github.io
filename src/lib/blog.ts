export const CATEGORY_ORDER = [
  "驱动",
  "协议",
  "操作系统",
  "架构",
  "方法",
  "项目",
] as const;

export function tagSlug(tag: string) {
  return encodeURIComponent(tag.trim()).replaceAll("%", "").toLowerCase();
}
