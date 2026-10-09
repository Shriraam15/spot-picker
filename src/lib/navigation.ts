export type AppPage = 'home' | 'search' | 'explore' | 'favorites' | 'history' | 'settings'

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
