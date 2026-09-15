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
  tooltip: string;
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

  return (
    <TooltipProvider delayDuration={350}>
      <Tooltip>
        <ContextMenu open={isContextMenuOpen} onOpenChange={setIsContextMenuOpen}>
          <TooltipTrigger asChild>
            <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
          </TooltipTrigger>
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
        <TooltipContent
          collisionPadding={8}
          side="left"
          sideOffset={8}
          className="status-tiles__tooltip whitespace-nowrap"
        >
          {tooltip}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
