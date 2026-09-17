import { useEffect, useState, type ReactElement } from 'react';

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '../components/ui/context-menu';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../components/ui/tooltip';
import { DISMISS_TILE_PORTALS_EVENT } from './events';

interface TileContextMenuProps {
  children: ReactElement;
  canDismiss: boolean;
  onDismiss: () => void;
  /** Full title shown only when the tab label had to truncate it. */
  tooltip: string | null;
}

/** Composes only the generated shadcn primitives; tiles supply the behavior. */
export function TileContextMenu({
  children,
  canDismiss,
  onDismiss,
  tooltip,
}: TileContextMenuProps): ReactElement {
  const [isContextMenuOpen, setIsContextMenuOpen] = useState(false);

  useEffect(() => {
    const dismiss = (): void => setIsContextMenuOpen(false);
    window.addEventListener(DISMISS_TILE_PORTALS_EVENT, dismiss);
    return () => window.removeEventListener(DISMISS_TILE_PORTALS_EVENT, dismiss);
  }, []);

  const menu = (trigger: ReactElement): ReactElement => (
    <ContextMenu open={isContextMenuOpen} onOpenChange={setIsContextMenuOpen}>
      <ContextMenuTrigger asChild>{trigger}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          disabled={!canDismiss}
          onSelect={() => {
            if (canDismiss) onDismiss();
          }}
        >
          Dismiss error
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );

  if (tooltip === null) return menu(children);

  return (
    <TooltipProvider delayDuration={350}>
      <Tooltip>
        {menu(<TooltipTrigger asChild>{children}</TooltipTrigger>)}
        <TooltipContent
          collisionPadding={8}
          side="bottom"
          align="end"
          sideOffset={6}
          className="status-tiles__tooltip whitespace-nowrap"
        >
          {tooltip}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
