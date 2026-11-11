// The desktop app's bridge to the board window (desktop/preload.cts), as the page scripts call it: an action goes to
// the board server without a network hop, Appearance reaches the window's title bar and menus, and Settings → Shortcuts
// reads and writes keybindings.json (desktop/keybindings.ts). The web prototype has no bridge: window.yeschef is
// undefined there, and each page script checks for it.

/** What a keybindings.json call answers: the list read, a write or open done, or why not. */
export type KeysReply = { list?: unknown; ok?: boolean; wrote?: boolean; error?: string };

export interface Bridge {
  act?: (body: string) => Promise<[number, string]>;
  theme?: (theme: string) => Promise<unknown>;
  keys?: { read(): Promise<KeysReply | null>; write(list: unknown): Promise<KeysReply | null>; open(): Promise<KeysReply | null> };
}

declare global {
  interface Window {
    yeschef?: Bridge;
    /** The board page answers whether a send still waits on its Undo or its answer: Quit waits for it (desktop/main.ts). */
    __ycBusy?: () => boolean;
    /** The board page redraws in place: a reload never leaves the page while a send waits (desktop/main.ts). */
    __ycSoftReload?: () => void;
  }
}
