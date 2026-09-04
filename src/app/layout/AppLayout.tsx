import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  Home,
  ShoppingCart,
  ClipboardPaste,
  Scale,
  Store,
  Package,
  Truck,
  BarChart3,
  GitBranch,
  PackageOpen,
  Settings,
  MoreHorizontal,
} from 'lucide-react';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarHeader,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar';
import { Separator } from '@/components/ui/separator';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { useApp } from '@/app/AppContext';

type NavItem = {
  label: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
};

const NAV_ITEMS: NavItem[] = [
  { label: 'Dashboard', href: '/', icon: Home },
  { label: 'Orders', href: '/orders', icon: ShoppingCart },
  { label: 'Import', href: '/import', icon: ClipboardPaste },
  { label: 'Reconciliation', href: '/recon', icon: Scale },
  { label: 'Vendors', href: '/vendors', icon: Store },
  { label: 'Products', href: '/products', icon: Package },
  { label: 'Fulfillment', href: '/fulfillment', icon: Truck },
  { label: 'Financials', href: '/financials', icon: BarChart3 },
  { label: 'Planner', href: '/planner', icon: GitBranch },
  { label: 'Receiving', href: '/receiving', icon: PackageOpen },
  { label: 'Settings', href: '/settings', icon: Settings },
];

function AppSidebar() {
  const location = useLocation();
  // On phones the sidebar is a sheet overlay — picking a page must close it.
  const { setOpenMobile } = useSidebar();

  return (
    <Sidebar className="border-r border-border/60 bg-[#0b111e]" collapsible="icon">
      <SidebarHeader className="px-4 py-3 border-b border-white/10">
        <div className="flex items-center gap-2 text-white">
          <div className="w-7 h-7 rounded bg-gradient-to-r from-cyan-400 to-indigo-400 flex items-center justify-center">
            <Package className="w-4 h-4 text-[#070b16]" />
          </div>
          <span className="font-semibold text-sm tracking-tight group-data-[collapsible=icon]:hidden">
            SND GB Ops
          </span>
        </div>
      </SidebarHeader>
      <SidebarContent className="bg-[#0b111e]">
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV_ITEMS.map((item) => {
                const isActive =
                  item.href === '/'
                    ? location.pathname === '/'
                    : location.pathname.startsWith(item.href);
                return (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton
                      asChild
                      isActive={isActive}
                      className="text-white/60 hover:text-white hover:bg-white/10 data-[active=true]:bg-white/10 data-[active=true]:text-white h-8 text-sm"
                    >
                      <Link to={item.href} onClick={() => setOpenMobile(false)}>
                        <item.icon className="w-4 h-4" />
                        <span>{item.label}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}

const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-slate-400/10 text-slate-300',
  open: 'bg-emerald-400/10 text-emerald-300',
  closed: 'bg-amber-400/10 text-amber-300',
  ordering: 'bg-blue-400/10 text-blue-300',
  fulfillment: 'bg-violet-400/10 text-violet-300',
  complete: 'bg-slate-400/10 text-slate-400',
};

// mobile bottom tab bar — the audit's biggest structural gap: every page was
// two taps behind a hamburger. The four daily surfaces are one thumb-tap;
// "More" opens the sidebar sheet for the rest. Hidden at md+ (sidebar rules).
const BOTTOM_NAV: NavItem[] = [
  { label: 'Home', href: '/', icon: Home },
  { label: 'Orders', href: '/orders', icon: ShoppingCart },
  { label: 'Fulfill', href: '/fulfillment', icon: Truck },
  { label: 'Receive', href: '/receiving', icon: PackageOpen },
];

function BottomNav() {
  const location = useLocation();
  const { setOpenMobile } = useSidebar();
  return (
    <nav className="md:hidden flex items-stretch border-t bg-card px-2 pt-1.5 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
      {BOTTOM_NAV.map(item => {
        const isActive = item.href === '/' ? location.pathname === '/' : location.pathname.startsWith(item.href);
        return (
          <Link key={item.href} to={item.href}
            className={`flex-1 flex flex-col items-center gap-0.5 pt-1 min-h-11 ${isActive ? 'text-primary border-t-2 border-primary -mt-[7px] pt-[9px]' : 'text-muted-foreground'}`}>
            <item.icon className="w-5 h-5" />
            <span className={`text-[10px] ${isActive ? 'font-semibold' : 'font-medium'}`}>{item.label}</span>
          </Link>
        );
      })}
      <button className="flex-1 flex flex-col items-center gap-0.5 pt-1 min-h-11 text-muted-foreground" onClick={() => setOpenMobile(true)}>
        <MoreHorizontal className="w-5 h-5" />
        <span className="text-[10px] font-medium">More</span>
      </button>
    </nav>
  );
}

export function AppLayout({ children }: { children: React.ReactNode }) {
  const { groupBuys, groupBuy, groupBuyId, setGroupBuyId, userName } = useApp();
  return (
    <SidebarProvider defaultOpen={true}>
      {/* h-dvh, not h-screen: 100vh on mobile browsers includes the area
          behind the browser chrome, which overflow-hidden then makes
          permanently unreachable (audit #1) */}
      <div className="flex h-dvh w-full overflow-hidden bg-background">
        <AppSidebar />
        <div className="flex flex-1 flex-col min-w-0">
          <header className="relative overflow-hidden flex items-center gap-3 border-b px-4 py-2 bg-background">
            <div className="scanline" aria-hidden="true"></div>
            <SidebarTrigger />
            <Separator orientation="vertical" className="h-5" />
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground hidden sm:inline">Campaign</span>
              <Select
                value={groupBuyId != null ? String(groupBuyId) : ''}
                onValueChange={(v) => setGroupBuyId(Number(v))}
              >
                <SelectTrigger className="h-8 w-[150px] sm:w-[220px] text-sm">
                  <SelectValue placeholder="Select a group buy" />
                </SelectTrigger>
                <SelectContent>
                  {groupBuys.map(g => (
                    <SelectItem key={g.id} value={String(g.id)}>{g.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {groupBuy && (
                <Badge className={`${STATUS_COLORS[groupBuy.status] || ''} border-0`} variant="outline">
                  {groupBuy.status}
                </Badge>
              )}
            </div>
            <div className="ml-auto text-sm text-muted-foreground hidden sm:block">{userName}</div>
          </header>
          <main className="flex-1 overflow-y-auto">{children}</main>
          <BottomNav />
        </div>
      </div>
    </SidebarProvider>
  );
}
