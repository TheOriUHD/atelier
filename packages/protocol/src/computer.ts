/**
 * Computer use (docs/ARCHITECTURE.md §22): the assistant sees and acts in apps on the person's computer, in the apps
 * they allow. The desktop app's main process owns it (`apps/desktop/src/computer/`) and drives a native helper per OS
 * (`native/computer-macos/` on macOS) over computer protocol v1: JSON-RPC 2.0, one JSON object per line over stdio,
 * like the runner's. The helper only does what the OS offers (screenshots, input, apps); every rule lives in main.
 * Mirrored by hand in `native/computer-macos/Sources/AtelierComputer/Protocol.swift`; keep both in sync.
 */
import { z } from 'zod';

export const COMPUTER_PROTOCOL_VERSION = 1;

/** JSON-RPC error codes the helper returns. */
export const ComputerErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  Internal: -32603,
  NotInitialized: -32002,
  /** The OS permission is missing; `data.permission` is `accessibility` or `screenRecording`. */
  Permission: -32030,
  /** The person held Esc: input is refused until `control.resume`. */
  Stopped: -32031,
  /** Not something this OS or helper can do. */
  Unsupported: -32032,
  /** No such app or display. */
  NotFound: -32033,
} as const;

// ---------------------------------------------------------------- apps, as the person and the model see them

/**
 * How much the assistant may do in an app: `view` takes screenshots only, `click` adds left clicks and scrolling (no
 * typing, keys, right clicks or drags), `full` everything.
 */
export const AppTier = z.enum(['view', 'click', 'full']);
export type AppTier = z.infer<typeof AppTier>;

/** What kind of app it is: decides its default tier, and whether it may be allowed at all (`system`). */
export const AppCategory = z.enum(['browser', 'terminal', 'ide', 'mail', 'messaging', 'password-manager', 'system', 'other']);
export type AppCategory = z.infer<typeof AppCategory>;

/** An app on this computer: its id (the bundle id on macOS) and name. */
export const ComputerApp = z.object({ id: z.string().min(1).max(300), name: z.string().min(1).max(200) });
export type ComputerApp = z.infer<typeof ComputerApp>;

export const AppGrant = z.object({ app: ComputerApp, tier: AppTier });
export type AppGrant = z.infer<typeof AppGrant>;

/**
 * How the assistant uses the apps it may use: `background` works inside them while the person keeps using the computer
 * and asks before taking over the screen; `full` takes over the screen, mouse and keyboard whenever it uses one.
 */
export const ComputerMode = z.enum(['background', 'full']);
export type ComputerMode = z.infer<typeof ComputerMode>;

/** The person's computer use settings, kept by the desktop app (`userData/computer-use.json`). */
export const ComputerSettings = z.object({
  enabled: z.boolean().default(false),
  mode: ComputerMode.default('background'),
  /** Apps hidden while it had full control are shown again when it lets go. */
  unhideOnFinish: z.boolean().default(true),
  /** Apps it may never use: asking for them is turned down without a question. */
  denied: z.array(ComputerApp).max(500).default([]),
  /** Apps allowed for good ("Always allow on this computer"), per backend: `local`, or a server's URL. */
  always: z.record(z.string().max(2048), z.array(AppGrant).max(500)).default({}),
});
export type ComputerSettings = z.infer<typeof ComputerSettings>;

/** What this computer can do and has been allowed, for Settings and the cards. */
export const ComputerStatus = z.object({
  /** Computer use is possible here at all (a helper for this OS exists). */
  available: z.boolean(),
  platform: z.enum(['darwin', 'win32', 'linux']),
  /** The OS permissions it needs, where the OS asks for them (macOS). */
  permissions: z.object({ accessibility: z.boolean(), screenRecording: z.boolean() }),
  /** Background mode exists on this computer. */
  background: z.boolean(),
  settings: ComputerSettings,
  /** The session that has the screen right now, if any. */
  control: z.object({ sessionId: z.string(), paused: z.boolean() }).nullable(),
});
export type ComputerStatus = z.infer<typeof ComputerStatus>;

// ---------------------------------------------------------------- helper protocol v1

export interface ComputerInitializeParams {
  protocolVersion: number;
  client: { name: string; version: string };
}

export interface ComputerInitializeResult {
  protocolVersion: number;
  helperVersion: string;
  platform: 'darwin' | 'win32' | 'linux';
  supports: {
    /** Acting on a window without taking the mouse or keyboard. */
    background: boolean;
    fullControl: boolean;
    /** Screenshots can leave out apps that weren't allowed (and Atelier itself). */
    filter: boolean;
  };
}

/** Both true where the OS doesn't ask (Windows, X11). */
export interface PermissionsStatus {
  accessibility: boolean;
  screenRecording: boolean;
}

export interface PermissionsRequestParams {
  kind: 'accessibility' | 'screenRecording';
}

/** A rectangle in global screen coordinates: points on macOS, the top-left of the main display at 0,0. */
export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface HelperDisplay extends ScreenRect {
  id: string;
  name: string;
  /** Pixels per point. */
  scale: number;
  primary: boolean;
}

export interface HelperApp {
  /** The bundle id on macOS. */
  id: string;
  name: string;
  path: string | null;
  pid: number | null;
  running: boolean;
  /** It is the frontmost app. */
  active: boolean;
  hidden: boolean;
  /** The app's own category where it declares one (`LSApplicationCategoryType`). */
  category: string | null;
}

export interface AppsListParams {
  /** Installed apps too (the standard application folders), not only running ones. */
  installed: boolean;
}

export interface AppsOpenParams {
  id: string;
  /** Bring it to the front (full control), or open it without taking the focus. */
  activate: boolean;
}

export interface AppsHideParams {
  ids: string[];
}

/** `ids`: the apps this call hid (not those already hidden), for `apps.unhide` afterwards. */
export interface AppsHideResult {
  ids: string[];
}

export interface CaptureDisplayParams {
  display: string;
  /** Only these apps' windows (and the desktop); absent: everything but Atelier's own windows. */
  apps?: string[];
  /** Everything but these apps' windows, Atelier's own included (never its overlay); when `apps` is absent. */
  exclude?: string[];
  /** Part of the display, in global points; the whole display when absent. */
  region?: ScreenRect;
  /** The image is scaled down to fit these, keeping its aspect ratio. */
  maxWidth: number;
  maxHeight: number;
  format: 'jpeg' | 'png';
  /** JPEG quality, 0–1. */
  quality?: number;
}

export interface CaptureResult {
  /** Base64. */
  data: string;
  mime: 'image/jpeg' | 'image/png';
  /** The image's size in pixels. */
  width: number;
  height: number;
  /** What the image covers, in global points. */
  rect: ScreenRect;
}

export interface InspectPointParams {
  x: number;
  y: number;
}

/** What is under a point: the app, and the element where the OS tells (a password field, a link). */
export interface InspectPointResult {
  app: HelperApp | null;
  role: string | null;
  title: string | null;
  /** A password field (macOS `AXSecureTextField`). */
  secure: boolean;
  /** A link's address ('' for a link without one), or null. */
  link: string | null;
}

export type MouseButton = 'left' | 'right' | 'middle';

export interface Point {
  x: number;
  y: number;
}

export interface MouseClickParams extends Point {
  button: MouseButton;
  /** 1, 2 or 3 clicks. */
  count: number;
  /** Held during the click: `cmd`, `shift`, `alt`, `ctrl`. */
  modifiers: string[];
}

export interface MouseButtonParams extends Point {
  button: MouseButton;
}

export interface MouseDragParams {
  from: Point;
  to: Point;
  button: MouseButton;
}

/** Lines to scroll: positive `dy` scrolls down, positive `dx` right. */
export interface MouseScrollParams extends Point {
  dx: number;
  dy: number;
}

/** Keys pressed together, modifiers first, then one key: `['cmd', 'shift', 't']`, `['return']`, `['f5']`. */
export interface KeyPressParams {
  keys: string[];
  repeat?: number;
}

export interface KeyTypeParams {
  text: string;
}

export interface KeyHoldParams {
  keys: string[];
  /** At most 10 000. */
  ms: number;
}

/**
 * Notifications from the helper while it has control (`control.begin` … `control.end`). `control.esc`: the person
 * pressed Esc (`down`), let go early (`up`), or held it a second (`stopped`: input is refused until `control.resume`).
 * `control.userInput`: the person used the mouse or keyboard themselves. `control.secureInput`: a password field
 * anywhere turned secure input on (the Esc watch can't see keys then).
 */
export type ComputerNotification =
  | { method: 'control.esc'; params: { phase: 'down' | 'up' | 'stopped'; heldMs: number } }
  | { method: 'control.userInput'; params: { kind: 'mouse' | 'key' } }
  | { method: 'control.secureInput'; params: { on: boolean } };

/** Every method of computer protocol v1, with its params and result. */
export interface ComputerMethods {
  initialize: { params: ComputerInitializeParams; result: ComputerInitializeResult };
  'permissions.status': { params: Record<string, never>; result: PermissionsStatus };
  'permissions.request': { params: PermissionsRequestParams; result: PermissionsStatus };
  'displays.list': { params: Record<string, never>; result: { displays: HelperDisplay[] } };
  'apps.list': { params: AppsListParams; result: { apps: HelperApp[] } };
  'apps.frontmost': { params: Record<string, never>; result: { app: HelperApp | null } };
  'apps.open': { params: AppsOpenParams; result: { app: HelperApp } };
  'apps.hide': { params: AppsHideParams; result: AppsHideResult };
  'apps.unhide': { params: AppsHideParams; result: Record<string, never> };
  /** Makes a running app (by process: Atelier itself) the active one, through Accessibility where macOS ignores the ask. */
  'apps.activate': { params: { pid: number }; result: { activated: boolean } };
  'capture.display': { params: CaptureDisplayParams; result: CaptureResult };
  'inspect.point': { params: InspectPointParams; result: InspectPointResult };
  /** The element with the keyboard focus (where typing goes), in the frontmost app. */
  'inspect.focused': { params: Record<string, never>; result: InspectPointResult };
  'mouse.move': { params: Point; result: Record<string, never> };
  'mouse.click': { params: MouseClickParams; result: Record<string, never> };
  'mouse.down': { params: MouseButtonParams; result: Record<string, never> };
  'mouse.up': { params: MouseButtonParams; result: Record<string, never> };
  'mouse.drag': { params: MouseDragParams; result: Record<string, never> };
  'mouse.scroll': { params: MouseScrollParams; result: Record<string, never> };
  'cursor.position': { params: Record<string, never>; result: Point };
  'key.press': { params: KeyPressParams; result: Record<string, never> };
  'key.type': { params: KeyTypeParams; result: Record<string, never> };
  'key.hold': { params: KeyHoldParams; result: Record<string, never> };
  /** Releases every key and button this helper may have left down. */
  'input.releaseAll': { params: Record<string, never>; result: Record<string, never> };
  /** Starts watching the Esc hold and the person's own input; `control.end` stops it; `control.resume` lifts a stop. */
  'control.begin': { params: Record<string, never>; result: Record<string, never> };
  'control.end': { params: Record<string, never>; result: Record<string, never> };
  'control.resume': { params: Record<string, never>; result: Record<string, never> };
  shutdown: { params: Record<string, never>; result: Record<string, never> };
}

// ---------------------------------------------------------------- the controller, as backends ask it

/**
 * What a backend asks the desktop's computer use controller for one session (`backend` is `local` for the desktop's own
 * backend). The controller decides: apps the person didn't allow, tiers, password fields, mail links, full control only
 * after the person agreed on this computer. Coordinates are pixels of the session's latest screenshot.
 */
export const ComputerActionKind = z.enum([
  'left_click',
  'right_click',
  'middle_click',
  'double_click',
  'triple_click',
  'mouse_move',
  'left_click_drag',
  'scroll',
  'type',
  'key',
  'wait',
  'screenshot',
  'zoom',
  'cursor_position',
]);
export type ComputerActionKind = z.infer<typeof ComputerActionKind>;

const Coordinate = z.tuple([z.number().int().min(0).max(20_000), z.number().int().min(0).max(20_000)]);

export const ComputerActionItem = z.object({
  action: ComputerActionKind,
  coordinate: Coordinate.optional(),
  /** Where a drag starts (`coordinate` is where it ends). */
  start: Coordinate.optional(),
  text: z.string().max(10_000).optional(),
  direction: z.enum(['up', 'down', 'left', 'right']).optional(),
  /** Scroll lines, or how many times a key is pressed. */
  amount: z.number().int().min(1).max(200).optional(),
  /** Seconds, for `wait`. */
  duration: z.number().min(0).max(10).optional(),
  /** `zoom`: the part of the latest screenshot to show at full detail, `[x0, y0, x1, y1]`. */
  region: z.tuple([z.number().int().min(0), z.number().int().min(0), z.number().int().min(0), z.number().int().min(0)]).optional(),
  /** What the action does, in a few words, for the transcript and the person. */
  summary: z.string().max(200).optional(),
});
export type ComputerActionItem = z.infer<typeof ComputerActionItem>;

/** An app as an access request lists it: what it is, the tier it would get, and whether it may be allowed at all. */
export const PreparedApp = z.object({
  app: ComputerApp,
  category: AppCategory,
  /** The tier it gets unless the person picks another; null when it can never be allowed. */
  tier: AppTier.nullable(),
  maxTier: AppTier.nullable(),
  /** On the person's denied list. */
  denied: z.boolean(),
  /** Already allowed for this session or always, and at which tier. */
  granted: AppTier.nullable(),
});
export type PreparedApp = z.infer<typeof PreparedApp>;

export interface ComputerScreenshot {
  /** Base64. */
  data: string;
  mime: 'image/jpeg' | 'image/png';
  width: number;
  height: number;
}

export interface ComputerActionResult {
  action: ComputerActionKind;
  ok: boolean;
  /** Why it was refused or failed, or what came of it (`cursor_position`). */
  note?: string;
  screenshot?: ComputerScreenshot;
}

/** The size of screenshots for this model: hosted models get up to 1280 pixels, small local ones 1024. */
export interface ScreenshotSize {
  maxWidth: number;
  maxHeight: number;
}

export interface ControllerMethods {
  /** The apps an access request names, resolved on this computer. `unknown`: names no app here matches. */
  'access.prepare': { params: { names: string[] }; result: { apps: PreparedApp[]; unknown: string[] } };
  /** What the session may use now: the apps allowed one by one (none in Full control, where every app but the denied ones is). */
  'access.state': {
    params: Record<string, never>;
    result: {
      apps: AppGrant[];
      /** The computer's system, for the shortcuts the agent uses (cmd on macOS, ctrl on Windows). */
      platform: 'darwin' | 'win32' | 'linux';
      mode: ComputerMode;
      denied: string[];
      control: boolean;
      displays: { id: string; name: string; primary: boolean }[];
    };
  };
  'apps.list': { params: { query?: string }; result: { apps: { app: ComputerApp; category: AppCategory; running: boolean; granted: AppTier | null }[] } };
  'apps.open': { params: { id: string }; result: Record<string, never> };
  /** The display (only the allowed apps, never Atelier); with `region`, part of the latest screenshot at full detail. */
  screenshot: { params: { display?: string; size: ScreenshotSize }; result: ComputerScreenshot & { display: string; note?: string } };
  /** Takes the mouse and keyboard, once the person agreed on this computer (or always lets it). */
  'control.request': { params: Record<string, never>; result: { granted: boolean; reason?: string } };
  'control.batch': { params: { actions: ComputerActionItem[]; size: ScreenshotSize }; result: { results: ComputerActionResult[] } };
  'control.release': { params: Record<string, never>; result: Record<string, never> };
  /** The turn ended: control ends. */
  'turn.end': { params: Record<string, never>; result: Record<string, never> };
  /** The turn waits on the person: control ends, but for a permission card in Full control, where it stays. */
  'turn.wait': { params: { kind: 'permission' | 'question' | 'elicitation' }; result: Record<string, never> };
}

/** What the controller tells a backend about a session: the person held Esc. */
export type ControllerEvent = { type: 'stopped' };
