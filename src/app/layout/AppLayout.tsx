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
  Settings,
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
  { label: 'Settings', href: '/settings', icon: Settings },
];

function AppSidebar() {
  const location = useLocation();
  // On phones the sidebar is a sheet overlay — picking a page must close it.
  const { setOpenMobile } = useSidebar();

  return (
    <Sidebar className="border-r border-border/60 bg-[#0f1117]" collapsible="icon">
      <SidebarHeader className="px-4 py-3 border-b border-white/10">
        <div className="flex items-center gap-2 text-white">
          <div className="w-7 h-7 rounded bg-violet-600 flex items-center justify-center">
            <Package className="w-4 h-4 text-white" />
          </div>
          <span className="font-semibold text-sm tracking-tight group-data-[collapsible=icon]:hidden">
            SND GB Ops
          </span>
        </div>
      </SidebarHeader>
      <SidebarContent className="bg-[#0f1117]">
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
  draft: 'bg-gray-100 text-gray-700',
  open: 'bg-green-100 text-green-800',
  closed: 'bg-amber-100 text-amber-800',
  ordering: 'bg-blue-100 text-blue-800',
  fulfillment: 'bg-violet-100 text-violet-800',
  complete: 'bg-gray-200 text-gray-600',
};

export function AppLayout({ children }: { children: React.ReactNode }) {
  const { groupBuys, groupBuy, groupBuyId, setGroupBuyId, userName } = useApp();
  return (
    <SidebarProvider defaultOpen={true}>
      <div className="flex h-screen w-full overflow-hidden bg-background">
        <AppSidebar />
        <div className="flex flex-1 flex-col min-w-0">
          <header className="flex items-center gap-3 border-b px-4 py-2 bg-background">
            <SidebarTrigger />
            <Separator orientation="vertical" className="h-5" />
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground hidden sm:inline">Campaign</span>
              <Select
                value={groupBuyId != null ? String(groupBuyId) : undefined}
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
        </div>
      </div>
    </SidebarProvider>
  );
}
