/**
 * The console's icon vocabulary. Every icon in the app comes from here, keyed
 * by what it means (an agent, a run, a goal…) rather than what it looks like,
 * so one concept always has one picture. Icons are decorative: the text next
 * to them carries the meaning, so they are hidden from screen readers.
 */
import {
  Activity, AlertCircle, AlertTriangle, Ban, BarChart3, Bell, BookOpen, Bot, Brain, Building2, Check, ChevronDown, ChevronLeft,
  ChevronRight, Circle, CircleCheck, CircleDashed, CircleDot, CircleDotDashed, CircleX, Clock, Coins, Copy, Cpu, Download, ExternalLink,
  Eye, File, FileArchive, FileAudio, FileCode, FileImage, FileJson, FileSpreadsheet, FileText, FileVideo, Files, Flame, Folder, Globe,
  Grid2x2, Hand, Hash, History, Inbox, Keyboard, KeyRound, Layers, LayoutDashboard, Link2, List, ListChecks, ListTodo, LoaderCircle,
  Lock, LogOut, Menu, MessageSquare, MessagesSquare, Monitor, Moon, Network, Paperclip, Pencil, Play, Plug, Plus, Power, Presentation,
  Radio, RefreshCw, ScrollText, Search, Send, Settings, ShieldCheck, SignalHigh, SignalLow, SignalMedium, Sparkles, Square, Sun,
  Target, Timer, Trash2, UserPlus, Users, Wallet, Webhook, Workflow, X, Zap,
  AlignLeft, Archive, CalendarDays, ClipboardCheck, Database, Gauge, HardDrive, IdCard, Mail, Package, PackageCheck, Receipt, Rocket,
  Pause, Filter, Server, Shield, SlidersHorizontal, Smartphone, Tag, TrendingUp, Upload, UserCheck, UserMinus, UserRound, Wrench,
} from 'lucide-react';
import type { ComponentType, SVGProps } from 'react';

type Svg = ComponentType<SVGProps<SVGSVGElement> & { size?: number | string; strokeWidth?: number | string; absoluteStrokeWidth?: boolean }>;

export const ICONS = {
  // Places
  overview: LayoutDashboard, issues: CircleDot, goals: Target, artifacts: Files, chart: Network, costs: Wallet, skills: Sparkles,
  connectors: Plug, activity: Activity, settings: Settings, approvals: ShieldCheck, org: Building2, newOrg: Building2,
  // Things
  agent: Bot, agents: Users, dept: Folder, run: Play, runs: History, chat: MessageSquare, conversation: MessagesSquare, task: ListTodo,
  tasks: ListChecks, memory: Brain, scorecard: BarChart3, browser: Globe, budget: Coins, tokens: Hash, model: Cpu, time: Clock,
  duration: Timer, steps: Layers, outcome: CircleCheck, provider: Cpu, playbook: Workflow, webhook: Webhook, key: KeyRound, lock: Lock,
  link: Link2, attachment: Paperclip, docs: BookOpen, log: ScrollText, live: Radio, notify: Bell, hand: Hand, project: Folder,
  description: AlignLeft, review: ClipboardCheck, archive: Archive, calendar: CalendarDays, database: Database, gauge: Gauge,
  disk: HardDrive, persona: IdCard, mail: Mail, catalog: Package, installed: PackageCheck, ledger: Receipt, launch: Rocket, server: Server,
  policy: Shield, tune: SlidersHorizontal, phone: Smartphone, label: Tag, trend: TrendingUp, upload: Upload, reports: UserCheck,
  user: UserRound, tool: Wrench, pause: Pause, filter: Filter, fire: UserMinus,
  // Actions
  play: Play, edit: Pencil, add: Plus, remove: Trash2, download: Download, external: ExternalLink, refresh: RefreshCw, stop: Square,
  send: Send, search: Search, copy: Copy, hire: UserPlus, check: Check, close: X, view: Eye, power: Power, signOut: LogOut,
  shortcuts: Keyboard, menu: Menu, grid: Grid2x2, list: List, spark: Zap,
  // Chrome
  down: ChevronDown, left: ChevronLeft, right: ChevronRight, empty: Inbox, error: AlertCircle, warn: AlertTriangle, spinner: LoaderCircle,
  // Themes
  light: Sun, dark: Moon, system: Monitor,
} satisfies Record<string, Svg>;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 16, className, strokeWidth = 1.75 }: { name: IconName; size?: number; className?: string; strokeWidth?: number }) {
  const C = ICONS[name];
  return <C size={size} strokeWidth={strokeWidth} className={`icon${className ? ` ${className}` : ''}`} aria-hidden="true" focusable="false" />;
}

/* ── Issue status and priority: shape and color both carry the meaning ── */

const STATUS_ICON: Record<string, Svg> = {
  backlog: CircleDashed, todo: Circle, in_progress: CircleDotDashed, in_review: Eye, done: CircleCheck, blocked: Ban, cancelled: CircleX,
};

/** The issue-status glyph (backlog ◌, todo ○, in progress ◔, review, done ✓, blocked, cancelled). */
export function StatusIcon({ status, size = 15 }: { status: string; size?: number }) {
  const C = STATUS_ICON[status] ?? Circle;
  return <C size={size} strokeWidth={2} className={`icon status-icon si-${status}`} aria-hidden="true" focusable="false" />;
}

const PRIORITY_ICON: Svg[] = [Flame, SignalHigh, SignalMedium, SignalLow];

/** Priority 0 urgent (flame) · 1 high · 2 normal · 3 low (signal bars). */
export function PriorityIcon({ priority, size = 15 }: { priority: number; size?: number }) {
  const C = PRIORITY_ICON[priority] ?? SignalMedium;
  return <C size={size} strokeWidth={2} className={`icon priority-icon pi-${priority}`} aria-hidden="true" focusable="false" />;
}

/* ── Files ── */

const FILE_ICON: Record<string, Svg> = {
  image: FileImage, pdf: FileText, html: FileCode, audio: FileAudio, video: FileVideo, markdown: FileText, csv: FileSpreadsheet,
  json: FileJson, text: FileCode, docx: FileText, xlsx: FileSpreadsheet, pptx: Presentation, zip: FileArchive, none: File,
};

export function FileIcon({ kind, size = 16 }: { kind: string; size?: number }) {
  const C = FILE_ICON[kind] ?? File;
  return <C size={size} strokeWidth={1.75} className={`icon file-icon type-${kind}`} aria-hidden="true" focusable="false" />;
}

/* ── Activity: an icon per kind of audit action ── */

const ACTIVITY_ICON: Array<[RegExp, IconName]> = [
  [/^tool\./, 'spark'], [/^comment\./, 'chat'], [/^artifact\./, 'attachment'], [/^issue\.(created)/, 'add'], [/^issue\./, 'issues'],
  [/^run\./, 'run'], [/^approval\./, 'approvals'], [/^(agent\.hired|hire)/, 'hire'], [/^agent\./, 'agent'], [/^budget\./, 'budget'],
  [/^skill\./, 'skills'], [/^memory\./, 'memory'], [/^(connector|grant)\./, 'connectors'], [/^goal\./, 'goals'], [/^browser\./, 'browser'],
  [/^(config|org|settings)\./, 'settings'], [/^dept\./, 'dept'], [/^(token|secret|login)\./, 'key'], [/^kill/, 'power'], [/^playbook\./, 'playbook'], [/^webhook\./, 'webhook'], [/^chat\./, 'chat'],
];

export const activityIcon = (action: string): IconName => ACTIVITY_ICON.find(([re]) => re.test(action))?.[1] ?? 'activity';
