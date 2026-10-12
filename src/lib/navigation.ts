/**
 * The app's screens. `diagnostics` is deliberately not a tab: it is the screen
 * a user goes looking for when something is wrong, which is what the Settings
 * page is for, and a seventh tab would cost every screen a little width.
 */
export type AppPage =
  | 'home'
  | 'search'
  | 'explore'
  | 'favorites'
  | 'history'
  | 'settings'
  | 'diagnostics'

export interface NavigationState {
  currentPage: AppPage
  params: Record<string, unknown>
}

export function createNavigationState(): NavigationState {
  return {
    currentPage: 'home',
    params: {},
  }
}

export function navigateTo(page: AppPage, params: Record<string, unknown> = {}): NavigationState {
  return {
    currentPage: page,
    params,
  }
}
