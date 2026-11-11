export function initialView(search: string): 'solo' | 'team' {
  return new URLSearchParams(search).get('view') === 'solo' ? 'solo' : 'team';
}
