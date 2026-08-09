import React, { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ChevronLeft, ChevronRight } from 'lucide-react';

/**
 * Client-side pagination over an already-filtered row set (internal-tool
 * scale). Resets to page 1 whenever the row count changes (filter edits).
 */
export function usePagination<T>(rows: T[], pageSize = 25) {
  const [page, setPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));

  useEffect(() => { setPage(1); }, [rows.length]);

  const clamped = Math.min(page, pageCount);
  const pageRows = useMemo(
    () => rows.slice((clamped - 1) * pageSize, clamped * pageSize),
    [rows, clamped, pageSize]
  );

  return { pageRows, page: clamped, pageCount, setPage, total: rows.length, pageSize };
}

export function PaginationFooter({ page, pageCount, setPage, total, pageSize }: {
  page: number; pageCount: number; setPage: (p: number) => void; total: number; pageSize: number;
}) {
  if (total <= pageSize) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <div className="flex items-center justify-between px-4 py-2 border-t text-xs text-muted-foreground">
      <span>{from}–{to} of {total}</span>
      <div className="flex items-center gap-1">
        <Button size="icon" variant="ghost" className="h-7 w-7" disabled={page <= 1} onClick={() => setPage(page - 1)}>
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <span className="px-1">Page {page} / {pageCount}</span>
        <Button size="icon" variant="ghost" className="h-7 w-7" disabled={page >= pageCount} onClick={() => setPage(page + 1)}>
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
