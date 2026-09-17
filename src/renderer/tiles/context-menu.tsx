import { useEffect, useState, type ReactElement } from 'react';

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '../components/ui/context-menu';
import { DISMISS_TILE_PORTALS_EVENT } from './events';

interface TileContextMenuProps {
  children: ReactElement;
  canDismiss: boolean;
  onDismiss: () => void;
}

/** Composes only the generated shadcn primitives; tiles supply the behavior. */
export function TileContextMenu({
  children,
  canDismiss,
  onDismiss,
}: TileContextMenuProps): ReactElement {
  const [isContextMenuOpen, setIsContextMenuOpen] = useState(false);

  useEffect(() => {
    const dismiss = (): void => setIsContextMenuOpen(false);
    window.addEventListener(DISMISS_TILE_PORTALS_EVENT, dismiss);
    return () => window.removeEventListener(DISMISS_TILE_PORTALS_EVENT, dismiss);
  }, []);

  return (
    <ContextMenu open={isContextMenuOpen} onOpenChange={setIsContextMenuOpen}>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
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
}
