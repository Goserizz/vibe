import { useEffect, useState } from 'react';
import type { LucideIcon, LucideProps } from 'lucide-react';
import {
  AlertCircle as LucideAlertCircle,
  ArrowLeft as LucideArrowLeft,
  ArrowLeftRight as LucideArrowLeftRight,
  ArrowUp as LucideArrowUp,
  ArrowUpCircle as LucideArrowUpCircle,
  Ban as LucideBan,
  Bookmark as LucideBookmark,
  BookmarkPlus as LucideBookmarkPlus,
  BookMarked as LucideBookMarked,
  Brain as LucideBrain,
  Check as LucideCheck,
  CheckCheck as LucideCheckCheck,
  CheckCircle2 as LucideCheckCircle2,
  CheckSquare as LucideCheckSquare,
  ChevronDown as LucideChevronDown,
  ChevronRight as LucideChevronRight,
  Circle as LucideCircle,
  CircleAlert as LucideCircleAlert,
  CirclePause as LucideCirclePause,
  CircleStop as LucideCircleStop,
  ClipboardList as LucideClipboardList,
  Contrast as LucideContrast,
  Clock as LucideClock,
  Copy as LucideCopy,
  Cpu as LucideCpu,
  Download as LucideDownload,
  Eye as LucideEye,
  ExternalLink as LucideExternalLink,
  FileCog as LucideFileCog,
  FilePen as LucideFilePen,
  FileText as LucideFileText,
  Folder as LucideFolder,
  FolderGit2 as LucideFolderGit2,
  FolderOpen as LucideFolderOpen,
  Gauge as LucideGauge,
  Globe as LucideGlobe,
  HelpCircle as LucideHelpCircle,
  KeyRound as LucideKeyRound,
  Image as LucideImage,
  ListTodo as LucideListTodo,
  Loader2 as LucideLoader2,
  LogIn as LucideLogIn,
  LogOut as LucideLogOut,
  Menu as LucideMenu,
  MessageSquareText as LucideMessageSquareText,
  Monitor as LucideMonitor,
  OctagonX as LucideOctagonX,
  Package as LucidePackage,
  Palette as LucidePalette,
  Paperclip as LucidePaperclip,
  Pencil as LucidePencil,
  Play as LucidePlay,
  Plug as LucidePlug,
  Plus as LucidePlus,
  RefreshCw as LucideRefreshCw,
  RotateCcw as LucideRotateCcw,
  Save as LucideSave,
  Search as LucideSearch,
  Server as LucideServer,
  Settings as LucideSettings,
  ShieldCheck as LucideShieldCheck,
  ShieldQuestion as LucideShieldQuestion,
  Sparkles as LucideSparkles,
  Square as LucideSquare,
  SquareTerminal as LucideSquareTerminal,
  Star as LucideStar,
  Terminal as LucideTerminal,
  TerminalSquare as LucideTerminalSquare,
  Trash2 as LucideTrash2,
  TriangleAlert as LucideTriangleAlert,
  Upload as LucideUpload,
  Users as LucideUsers,
  Volume2 as LucideVolume2,
  Wrench as LucideWrench,
  X as LucideX,
} from 'lucide-react';
import { useStore } from '../store/store';
import { cn } from './format';

/** One-cell terminal marks. Chat mode still uses Lucide. */
const GLYPHS: Record<string, string | ((props: LucideProps) => string)> = {
  AlertCircle: '!',
  ArrowLeft: '<',
  ArrowLeftRight: '↔',
  ArrowUp: '^',
  ArrowUpCircle: '^',
  Ban: '×',
  Bookmark: '*',
  BookmarkPlus: '+',
  BookMarked: '*',
  Brain: 'λ',
  Check: '✓',
  CheckCheck: '✓',
  CheckCircle2: '✓',
  CheckSquare: '☒',
  ChevronDown: 'v',
  ChevronRight: '>',
  Circle: '○',
  CircleAlert: '!',
  CirclePause: '■',
  CircleStop: '■',
  ClipboardList: '≡',
  Clock: '·',
  Contrast: '◐',
  Copy: '"',
  Cpu: 'M',
  Download: 'v',
  Eye: 'o',
  FileCog: '*',
  FilePen: '~',
  FileText: '▤',
  Folder: '▸',
  FolderGit2: '▸',
  FolderOpen: 'F',
  Gauge: 'E',
  Globe: 'o',
  HelpCircle: '?',
  Image: '▦',
  ListTodo: '≡',
  Loader2: '+',
  LogIn: '→',
  LogOut: '→',
  Menu: '≡',
  MessageSquareText: '▸',
  Monitor: '▣',
  OctagonX: '×',
  Package: '#',
  Palette: '◈',
  Paperclip: '@',
  Pencil: '~',
  Play: '>',
  Plug: 'o',
  Plus: '+',
  RefreshCw: 'o',
  RotateCcw: 'o',
  Save: '=',
  Search: '/',
  Server: '#',
  Settings: '*',
  ShieldCheck: 'P',
  ShieldQuestion: '?',
  Sparkles: '*',
  Square: '■',
  SquareTerminal: 'T',
  Star: (p) => (p.fill && p.fill !== 'none' ? '★' : '☆'),
  Terminal: '$',
  TerminalSquare: '$',
  Trash2: '⌫',
  TriangleAlert: '!',
  Upload: '^',
  Users: '#',
  Volume2: '~',
  Wrench: '*',
  X: '×',
};

/** Classic CLI line spinner. A rotating glyph can't be centered on its own
 *  ink: the span pivots on its box center while the glyph sits in the line
 *  box offset by the font's ascent/descent, so it orbits as it turns. Frame
 *  cycling keeps every frame inside the same monospace cell — no transform,
 *  no wobble. */
const SPINNER_FRAMES = ['|', '/', '-', '\\'] as const;
const SPINNER_MS = 120;

function TuiSpinner({ className }: { className?: string }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const timer = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), SPINNER_MS);
    return () => clearInterval(timer);
  }, []);
  return (
    <span className={cn('tui-icon inline-flex shrink-0 select-none items-center justify-center', className)} aria-hidden>
      {SPINNER_FRAMES[frame]}
    </span>
  );
}

function wrap(name: string, Cmp: LucideIcon): LucideIcon {
  function TuiAwareIcon({ className, ...props }: LucideProps) {
    const cli = useStore((s) => s.viewMode) === 'cli';
    if (cli) {
      // animate-spin rotates the span box, never the glyph's true center —
      // swap it for the frame-cycled spinner (class stripped so the span
      // itself doesn't rotate too).
      if (typeof className === 'string' && /\banimate-spin\b/.test(className)) {
        return <TuiSpinner className={className.replace(/\banimate-spin\b/g, '')} />;
      }
      const spec = GLYPHS[name];
      const glyph = typeof spec === 'function' ? spec(props) : spec;
      return (
        <span className={cn('tui-icon inline-flex shrink-0 select-none items-center justify-center', className)} aria-hidden>
          {glyph}
        </span>
      );
    }
    return <Cmp className={className} {...props} />;
  }
  TuiAwareIcon.displayName = name;
  return TuiAwareIcon as LucideIcon;
}

export const AlertCircle = wrap('AlertCircle', LucideAlertCircle);
export const ArrowLeft = wrap('ArrowLeft', LucideArrowLeft);
export const ArrowLeftRight = wrap('ArrowLeftRight', LucideArrowLeftRight);
export const ArrowUp = wrap('ArrowUp', LucideArrowUp);
export const ArrowUpCircle = wrap('ArrowUpCircle', LucideArrowUpCircle);
export const Ban = wrap('Ban', LucideBan);
export const Bookmark = wrap('Bookmark', LucideBookmark);
export const BookmarkPlus = wrap('BookmarkPlus', LucideBookmarkPlus);
export const BookMarked = wrap('BookMarked', LucideBookMarked);
export const Brain = wrap('Brain', LucideBrain);
export const Check = wrap('Check', LucideCheck);
export const CheckCheck = wrap('CheckCheck', LucideCheckCheck);
export const CheckCircle2 = wrap('CheckCircle2', LucideCheckCircle2);
export const CheckSquare = wrap('CheckSquare', LucideCheckSquare);
export const ChevronDown = wrap('ChevronDown', LucideChevronDown);
export const ChevronRight = wrap('ChevronRight', LucideChevronRight);
export const Circle = wrap('Circle', LucideCircle);
export const CircleAlert = wrap('CircleAlert', LucideCircleAlert);
export const CirclePause = wrap('CirclePause', LucideCirclePause);
export const CircleStop = wrap('CircleStop', LucideCircleStop);
export const ClipboardList = wrap('ClipboardList', LucideClipboardList);
export const Contrast = wrap('Contrast', LucideContrast);
export const Clock = wrap('Clock', LucideClock);
export const Copy = wrap('Copy', LucideCopy);
export const Cpu = wrap('Cpu', LucideCpu);
export const Download = wrap('Download', LucideDownload);
export const Eye = wrap('Eye', LucideEye);
export const ExternalLink = wrap('ExternalLink', LucideExternalLink);
export const FileCog = wrap('FileCog', LucideFileCog);
export const FilePen = wrap('FilePen', LucideFilePen);
export const FileText = wrap('FileText', LucideFileText);
export const Folder = wrap('Folder', LucideFolder);
export const FolderGit2 = wrap('FolderGit2', LucideFolderGit2);
export const FolderOpen = wrap('FolderOpen', LucideFolderOpen);
export const Gauge = wrap('Gauge', LucideGauge);
export const Globe = wrap('Globe', LucideGlobe);
export const HelpCircle = wrap('HelpCircle', LucideHelpCircle);
export const Image = wrap('Image', LucideImage);
export const ListTodo = wrap('ListTodo', LucideListTodo);
export const KeyRound = wrap('KeyRound', LucideKeyRound);
export const Loader2 = wrap('Loader2', LucideLoader2);
export const LogIn = wrap('LogIn', LucideLogIn);
export const LogOut = wrap('LogOut', LucideLogOut);
export const Menu = wrap('Menu', LucideMenu);
export const MessageSquareText = wrap('MessageSquareText', LucideMessageSquareText);
export const Monitor = wrap('Monitor', LucideMonitor);
export const OctagonX = wrap('OctagonX', LucideOctagonX);
export const Package = wrap('Package', LucidePackage);
export const Palette = wrap('Palette', LucidePalette);
export const Paperclip = wrap('Paperclip', LucidePaperclip);
export const Pencil = wrap('Pencil', LucidePencil);
export const Play = wrap('Play', LucidePlay);
export const Plug = wrap('Plug', LucidePlug);
export const Plus = wrap('Plus', LucidePlus);
export const RefreshCw = wrap('RefreshCw', LucideRefreshCw);
export const RotateCcw = wrap('RotateCcw', LucideRotateCcw);
export const Save = wrap('Save', LucideSave);
export const Search = wrap('Search', LucideSearch);
export const Server = wrap('Server', LucideServer);
export const Settings = wrap('Settings', LucideSettings);
export const ShieldCheck = wrap('ShieldCheck', LucideShieldCheck);
export const ShieldQuestion = wrap('ShieldQuestion', LucideShieldQuestion);
export const Sparkles = wrap('Sparkles', LucideSparkles);
export const Square = wrap('Square', LucideSquare);
export const SquareTerminal = wrap('SquareTerminal', LucideSquareTerminal);
export const Star = wrap('Star', LucideStar);
export const Terminal = wrap('Terminal', LucideTerminal);
export const TerminalSquare = wrap('TerminalSquare', LucideTerminalSquare);
export const Trash2 = wrap('Trash2', LucideTrash2);
export const TriangleAlert = wrap('TriangleAlert', LucideTriangleAlert);
export const Upload = wrap('Upload', LucideUpload);
export const Users = wrap('Users', LucideUsers);
export const Volume2 = wrap('Volume2', LucideVolume2);
export const Wrench = wrap('Wrench', LucideWrench);
export const X = wrap('X', LucideX);
