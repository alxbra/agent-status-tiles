import type { ReactElement } from 'react';

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '../components/ui/context-menu';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../components/ui/tooltip';

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
  return (
    <TooltipProvider delayDuration={350}>
      <Tooltip>
        <ContextMenu>
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
        <TooltipContent side="left" sideOffset={8} className="whitespace-nowrap">
          {tooltip}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
