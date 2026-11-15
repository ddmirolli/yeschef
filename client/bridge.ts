// The desktop app's bridge to the board window (desktop/preload.cts), as the page scripts call it: an action goes to
// the board server without a network hop, Appearance reaches the window's title bar and menus, and Settings → Shortcuts
// reads and writes keybindings.json (desktop/keybindings.ts), and Settings → About reads the updater and switches the
// update track (desktop/main.ts, as T3 Code's desktop:update-* channels). The web prototype has no bridge: window.yeschef is
// undefined there, and each page script checks for it.

/** What a keybindings.json call answers: the list read, a write or open done, or why not. */
export type KeysReply = { list?: unknown; ok?: boolean; wrote?: boolean; error?: string };

/** Settings → About's view of the updater (desktop/main.ts updateInfo), as T3 Code's DesktopUpdateState. */
export interface UpdateInfo {
  /** The running version, and the track it was built for. */
  version: string; own: 'latest' | 'nightly';
  /** The saved track: the one checks follow. */
  channel: 'latest' | 'nightly';
  enabled: boolean; canSwitch: boolean;
  status: 'off' | 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'current' | 'error';
  /** The version an update offers, downloads or has ready. */
  available: string | null; percent: number | null;
  /** While a switch runs: the track it switches to. */
  switching: 'latest' | 'nightly' | null;
  message: string | null;
}
/** What a track switch answers: it found a build and downloads it (ok), or why not. */
export type SwitchReply = { ok?: boolean; error?: string };

export interface Bridge {
  act?: (body: string) => Promise<[number, string]>;
  theme?: (theme: string) => Promise<unknown>;
  keys?: { read(): Promise<KeysReply | null>; write(list: unknown): Promise<KeysReply | null>; open(): Promise<KeysReply | null> };
  updates?: {
    get(): Promise<UpdateInfo | { error: string }>;
    /** check, download or restart, as the update card's buttons. */
    act(id: 'check' | 'download' | 'restart'): Promise<UpdateInfo | { error: string }>;
    setChannel(channel: 'latest' | 'nightly'): Promise<SwitchReply>;
    /** Every change the updater makes, while the page is open. One listener: a new one replaces the last. */
    onState(listener: (info: UpdateInfo) => void): void;
  };
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
