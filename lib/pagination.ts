// Rows-per-page choices: multiples of 25 up to the backend's 200-row window cap.
export const PAGE_SIZES = [25, 50, 75, 100, 125, 150, 175, 200] as const;
export type PageSize = (typeof PAGE_SIZES)[number];
export const DEFAULT_PAGE_SIZE: PageSize = 50;

export function pageCount(total: number, pageSize: number): number {
  if (total <= 0) return 1;
  return Math.ceil(total / pageSize);
}
