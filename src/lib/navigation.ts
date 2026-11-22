// The router's navigate, for code outside React components' own hooks
// (editor node views, which render outside the router's context).

type Navigate = (to: string) => void;

let navigateFn: Navigate = (to) => {
  window.location.assign(to);
};

/** Installed by the layout, which has the router's navigate. */
export function setNavigate(fn: Navigate): void {
  navigateFn = fn;
}

export function go(to: string): void {
  navigateFn(to);
}

/** The address of a page, or of one block on it. */
export function pagePath(pageId: string, blockId?: string | null): string {
  return blockId ? `/page/${pageId}#${blockId}` : `/page/${pageId}`;
}
