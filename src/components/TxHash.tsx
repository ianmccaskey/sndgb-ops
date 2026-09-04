import React, { useState } from 'react';
import { txExplorerUrl, shortHash } from '@/lib/explorer';
import { Copy, Check, ExternalLink } from 'lucide-react';

/**
 * A transaction hash rendered for lookup, not just display: a compact
 * middle-truncated hash that links to the correct block explorer (when the
 * rail has one), plus a copy button that copies the FULL hash. Replaces the
 * old truncate-with-tooltip that couldn't be clicked or copied.
 */
export function TxHash({ method, hash }: { method: string | null | undefined; hash: string | null | undefined }) {
  const [copied, setCopied] = useState(false);
  const h = (hash || '').trim();
  if (!h) return <span className="text-muted-foreground">—</span>;

  const url = txExplorerUrl(method, h);
  const label = shortHash(h);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(h);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be blocked inside an embedded frame; select-and-copy still works.
      setCopied(false);
    }
  };

  return (
    <span className="inline-flex items-center gap-1 font-mono text-xs">
      {url ? (
        <a href={url} target="_blank" rel="noreferrer" className="text-cyan-300 hover:underline inline-flex items-center gap-0.5" title={h}>
          {label}<ExternalLink className="w-3 h-3" />
        </a>
      ) : (
        <span title={h}>{label}</span>
      )}
      <button type="button" onClick={copy} title="Copy full hash" className="text-muted-foreground hover:text-foreground">
        {copied ? <Check className="w-3 h-3 text-emerald-300" /> : <Copy className="w-3 h-3" />}
      </button>
    </span>
  );
}
